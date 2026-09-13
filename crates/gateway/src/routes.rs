//! HTTP surface: discovery, free quoting, and the x402-gated endpoint.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use mandate::{MandateGuard, MandateNode, MockResolver};
use meter::{
    InferResponse, QuoteRequest, QuoteResponse, Receipt, Refusal, ServiceManifest, Usage,
    count_tokens,
};
use serde::Deserialize;
use time::{Duration, OffsetDateTime};

use crate::env::Config;
use crate::hcs::{HcsMessage, ReceiptLog};
use crate::inference;
use crate::ledger::SpendLedger;
use crate::mandate_guard::{self, AnyResolver};
use crate::quotes::QuoteStore;

/// Shared state for every handler.
#[derive(Clone)]
pub struct AppState {
    /// Provider configuration.
    pub config: Arc<Config>,
    /// Issued quotes.
    pub quotes: Arc<QuoteStore>,
    /// Settlement receipts and mandate refusals, served by `GET /v1/receipts`
    /// and `GET /v1/refusals`.
    pub receipts: Arc<ReceiptLog>,
    /// HCS publisher, when enabled — the mandate guard sends refusals here so
    /// the topic records every decision, not just settlements.
    pub hcs: Option<tokio::sync::mpsc::UnboundedSender<HcsMessage>>,
    /// The mandate guard gating `/v1/infer`, when `MANDATE_MODE != off`.
    pub mandate: Option<Arc<MandateGuard<AnyResolver>>>,
    /// The mock resolver backing the guard, when `MANDATE_MODE = mock` —
    /// exposed so `/v1/mandate/seed` and `/v1/mandate/revoke` can drive a
    /// live demo without a deployed ENSv2 registry.
    pub mandate_mock: Option<Arc<MockResolver>>,
    /// Spending so far per mandate node, replayed from HCS.
    pub ledger: Arc<SpendLedger>,
}

pub(crate) fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

/// `GET /.well-known/x402` — how an agent discovers this provider.
pub async fn manifest(State(state): State<AppState>) -> Json<ServiceManifest> {
    let cfg = &state.config;
    Json(ServiceManifest {
        provider: cfg.provider.clone(),
        model: cfg.model.clone(),
        base_url: cfg.base_url.to_string(),
        quote_url: cfg.quote_url(),
        infer_url: cfg.infer_url(),
        network: cfg.network.clone(),
        pay_to: cfg.pay_to.clone(),
        asset: cfg.asset.clone(),
        pricing: cfg.pricing,
        facilitator: cfg.facilitator_url.clone(),
        receipts_topic: cfg.hcs.as_ref().map(|h| h.topic_id.clone()),
        x402_version: 2,
        category: cfg.category.clone(),
        description: cfg.description.clone(),
    })
}

/// `POST /v1/quote` — free, and the only place a price is decided.
///
/// Metering happens here: the prompt is tokenised and priced against the
/// published schedule. The resulting quote id is what makes the 402 on
/// `/v1/infer` specific to this prompt rather than a flat per-call fee.
pub async fn quote(State(state): State<AppState>, Json(body): Json<QuoteRequest>) -> Response {
    if body.prompt.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "prompt must not be empty");
    }
    let max_output_tokens = body.max_output_tokens.clamp(1, 4096);

    let cfg = &state.config;
    let input_tokens = count_tokens(&body.prompt);
    let amount = cfg.pricing.quote(input_tokens, max_output_tokens);
    let quote_id = uuid::Uuid::new_v4().to_string();

    state.quotes.insert(
        quote_id.clone(),
        body.prompt,
        max_output_tokens,
        amount,
    );

    Json(QuoteResponse {
        infer_url: format!("{}?quote={quote_id}", cfg.infer_url()),
        quote_id,
        provider: cfg.provider.clone(),
        model: cfg.model.clone(),
        input_tokens,
        max_output_tokens,
        amount,
        asset: cfg.asset.clone(),
        network: cfg.network.clone(),
        expires_in_secs: cfg.quote_ttl_secs,
    })
    .into_response()
}

/// Query string of the gated endpoint.
#[derive(Debug, Deserialize)]
pub struct InferQuery {
    /// Quote id issued by `POST /v1/quote`.
    pub quote: Option<String>,
    /// ENS subname of the agent spending against its mandate.
    pub agent: Option<String>,
}

/// `POST /v1/infer?quote=<id>` — runs only after x402 payment is verified.
///
/// The x402 layer has already priced, verified, and (in `authorization` flow)
/// is about to settle this request. Redeeming the quote here is what stops a
/// paid quote from being replayed, and what rejects requests the dynamic
/// pricer could not price.
pub async fn infer(State(state): State<AppState>, Query(query): Query<InferQuery>) -> Response {
    let Some(quote_id) = query.quote else {
        return error(StatusCode::BAD_REQUEST, "missing ?quote=<id>");
    };

    let quote = match state.quotes.redeem(&quote_id) {
        Ok(quote) => quote,
        Err(reason) => return error(StatusCode::BAD_REQUEST, reason.message()),
    };

    let cfg = &state.config;
    let completion = match inference::run(
        cfg.upstream.as_ref(),
        &cfg.model,
        &quote.prompt,
        quote.max_output_tokens,
    )
    .await
    {
        Ok(completion) => completion,
        Err(error_) => {
            tracing::error!(%error_, "inference failed");
            return error(StatusCode::BAD_GATEWAY, "model backend unavailable");
        }
    };

    state.quotes.record_usage(&quote_id, completion.usage);

    let unused = quote
        .max_output_tokens
        .saturating_sub(completion.usage.output_tokens)
        .saturating_mul(cfg.pricing.per_1k_output)
        / 1000;

    Json(InferResponse {
        quote_id,
        provider: cfg.provider.clone(),
        model: cfg.model.clone(),
        completion: completion.text,
        usage: Usage {
            input_tokens: completion.usage.input_tokens,
            output_tokens: completion.usage.output_tokens,
        },
        charged: quote.amount,
        unused_output_credit: unused,
    })
    .into_response()
}

/// `GET /v1/receipts` — the settlement audit trail this provider has written.
pub async fn receipts(State(state): State<AppState>) -> Json<Vec<Receipt>> {
    Json(state.receipts.snapshot())
}

/// `GET /v1/refusals` — payments the mandate guard blocked, newest last.
pub async fn refusals(State(state): State<AppState>) -> Json<Vec<Refusal>> {
    Json(state.receipts.refusals())
}

/// Body of `POST /v1/authorize`.
#[derive(Debug, Deserialize)]
pub struct AuthorizeRequest {
    /// ENS name of the agent that would spend.
    pub agent: String,
    /// Atomic units of the asset.
    pub amount: u64,
    /// Service category; defaults to what this provider sells.
    pub service: Option<String>,
    /// Asset symbol or token id; defaults to what this provider is paid in.
    pub asset: Option<String>,
}

/// `POST /v1/authorize` — runs the policy engine without paying, recording
/// or reserving anything. The same evaluation `/v1/infer` runs before it
/// names a price, so a simulation can't disagree with the real thing.
pub async fn authorize(State(state): State<AppState>, Json(body): Json<AuthorizeRequest>) -> Response {
    if state.mandate.is_none() {
        return error(StatusCode::NOT_FOUND, "this gateway runs without a mandate guard (MANDATE_MODE=off)");
    }
    let cfg = &state.config;
    let asset = body.asset.as_deref().map(|given| {
        // Accept a symbol or an id; anything unknown is compared as given.
        [&cfg.asset, &cfg.tree_asset]
            .into_iter()
            .find(|a| a.symbol.eq_ignore_ascii_case(given) || a.id.eq_ignore_ascii_case(given))
            .map_or_else(
                || mandate::AssetRef {
                    id: given.to_owned(),
                    symbol: given.to_uppercase(),
                },
                |a| mandate::AssetRef {
                    id: a.id.clone(),
                    symbol: a.symbol.clone(),
                },
            )
    });
    let service = body.service.map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty());
    let decision = mandate_guard::evaluate(&state, &body.agent, body.amount, service.clone(), asset.clone()).await;
    let spent = state.ledger.spent().await;
    let spent: std::collections::BTreeMap<_, _> = decision
        .path
        .iter()
        .map(|hop| (hop.name.clone(), spent.get(&hop.name).copied().unwrap_or(0)))
        .collect();
    Json(serde_json::json!({
        "approved": decision.approved(),
        "agent": body.agent,
        "amount": body.amount,
        "service": service.unwrap_or_else(|| cfg.category.clone()),
        "asset": asset.map_or_else(|| cfg.asset.symbol.clone(), |a| a.symbol),
        "reason": decision.violation.as_ref().map(ToString::to_string),
        "blocked_by": decision.violation.as_ref().map(|v| v.node.clone()),
        "violation": decision.violation.as_ref().map(|v| v.reason.kind()),
        "checks": decision.checks,
        "path": decision.path,
        "spent": spent,
        "ledger_error": state.ledger.error().await,
        "provider": cfg.provider,
    }))
    .into_response()
}

/// Body of `POST /v1/mandate/seed`.
#[derive(Debug, Deserialize)]
pub struct SeedMandateRequest {
    /// ENS subname this node governs.
    pub name: String,
    /// Spending budget, in atomic units.
    pub budget: u64,
    /// Services this node's subtree may spend against.
    #[serde(default)]
    pub allowed_services: Vec<String>,
    /// Rate limit, in atomic units per minute.
    #[serde(default)]
    pub rate_per_minute: u64,
    /// Ceiling on a single call; defaults to `budget` when zero/omitted.
    #[serde(default)]
    pub max_per_call: u64,
    /// Seconds from now until this node expires.
    pub expires_in_secs: i64,
    /// Parent subname, or omit/null to make this the root.
    pub parent: Option<String>,
}

/// `POST /v1/mandate/seed` — mock-mode only. Registers or replaces a node in
/// the demo mandate tree, since there's no live ENSv2 registry to register
/// against yet.
pub async fn mandate_seed(
    State(state): State<AppState>,
    Json(body): Json<SeedMandateRequest>,
) -> Response {
    let Some(mock) = &state.mandate_mock else {
        return error(
            StatusCode::NOT_FOUND,
            "mandate demo endpoints require MANDATE_MODE=mock",
        );
    };
    let Some(expires_at) =
        OffsetDateTime::now_utc().checked_add(Duration::seconds(body.expires_in_secs))
    else {
        return error(StatusCode::BAD_REQUEST, "expires_in_secs out of range");
    };
    let max_per_call = if body.max_per_call == 0 {
        body.budget
    } else {
        body.max_per_call
    };

    mock.set(
        body.name.clone(),
        MandateNode {
            budget: body.budget,
            allowed_services: body.allowed_services,
            allowed_assets: Vec::new(),
            rate_per_minute: body.rate_per_minute,
            max_per_call,
            expires_at,
            parent: body.parent,
        },
    );
    Json(serde_json::json!({ "seeded": body.name })).into_response()
}

/// Body of `POST /v1/mandate/revoke`.
#[derive(Debug, Deserialize)]
pub struct RevokeMandateRequest {
    /// ENS subname to revoke immediately.
    pub name: String,
}

/// `POST /v1/mandate/revoke` — mock-mode only. Expires a node right now, so
/// the very next `/v1/infer` call anywhere under it in the tree is blocked —
/// live, mid-payment if need be. This is the demo.
pub async fn mandate_revoke(
    State(state): State<AppState>,
    Json(body): Json<RevokeMandateRequest>,
) -> Response {
    let Some(mock) = &state.mandate_mock else {
        return error(
            StatusCode::NOT_FOUND,
            "mandate demo endpoints require MANDATE_MODE=mock",
        );
    };
    mock.revoke(&body.name);
    Json(serde_json::json!({ "revoked": body.name })).into_response()
}
