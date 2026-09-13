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
//! Endpoints:
//! - `GET  /v1/runner`    — payer, providers and the per-run ceiling.
//! - `GET  /v1/providers` — every provider's manifest (discovery).
//! - `POST /v1/run`       — `{ agent, prompt?, max_output_tokens?, budget_atomic? }`,
//!   answered with `text/event-stream`.
//!
//! It spends real money from the shared wallet, so it runs one request at a
//! time, caps every run at `RUNNER_MAX_ATOMIC`, and — when `RUNNER_TOKEN` is
//! set — only answers callers that send it as a bearer token.

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

struct Runner {
    wallet: Wallet,
    providers: Vec<String>,
    max_atomic: u64,
    max_output_tokens: u64,
    token: Option<String>,
    /// Held for the whole run; also remembers when the last one finished.
    busy: Arc<Mutex<Option<Instant>>>,
}

#[derive(Deserialize)]
struct RunRequest {
    agent: String,
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
        "max_atomic": runner.max_atomic,
        "max_output_tokens": runner.max_output_tokens,
        "requires_token": runner.token.is_some(),
    }))
}

async fn providers_route(State(runner): State<Arc<Runner>>) -> Json<Value> {
    let http = reqwest::Client::new();
    let mut found = Vec::new();
    for base in &runner.providers {
        let manifest = async {
            http.get(format!("{base}/.well-known/x402"))
                .timeout(Duration::from_secs(5))
                .send()
                .await?
                .error_for_status()?
                .json::<ServiceManifest>()
                .await
        }
        .await;
        found.push(match manifest {
            Ok(manifest) => json!({ "base_url": base, "manifest": manifest }),
            Err(error) => json!({ "base_url": base, "error": error.to_string() }),
        });
    }
    Json(json!({ "providers": found }))
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
        if let Err(error) = purchase(&task_runner, &agent, &prompt, max_output_tokens, budget, &emit).await {
            emit(json!({ "step": "error", "message": format!("{error:#}") }));
        }
        emit(json!({ "step": "done", "elapsed_ms": started.elapsed().as_millis() as u64 }));
        *guard = Some(Instant::now());
    });

    let stream = UnboundedReceiverStream::new(rx)
        .map(|value| Ok::<_, Infallible>(Event::default().event("step").data(value.to_string())));
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// One purchase, narrated through `emit`. Mirrors `bin/agent.rs`.
async fn purchase(
    runner: &Runner,
    agent: &str,
    prompt: &str,
    max_output_tokens: u64,
    budget: u64,
    emit: &impl Fn(Value),
) -> Result<()> {
    let client = Client::new(runner.wallet.clone());
    emit(json!({
        "step": "start",
        "agent": agent,
        "payer": runner.wallet.account_id.to_string(),
        "prompt": prompt,
        "budget_atomic": budget,
        "max_output_tokens": max_output_tokens,
    }));

    // 1. Discovery and pricing, every provider.
    let request = QuoteRequest {
        prompt: prompt.to_owned(),
        max_output_tokens,
    };
    let mut offers: Vec<Offer> = Vec::new();
    for base in &runner.providers {
        match client.quote(base, &request).await {
            Ok(offer) => {
                emit(json!({
                    "step": "quote",
                    "base_url": base,
                    "provider": offer.manifest.provider,
                    "model": offer.manifest.model,
                    "pricing": offer.manifest.pricing,
                    "input_tokens": offer.quote.input_tokens,
                    "max_output_tokens": offer.quote.max_output_tokens,
                    "amount": offer.quote.amount,
                    "asset": offer.quote.asset,
                    "network": offer.quote.network,
                    "pay_to": offer.manifest.pay_to,
                    "facilitator": offer.manifest.facilitator,
                }));
                offers.push(offer);
            }
            Err(error) => emit(json!({
                "step": "quote_failed",
                "base_url": base,
                "message": format!("{error:#}"),
            })),
        }
    }
    anyhow::ensure!(!offers.is_empty(), "no provider answered");

    // 2. Selection: the cheapest quote the budget covers.
    let cheapest = offers.iter().map(|o| o.quote.amount).min().unwrap_or(0);
    let Some(chosen) = offers
        .iter()
        .filter(|o| o.quote.amount <= budget)
        .min_by_key(|o| o.quote.amount)
    else {
        emit(json!({
            "step": "over_budget",
            "budget_atomic": budget,
            "cheapest": cheapest,
            "asset": offers[0].quote.asset,
        }));
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

    // 3. Ask without paying: the mandate guard answers first, then x402.
    match client.challenge(chosen, agent).await? {
        Challenge::MandateRejected { reason } => {
            emit(json!({ "step": "refused", "reason": reason }));
            return Ok(());
        }
        Challenge::PaymentRequired { requirements } => {
            emit(json!({ "step": "payment_required", "requirements": requirements }));
        }
    }

    // 4. Sign the transfer, let the facilitator settle it, get served.
    emit(json!({ "step": "paying", "payer": runner.wallet.account_id.to_string() }));
    match client.purchase(chosen, agent, budget).await? {
        PurchaseOutcome::MandateRejected { reason } => {
            emit(json!({ "step": "refused", "reason": reason }));
        }
        PurchaseOutcome::Approved { result, settlement } => {
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
        }
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
