//! Agent runner: the demo buyer behind an HTTP endpoint, so the dashboard can
//! start a real paid request and watch it happen step by step.
//!
//! It holds the shared agent wallet (the same `HEDERA_ACCOUNT_ID` /
//! `HEDERA_PRIVATE_KEY` as the `agent` binary) and runs the same flow:
//! discover every provider, price the prompt, pick the cheapest quote the
//! budget covers, ask the gated endpoint what it wants, then pay over x402.
//! Each step is streamed to the caller as a server-sent event.
//!
//! ```bash
//! cargo run -p agent --bin agent-runner
//! ```
//!
//! Providers are discovered from the HCS topic, where every gateway announces
//! itself on start, plus any listed in `PROVIDERS`. Before paying, the runner
//! asks each candidate's policy engine (`POST /v1/authorize`) whether the
//! agent may buy there, and only the cheapest authorized quote is paid.
//!
//! Endpoints:
//! - `GET  /v1/runner`    — payer, providers and the per-run ceiling.
//! - `GET  /v1/providers` — every discovered provider and its manifest.
//! - `POST /v1/run`       — `{ agent, service?, prompt?, max_output_tokens?, budget_atomic? }`,
//!   answered with `text/event-stream`.
//!
//! It spends real money from the shared wallet, so it runs one request at a
//! time, caps every run at `RUNNER_MAX_ATOMIC`, and — when `RUNNER_TOKEN` is
//! set — only answers callers that send it as a bearer token.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};

use agent::client::{Challenge, Client, Offer, PurchaseOutcome, Wallet, hashscan_tx};
use anyhow::{Context, Result};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::prelude::{BASE64_STANDARD, Engine as _};
use common::utils::get_from_env_unsafe;
use meter::{QuoteRequest, ServiceManifest};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::{Mutex, mpsc};
use tokio_stream::StreamExt as _;
use tokio_stream::wrappers::UnboundedReceiverStream;

/// Shortest gap between two runs, so a stuck button can't drain the wallet.
const MIN_GAP: Duration = Duration::from_secs(2);
const MAX_PROMPT_CHARS: usize = 2_000;
const DEFAULT_PROMPT: &str = "Explain Hedera's hashgraph consensus in three sentences.";
/// How long to wait for a settlement's receipt to reach consensus on HCS.
const AUDIT_WAIT: Duration = Duration::from_secs(30);

struct Runner {
    wallet: Wallet,
    /// Always shopped, on top of whatever the topic announces.
    providers: Vec<String>,
    mirror_url: String,
    /// Topic to discover providers on and confirm receipts against.
    topic_id: Option<String>,
    max_atomic: u64,
    max_output_tokens: u64,
    token: Option<String>,
    /// Held for the whole run; also remembers when the last one finished.
    busy: Arc<Mutex<Option<Instant>>>,
}

#[derive(Deserialize)]
struct RunRequest {
    agent: String,
    service: Option<String>,
    prompt: Option<String>,
    max_output_tokens: Option<u64>,
    budget_atomic: Option<u64>,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,agent_runner=debug".into()),
        )
        .init();

    let account_id: String = get_from_env_unsafe("HEDERA_ACCOUNT_ID").map_err(anyhow::Error::msg)?;
    let private_key: String =
        get_from_env_unsafe("HEDERA_PRIVATE_KEY").map_err(anyhow::Error::msg)?;
    let providers: String =
        get_from_env_unsafe("PROVIDERS").unwrap_or_else(|_| "http://localhost:4021".into());
    let port: u16 = get_from_env_unsafe("RUNNER_PORT").unwrap_or(4030);

    let runner = Arc::new(Runner {
        wallet: Wallet::new(&account_id, &private_key)?,
        providers: providers
            .split(',')
            .map(|s| s.trim().trim_end_matches('/').to_owned())
            .filter(|s| !s.is_empty())
            .collect(),
        mirror_url: get_from_env_unsafe::<String>("MIRROR_URL")
            .unwrap_or_else(|_| "https://testnet.mirrornode.hedera.com".into())
            .trim_end_matches('/')
            .to_owned(),
        topic_id: get_from_env_unsafe::<String>("HCS_TOPIC_ID").ok().filter(|t| !t.is_empty()),
        max_atomic: get_from_env_unsafe("RUNNER_MAX_ATOMIC").unwrap_or(10_000),
        max_output_tokens: get_from_env_unsafe("MAX_OUTPUT_TOKENS").unwrap_or(128),
        token: get_from_env_unsafe::<String>("RUNNER_TOKEN")
            .ok()
            .filter(|t| !t.is_empty()),
        busy: Arc::new(Mutex::new(None)),
    });

    let app = Router::new()
        .route("/v1/runner", get(info))
        .route("/v1/providers", get(providers_route))
        .route("/v1/run", post(run))
        .with_state(Arc::clone(&runner));

    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("binding {addr}"))?;
    tracing::info!(
        payer = %runner.wallet.account_id,
        providers = ?runner.providers,
        max_atomic = runner.max_atomic,
        token = runner.token.is_some(),
        "agent runner listening on http://{addr}"
    );
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

fn refuse(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn authorized(runner: &Runner, headers: &HeaderMap) -> bool {
    let Some(expected) = &runner.token else {
        return true;
    };
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|given| given == expected)
}

/// Dotted lowercase labels (`sub.agent.root`), nothing else.
fn valid_agent_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

async fn info(State(runner): State<Arc<Runner>>) -> Json<Value> {
    Json(json!({
        "payer": runner.wallet.account_id.to_string(),
        "providers": runner.providers,
        "topic": runner.topic_id,
        "max_atomic": runner.max_atomic,
        "max_output_tokens": runner.max_output_tokens,
        "requires_token": runner.token.is_some(),
    }))
}

async fn providers_route(State(runner): State<Arc<Runner>>) -> Json<Value> {
    let found = discover(&runner).await;
    Json(json!({ "providers": found.iter().map(Discovered::to_json).collect::<Vec<_>>() }))
}

/// One provider as discovery found it.
struct Discovered {
    base_url: String,
    /// `hcs` when it announced itself on the topic, `configured` when it's
    /// only in `PROVIDERS`.
    source: &'static str,
    manifest: Result<ServiceManifest, String>,
}

impl Discovered {
    fn to_json(&self) -> Value {
        match &self.manifest {
            Ok(manifest) => json!({ "base_url": self.base_url, "source": self.source, "manifest": manifest }),
            Err(error) => json!({ "base_url": self.base_url, "source": self.source, "error": error }),
        }
    }
}

#[derive(Deserialize)]
struct MirrorPage {
    messages: Vec<MirrorMessage>,
}

#[derive(Deserialize)]
struct MirrorMessage {
    sequence_number: u64,
    consensus_timestamp: String,
    message: String,
}

/// The newest `limit` messages on the topic, decoded, newest first.
async fn topic_messages(runner: &Runner, topic: &str, limit: u32) -> Result<Vec<(MirrorMessage, Value)>> {
    let url = format!(
        "{}/api/v1/topics/{topic}/messages?limit={limit}&order=desc",
        runner.mirror_url
    );
    let page: MirrorPage = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(6))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(page
        .messages
        .into_iter()
        .filter_map(|m| {
            let bytes = BASE64_STANDARD.decode(&m.message).ok()?;
            let value = serde_json::from_slice::<Value>(&bytes).ok()?;
            Some((m, value))
        })
        .collect())
}

/// Providers announced on the topic plus the configured ones, each with its
/// live manifest (or why it didn't answer).
async fn discover(runner: &Runner) -> Vec<Discovered> {
    let http = reqwest::Client::new();
    let fetch = |base: String| {
        let http = http.clone();
        async move {
            let manifest = async {
                http.get(format!("{base}/.well-known/x402"))
                    .timeout(Duration::from_secs(5))
                    .send()
                    .await?
                    .error_for_status()?
                    .json::<ServiceManifest>()
                    .await
            }
            .await
            .map_err(|e| e.to_string());
            (base, manifest)
        }
    };

    let mut found: BTreeMap<String, Discovered> = BTreeMap::new();
    for base in &runner.providers {
        let (base, manifest) = fetch(base.clone()).await;
        found.insert(base.clone(), Discovered { base_url: base, source: "configured", manifest });
    }

    // The registry topic: configured, or whatever the providers publish to.
    let topic = runner.topic_id.clone().or_else(|| {
        found
            .values()
            .find_map(|d| d.manifest.as_ref().ok().and_then(|m| m.receipts_topic.clone()))
    });
    if let Some(topic) = topic {
        match topic_messages(runner, &topic, 100).await {
            Ok(messages) => {
                for (_, value) in messages {
                    if value.get("kind").and_then(Value::as_str) != Some("leash.service.announce.v1") {
                        continue;
                    }
                    let Some(base) = value.get("base_url").and_then(Value::as_str) else {
                        continue;
                    };
                    let base = base.trim_end_matches('/').to_owned();
                    if let Some(known) = found.get_mut(&base) {
                        known.source = "hcs";
                    } else {
                        let (base, manifest) = fetch(base).await;
                        found.insert(base.clone(), Discovered { base_url: base, source: "hcs", manifest });
                    }
                }
            }
            Err(error) => tracing::warn!(%error, "could not read announcements from the topic"),
        }
    }
    found.into_values().collect()
}

/// Asks `offer`'s gateway whether `agent` may pay it. Dry run: nothing is
/// recorded or reserved.
async fn authorize(offer: &Offer, agent: &str) -> Result<Value> {
    let base = offer.manifest.base_url.trim_end_matches('/');
    let response = reqwest::Client::new()
        .post(format!("{base}/v1/authorize"))
        .timeout(Duration::from_secs(20))
        .json(&json!({ "agent": agent, "amount": offer.quote.amount }))
        .send()
        .await?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    anyhow::ensure!(status.is_success(), "authorize answered {status}: {body}");
    Ok(body)
}

/// Waits for the settlement's receipt to appear on the topic.
async fn await_receipt(runner: &Runner, topic: &str, transaction: &str) -> Option<(u64, String)> {
    let norm = |id: &str| id.replacen('@', "-", 1).replace('.', "-");
    let wanted = norm(transaction);
    let started = Instant::now();
    while started.elapsed() < AUDIT_WAIT {
        if let Ok(messages) = topic_messages(runner, topic, 25).await {
            for (message, value) in messages {
                if value
                    .get("transaction_id")
                    .and_then(Value::as_str)
                    .is_some_and(|tx| norm(tx) == wanted)
                {
                    return Some((message.sequence_number, message.consensus_timestamp));
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
    None
}

async fn run(
    State(runner): State<Arc<Runner>>,
    headers: HeaderMap,
    Json(request): Json<RunRequest>,
) -> Response {
    if !authorized(&runner, &headers) {
        return refuse(StatusCode::UNAUTHORIZED, "missing or wrong runner token");
    }
    let agent = request.agent.trim().to_owned();
    if !valid_agent_name(&agent) {
        return refuse(StatusCode::BAD_REQUEST, "agent must be an ENS name like sub.agent.root");
    }
    let service = request
        .service
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "inference".to_owned());
    let prompt = request
        .prompt
        .map(|p| p.trim().to_owned())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| DEFAULT_PROMPT.to_owned());
    if prompt.chars().count() > MAX_PROMPT_CHARS {
        return refuse(StatusCode::BAD_REQUEST, "prompt is longer than 2000 characters");
    }
    let budget = request
        .budget_atomic
        .unwrap_or(runner.max_atomic)
        .min(runner.max_atomic);
    let max_output_tokens = request
        .max_output_tokens
        .unwrap_or(runner.max_output_tokens)
        .clamp(1, 1_024);

    let Ok(mut guard) = Arc::clone(&runner.busy).try_lock_owned() else {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "another run is in progress");
    };
    if guard.is_some_and(|last| last.elapsed() < MIN_GAP) {
        return refuse(StatusCode::TOO_MANY_REQUESTS, "wait a moment between runs");
    }

    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let task_runner = Arc::clone(&runner);
    tokio::spawn(async move {
        let started = Instant::now();
        let emit = |value: Value| {
            let _ = tx.send(value);
        };
        if let Err(error) = purchase(&task_runner, &agent, &service, &prompt, max_output_tokens, budget, &emit).await {
            emit(json!({ "step": "error", "message": format!("{error:#}") }));
        }
        emit(json!({ "step": "done", "elapsed_ms": started.elapsed().as_millis() as u64 }));
        *guard = Some(Instant::now());
    });

    let stream = UnboundedReceiverStream::new(rx)
        .map(|value| Ok::<_, Infallible>(Event::default().event("step").data(value.to_string())));
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// One purchase, narrated through `emit`: discover, quote, authorize, pay,
/// execute, audit. Mirrors `bin/agent.rs`, plus the policy check up front.
async fn purchase(
    runner: &Runner,
    agent: &str,
    service: &str,
    prompt: &str,
    max_output_tokens: u64,
    budget: u64,
    emit: &impl Fn(Value),
) -> Result<()> {
    let client = Client::new(runner.wallet.clone());
    emit(json!({
        "step": "start",
        "agent": agent,
        "service": service,
        "payer": runner.wallet.account_id.to_string(),
        "prompt": prompt,
        "budget_atomic": budget,
        "max_output_tokens": max_output_tokens,
    }));

    // 1. Discover: every provider on the topic or in PROVIDERS, then only
    //    the ones selling this service.
    let found = discover(runner).await;
    emit(json!({
        "step": "discovered",
        "providers": found.iter().map(Discovered::to_json).collect::<Vec<_>>(),
    }));
    let matching: Vec<&Discovered> = found
        .iter()
        .filter(|d| d.manifest.as_ref().is_ok_and(|m| m.category.eq_ignore_ascii_case(service)))
        .collect();
    if matching.is_empty() {
        emit(json!({ "step": "no_provider", "service": service }));
        return Ok(());
    }

    // 2. Quote: price this prompt with each.
    let request = QuoteRequest {
        prompt: prompt.to_owned(),
        max_output_tokens,
    };
    let mut offers: Vec<Offer> = Vec::new();
    for provider in matching {
        match client.quote(&provider.base_url, &request).await {
            Ok(offer) => {
                emit(json!({
                    "step": "quote",
                    "base_url": provider.base_url,
                    "provider": offer.manifest.provider,
                    "model": offer.manifest.model,
                    "category": offer.manifest.category,
                    "pricing": offer.manifest.pricing,
                    "input_tokens": offer.quote.input_tokens,
                    "max_output_tokens": offer.quote.max_output_tokens,
                    "amount": offer.quote.amount,
                    "asset": offer.quote.asset,
                    "network": offer.quote.network,
                    "pay_to": offer.manifest.pay_to,
                    "facilitator": offer.manifest.facilitator,
                    "quote_id": offer.quote.quote_id,
                }));
                offers.push(offer);
            }
            Err(error) => emit(json!({
                "step": "quote_failed",
                "base_url": provider.base_url,
                "message": format!("{error:#}"),
            })),
        }
    }
    if offers.is_empty() {
        emit(json!({ "step": "no_provider", "service": service, "unavailable": true }));
        return Ok(());
    }
    offers.sort_by_key(|o| o.quote.amount);
    let cheapest = offers[0].quote.amount;
    let affordable: Vec<&Offer> = offers.iter().filter(|o| o.quote.amount <= budget).collect();
    if affordable.is_empty() {
        emit(json!({
            "step": "over_budget",
            "budget_atomic": budget,
            "cheapest": cheapest,
            "asset": offers[0].quote.asset,
        }));
        return Ok(());
    }

    // 3. Authorize: Leash's policy engine decides, per provider, cheapest
    //    first. The first approved quote is the one paid.
    let mut chosen: Option<&Offer> = None;
    let mut first_denial: Option<Value> = None;
    for offer in affordable {
        match authorize(offer, agent).await {
            Ok(decision) => {
                let approved = decision.get("approved").and_then(Value::as_bool).unwrap_or(false);
                emit(json!({
                    "step": "authorization",
                    "provider": offer.manifest.provider,
                    "quote_id": offer.quote.quote_id,
                    "decision": decision,
                }));
                if approved {
                    chosen = Some(offer);
                    break;
                }
                first_denial.get_or_insert(decision);
            }
            Err(error) => emit(json!({
                "step": "authorization_failed",
                "provider": offer.manifest.provider,
                "message": format!("{error:#}"),
            })),
        }
    }
    let Some(chosen) = chosen else {
        emit(json!({ "step": "denied", "decision": first_denial }));
        return Ok(());
    };
    emit(json!({
        "step": "selected",
        "provider": chosen.manifest.provider,
        "amount": chosen.quote.amount,
        "asset": chosen.quote.asset,
        "passed_over": offers.len() - 1,
        "quote_id": chosen.quote.quote_id,
    }));

    // 4. Pay: the gated endpoint re-checks the mandate and names its price
    //    (402), then the signed transfer settles through the facilitator.
    match client.challenge(chosen, agent).await? {
        Challenge::MandateRejected { reason } => {
            emit(json!({ "step": "refused", "reason": reason }));
            return Ok(());
        }
        Challenge::PaymentRequired { requirements } => {
            emit(json!({ "step": "payment_required", "requirements": requirements }));
        }
    }
    emit(json!({ "step": "paying", "payer": runner.wallet.account_id.to_string() }));
    let outcome = match client.purchase(chosen, agent, budget).await {
        Ok(outcome) => outcome,
        Err(error) => {
            emit(json!({ "step": "payment_failed", "message": format!("{error:#}") }));
            return Ok(());
        }
    };

    // 5. Execute and return the result.
    let (result, settlement) = match outcome {
        PurchaseOutcome::MandateRejected { reason } => {
            emit(json!({ "step": "refused", "reason": reason }));
            return Ok(());
        }
        PurchaseOutcome::Approved { result, settlement } => (result, settlement),
    };
    if let Some(s) = &settlement {
        emit(json!({
            "step": "settled",
            "transaction": s.transaction,
            "network": s.network,
            "payer": s.payer,
            "explorer": hashscan_tx(&s.network, &s.transaction),
        }));
    }
    emit(json!({
        "step": "result",
        "provider": result.provider,
        "model": result.model,
        "completion": result.completion,
        "usage": result.usage,
        "charged": result.charged,
        "unused_output_credit": result.unused_output_credit,
        "asset": chosen.quote.asset,
        "quote_id": result.quote_id,
    }));

    // 6. Audit: the receipt reaching consensus on the topic.
    let topic = chosen.manifest.receipts_topic.clone().or_else(|| runner.topic_id.clone());
    match (topic, settlement) {
        (Some(topic), Some(s)) => match await_receipt(runner, &topic, &s.transaction).await {
            Some((sequence, consensus)) => emit(json!({
                "step": "audited",
                "topic": topic,
                "sequence": sequence,
                "consensus_timestamp": consensus,
            })),
            None => emit(json!({ "step": "audit_pending", "topic": topic })),
        },
        _ => emit(json!({ "step": "audit_pending", "topic": Value::Null })),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::valid_agent_name;

    #[test]
    fn agent_names_are_dotted_lowercase_labels() {
        assert!(valid_agent_name("sub.agent.root"));
        assert!(valid_agent_name("gpu-2.root"));
        assert!(!valid_agent_name(""));
        assert!(!valid_agent_name("Sub.agent"));
        assert!(!valid_agent_name("a..b"));
        assert!(!valid_agent_name("a&b=c"));
    }
}
