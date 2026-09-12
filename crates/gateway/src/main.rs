//! An x402-gated, per-token metered inference service settling on Hedera.
//!
//! Request flow:
//!
//! ```text
//! POST /v1/quote            free      meter the prompt -> price -> quote id
//! POST /v1/infer?quote=id   402       PAYMENT-REQUIRED (exact, hedera:*)
//!                           pay       payer-signed TransferTransaction
//!                           200       verify -> run model -> settle -> receipt
//! ```

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::Router;
use axum::routing::{get, post};
use gateway::env::{Config, MandateMode};
use gateway::hcs::{self, ReceiptHook, ReceiptLog};
use gateway::mandate_guard::{self, AnyResolver};
use gateway::quotes::QuoteStore;
use gateway::routes::{self, AppState};
use r402_facilitator::FacilitatorClient;
use r402_hedera::HederaExact;
use r402_http::server::X402Middleware;
use r402_server::ResourceServer;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,gateway=debug".into()),
        )
        .init();

    let cfg = Arc::new(Config::from_env().map_err(|e| anyhow::anyhow!(e))?);
    let quotes = Arc::new(QuoteStore::new(cfg.quote_ttl_secs));
    let receipts = Arc::new(ReceiptLog::default());

    // The mandate guard: gates every `/v1/infer` call on the resolved ENS
    // ancestor chain before x402 ever prices it. `mock` (default) needs no
    // deployed registry — seed and revoke it live via `/v1/mandate/*`. `ens`
    // reads the real PermissionedRegistry on Sepolia. `off` disables the
    // guard entirely.
    let mandate_mode = MandateMode::from_env();
    let (mandate, mandate_mock) = match mandate_mode {
        MandateMode::Off => (None, None),
        MandateMode::Ens => {
            let resolver = mandate::from_env().map_err(|e| anyhow::anyhow!(e))?;
            let guard = mandate::MandateGuard::new(AnyResolver::Ens(resolver));
            (Some(Arc::new(guard)), None)
        }
        MandateMode::Mock => {
            let mock = Arc::new(mandate::MockResolver::new());
            let guard = mandate::MandateGuard::new(AnyResolver::Mock(Arc::clone(&mock)));
            (Some(Arc::new(guard)), Some(mock))
        }
    };
    tracing::info!(mode = ?mandate_mode, "mandate guard configured");

    let hcs_tx = match &cfg.hcs {
        Some(hcs_cfg) => {
            let tx = hcs::spawn_publisher(&cfg.network, hcs_cfg)?;
            tracing::info!(topic = %hcs_cfg.topic_id, "publishing settlement receipts to HCS");
            Some(tx)
        }
        None => {
            tracing::warn!(
                "HCS receipts disabled; set HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY and \
                 HCS_TOPIC_ID to enable the on-chain audit trail"
            );
            None
        }
    };

    // Resource server: remote facilitator + the Hedera exact scheme, with the
    // receipt hook observing every settlement.
    let facilitator = FacilitatorClient::try_from(cfg.facilitator_url.as_str())
        .context("FACILITATOR_URL is not a usable facilitator base URL")?;
    let resource_server = ResourceServer::new(Arc::new(facilitator))
        .with_scheme("hedera:*".parse()?, HederaExact)
        .with_hook(ReceiptHook::new(
            &cfg,
            Arc::clone(&quotes),
            Arc::clone(&receipts),
            hcs_tx,
        ));

    let x402 = X402Middleware::from_resource_server(resource_server)
        .with_base_url(cfg.base_url.clone());

    // Per-request pricing: the 402 charges whatever the quote in the URL was
    // metered at. An unknown or spent quote yields no price tag; the handler
    // then rejects the request outright (see `QuoteStore::redeem`).
    let price_cfg = Arc::clone(&cfg);
    let price_quotes = Arc::clone(&quotes);
    let paid_layer = x402
        .with_dynamic_price(move |_headers, uri, _base| {
            let cfg = Arc::clone(&price_cfg);
            let quotes = Arc::clone(&price_quotes);
            let query = uri.query().unwrap_or_default().to_owned();
            async move {
                let Some(id) = quote_id_from_query(&query) else {
                    return Vec::new();
                };
                let Some(amount) = quotes.price_of(&id) else {
                    return Vec::new();
                };
                vec![HederaExact::price_tag(
                    cfg.pay_to_address.clone(),
                    cfg.deployment().amount(amount),
                )]
            }
        })?
        .with_description("Metered LLM inference, priced per token".into());

    let state = AppState {
        config: Arc::clone(&cfg),
        quotes,
        receipts,
        mandate,
        mandate_mock,
    };

    // `.layer()` calls stack outermost-last, so the mandate guard — applied
    // last — runs before the x402 paid layer, matching the model: mandate
    // check first, payment second, handler third.
    let mut app = Router::new()
        .route("/.well-known/x402", get(routes::manifest))
        .route("/v1/quote", post(routes::quote))
        .route("/v1/receipts", get(routes::receipts))
        .route(
            "/v1/infer",
            post(routes::infer).layer(paid_layer).layer(
                axum::middleware::from_fn_with_state(state.clone(), mandate_guard::gate),
            ),
        );

    if state.mandate_mock.is_some() {
        app = app
            .route("/v1/mandate/seed", post(routes::mandate_seed))
            .route("/v1/mandate/revoke", post(routes::mandate_revoke));
    }

    let app = app.with_state(state);

    let addr = format!("0.0.0.0:{}", cfg.port);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("binding {addr}"))?;

    tracing::info!(
        provider = %cfg.provider,
        model = %cfg.model,
        network = %cfg.network,
        pay_to = %cfg.pay_to,
        facilitator = %cfg.facilitator_url,
        "listening on http://{addr}"
    );
    tracing::info!(
        "pricing: {} per 1k input, {} per 1k output, {} minimum",
        cfg.asset.format(cfg.pricing.per_1k_input),
        cfg.asset.format(cfg.pricing.per_1k_output),
        cfg.asset.format(cfg.pricing.minimum),
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .context("server error")
}

/// Extracts `quote=<id>` from a raw query string.
fn quote_id_from_query(query: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        pair.strip_prefix("quote=")
            .filter(|v| !v.is_empty())
            .map(ToOwned::to_owned)
    })
}

#[cfg(test)]
mod tests {
    use super::quote_id_from_query;

    #[test]
    fn reads_the_quote_id_from_a_query_string() {
        assert_eq!(quote_id_from_query("quote=abc"), Some("abc".to_owned()));
        assert_eq!(quote_id_from_query("x=1&quote=abc"), Some("abc".to_owned()));
        assert_eq!(quote_id_from_query("quote="), None);
        assert_eq!(quote_id_from_query(""), None);
    }
}
