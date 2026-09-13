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
//! - `GET|POST /v1/autopilot`, `POST /v1/autopilot/respond`,
//!   `POST /v1/autopilot/chaos` — three agents keeping a Compose stack
//!   alive; see `autopilot.rs`.
//!
//! It spends real money from the shared wallet, so it runs one request at a
//! time, caps every run at `RUNNER_MAX_ATOMIC`, and — when `RUNNER_TOKEN` is
//! set — only answers callers that send it as a bearer token.

use std::collections::BTreeMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::{Duration, Instant};

mod autopilot;

use agent::client::{Challenge, Client, Offer, PurchaseOutcome, Settlement, Wallet, hashscan_tx};
use anyhow::{Context, Result};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::prelude::{BASE64_STANDARD, Engine as _};
use common::models::{ModelPicker, model_unavailable};
use common::utils::get_from_env_unsafe;
use meter::{AssetInfo, ComputeOffer, InferResponse, JobSpec, OpsAction, QuoteRequest, ServiceManifest};
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
    /// Hugging Face token for the planner (turns a task into a job).
    /// Picks the planner model from Hugging Face's live catalog, when
    /// `HF_TOKEN` is set.
    planner: Option<Arc<ModelPicker>>,
    /// Held for the whole run; also remembers when the last one finished.
    busy: Arc<Mutex<Option<Instant>>>,
    /// The three agents keeping the ops stack alive, and what they've done.
    autopilot: autopilot::Config,
    pilot: Arc<std::sync::Mutex<autopilot::State>>,
}

#[derive(Deserialize)]
struct RunRequest {
    agent: String,
    service: Option<String>,
    /// Compute: an explicit job (or an `extend`). Planned from the prompt
    /// when missing.
    job: Option<JobSpec>,
    /// Only shop at this provider (base URL) — extensions must go back to
    /// the provider running the resource.
    provider: Option<String>,
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
        planner: get_from_env_unsafe::<String>("HF_TOKEN")
            .ok()
            .filter(|t| !t.trim().is_empty())
            .map(|token| {
                // Preferences, then any live model (`auto`): see common::models.
                let spec: String = get_from_env_unsafe("PLANNER_MODEL")
                    .unwrap_or_else(|_| "meta-llama/Llama-3.1-8B-Instruct,auto".into());
                Arc::new(ModelPicker::new("https://router.huggingface.co/v1", Some(token), &spec))
            }),
        token: get_from_env_unsafe::<String>("RUNNER_TOKEN")
            .ok()
            .filter(|t| !t.is_empty()),
        busy: Arc::new(Mutex::new(None)),
        autopilot: autopilot::Config::from_env(),
        pilot: Arc::new(std::sync::Mutex::new(autopilot::State::default())),
    });
    autopilot::spawn_watcher(Arc::clone(&runner));
    if let Some(planner) = runner.planner.clone() {
        tokio::spawn(async move {
            if let Err(error) = planner.resolve(&[]).await {
                tracing::warn!(%error, "no planner model answered; compute tasks use rules until one does");
            }
        });
    }

    let app = Router::new()
        .route("/v1/runner", get(info))
        .route("/v1/providers", get(providers_route))
        .route("/v1/run", post(run))
        .route("/v1/resources", get(resources_route))
        .route("/v1/resources/stop", post(stop_route))
        .route("/v1/autopilot", get(autopilot::state_route).post(autopilot::toggle_route))
        .route("/v1/autopilot/respond", post(autopilot::respond_route))
        .route("/v1/autopilot/chaos", post(autopilot::chaos_route))
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
        "planner": runner.planner.as_ref().map(|p| p.current()),
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

    let job = request.job;
    let only_provider = request.provider.map(|p| p.trim_end_matches('/').to_owned());
    let (tx, rx) = mpsc::unbounded_channel::<Value>();
    let task_runner = Arc::clone(&runner);
    tokio::spawn(async move {
        let started = Instant::now();
        let emit = |value: Value| {
            let _ = tx.send(value);
        };
        let order = Order {
            agent: &agent,
            service: &service,
            prompt: &prompt,
            max_output_tokens,
            budget,
            job,
            action: None,
            only_provider,
            await_audit: true,
        };
        if let Err(error) = purchase(&task_runner, order, &emit).await {
            emit(json!({ "step": "error", "message": format!("{error:#}") }));
        }
        emit(json!({ "step": "done", "elapsed_ms": started.elapsed().as_millis() as u64 }));
        *guard = Some(Instant::now());
    });

    let stream = UnboundedReceiverStream::new(rx)
        .map(|value| Ok::<_, Infallible>(Event::default().event("step").data(value.to_string())));
    Sse::new(stream).keep_alive(KeepAlive::default()).into_response()
}

/// Turns a task into a job the offer allows. Asks the planner model when a
/// Hugging Face token is set; falls back to simple rules otherwise or if the
/// model's answer doesn't fit the offer.
async fn plan_job(runner: &Runner, task: &str, offers: &[ComputeOffer]) -> (JobSpec, String, Option<String>) {
    let images: Vec<String> = offers.iter().flat_map(|o| o.images.clone()).collect();
    let max_minutes = offers.iter().map(|o| o.max_minutes).max().unwrap_or(10).max(1);

    if let Some(planner) = &runner.planner {
        match ask_planner(planner, task, &images, max_minutes).await {
            Ok((job, model)) if images.contains(&job.image) && (1..=max_minutes).contains(&job.minutes) => {
                return (job, model, None);
            }
            Ok((job, _)) => {
                let note = format!("the model proposed {} for {} min, outside the offer; used rules", job.image, job.minutes);
                return (rules_plan(task, &images, max_minutes), "rules".into(), Some(note));
            }
            Err(error) => {
                let note = format!("planner model unavailable ({error:#}); used rules");
                return (rules_plan(task, &images, max_minutes), "rules".into(), Some(note));
            }
        }
    }
    (rules_plan(task, &images, max_minutes), "rules".into(), None)
}

/// Asks the planner model for a job. If the model has been dropped
/// upstream, picks another and asks once more. Returns the job and the
/// model that planned it.
async fn ask_planner(planner: &ModelPicker, task: &str, images: &[String], max_minutes: u64) -> Result<(JobSpec, String)> {
    let system = format!(
        "You plan container jobs for an infrastructure agent. Reply with one JSON object and nothing else: \
         {{\"image\": string, \"command\": string, \"minutes\": integer}}. \
         image must be one of: {}. minutes between 1 and {max_minutes}. \
         command is a POSIX sh command for that image; use \"\" to run the image's default service (e.g. a Redis server). \
         Keep the process alive for the whole time if the task is a service; print useful output.",
        images.join(", ")
    );
    let ask = |model: String| {
        let system = system.clone();
        async move {
            let mut request = reqwest::Client::new()
                .post(format!("{}/chat/completions", planner.base_url()))
                .timeout(Duration::from_secs(25))
                .json(&json!({
                    "model": model,
                    "messages": [
                        { "role": "system", "content": system },
                        { "role": "user", "content": task },
                    ],
                    "max_tokens": 200,
                    "temperature": 0.2,
                }));
            if let Some(key) = planner.api_key() {
                request = request.bearer_auth(key);
            }
            let response = request.send().await?;
            let status = response.status();
            let body = response.text().await?;
            Ok::<_, anyhow::Error>((status, body))
        }
    };

    let mut model = planner.current();
    let (mut status, mut body) = ask(model.clone()).await?;
    if model_unavailable(status.as_u16(), &body) {
        model = planner.resolve(std::slice::from_ref(&model)).await?;
        (status, body) = ask(model.clone()).await?;
    }
    anyhow::ensure!(status.is_success(), "planner model answered {status}: {}", body.chars().take(160).collect::<String>());
    let response: Value = serde_json::from_str(&body).context("planner response wasn't JSON")?;
    let content = response["choices"][0]["message"]["content"].as_str().unwrap_or_default();
    let start = content.find('{').context("no JSON in the planner's answer")?;
    let end = content.rfind('}').context("no JSON in the planner's answer")?;
    let job: JobSpec = serde_json::from_str(&content[start..=end]).context("planner JSON didn't parse")?;
    Ok((JobSpec { extend: None, ..job }, model))
}

/// Keyword rules, for when there's no planner model.
fn rules_plan(task: &str, images: &[String], max_minutes: u64) -> JobSpec {
    let lower = task.to_lowercase();
    let pick = |needle: &str| images.iter().find(|i| i.contains(needle)).cloned();
    let (image, command) = if let Some(image) = lower.contains("redis").then(|| pick("redis")).flatten() {
        (image, String::new())
    } else if let Some(image) = lower.contains("python").then(|| pick("python")).flatten() {
        (image, "python -c \"import platform,time; print('python', platform.python_version(), 'ready'); time.sleep(10**6)\"".into())
    } else {
        let image = pick("alpine").or_else(|| images.first().cloned()).unwrap_or_default();
        (image, "echo \"job started on $(uname -m)\"; while true; do date; sleep 30; done".into())
    };
    let minutes = lower
        .split(|c: char| !c.is_ascii_digit())
        .find_map(|n| n.parse::<u64>().ok())
        .unwrap_or(5)
        .clamp(1, max_minutes);
    JobSpec { image, command, minutes, extend: None }
}

/// `GET /v1/resources` — every discovered compute provider's containers.
async fn resources_route(State(runner): State<Arc<Runner>>) -> Json<Value> {
    let http = reqwest::Client::new();
    let mut out = Vec::new();
    for d in discover(&runner).await {
        let Ok(manifest) = &d.manifest else { continue };
        if manifest.compute.is_none() {
            continue;
        }
        let listed: Value = match http.get(format!("{}/v1/resources", d.base_url)).timeout(Duration::from_secs(8)).send().await {
            Ok(r) => r.json().await.unwrap_or(Value::Null),
            Err(_) => Value::Null,
        };
        out.push(json!({ "base_url": d.base_url, "provider": manifest.provider, "resources": listed }));
    }
    Json(json!({ "providers": out }))
}

#[derive(Deserialize)]
struct StopRequest {
    base_url: String,
    id: String,
}

/// `POST /v1/resources/stop` — the owner's kill switch, forwarded to the
/// provider running it (only providers discovery knows about).
async fn stop_route(State(runner): State<Arc<Runner>>, headers: HeaderMap, Json(body): Json<StopRequest>) -> Response {
    if !authorized(&runner, &headers) {
        return refuse(StatusCode::UNAUTHORIZED, "missing or wrong runner token");
    }
    let base = body.base_url.trim_end_matches('/').to_owned();
    if !discover(&runner).await.iter().any(|d| d.base_url == base) {
        return refuse(StatusCode::BAD_REQUEST, "unknown provider");
    }
    if body.id.is_empty() || !body.id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return refuse(StatusCode::BAD_REQUEST, "bad resource id");
    }
    match reqwest::Client::new().post(format!("{base}/v1/resources/{}/stop", body.id)).send().await {
        Ok(r) => {
            let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (status, Json(r.json::<Value>().await.unwrap_or(Value::Null))).into_response()
        }
        Err(e) => refuse(StatusCode::BAD_GATEWAY, &e.to_string()),
    }
}

/// What one agent wants to buy.
struct Order<'a> {
    agent: &'a str,
    service: &'a str,
    prompt: &'a str,
    max_output_tokens: u64,
    budget: u64,
    /// Compute: the job (planned from the prompt when missing).
    job: Option<JobSpec>,
    /// Ops: the repair.
    action: Option<OpsAction>,
    /// Only shop at this provider (base URL).
    only_provider: Option<String>,
    /// Wait for the receipt on HCS before returning. Off when the caller
    /// has more to do and confirms the receipt in the background.
    await_audit: bool,
}

/// What a purchase paid for.
struct Bought {
    result: Box<InferResponse>,
    settlement: Option<Settlement>,
    /// Topic the receipt goes to.
    topic: Option<String>,
    amount: u64,
    asset: AssetInfo,
}

/// One purchase, narrated through `emit`: discover, quote, authorize, pay,
/// execute, audit. Mirrors `bin/agent.rs`, plus the policy check up front.
/// `None` when it stopped short of paying (no provider, over budget,
/// denied, refused, failed) — `emit` has said why.
async fn purchase(runner: &Runner, order: Order<'_>, emit: &impl Fn(Value)) -> Result<Option<Bought>> {
    let Order { agent, service, prompt, max_output_tokens, budget, job, action, only_provider, await_audit } = order;
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
        .filter(|d| only_provider.as_ref().is_none_or(|only| &d.base_url == only))
        .collect();
    if matching.is_empty() {
        emit(json!({ "step": "no_provider", "service": service }));
        return Ok(None);
    }

    // Compute sells jobs, not prompts: turn the task into one (image,
    // command, minutes), within what the providers offer. The planner only
    // proposes; Leash still decides whether it may be paid for.
    let offers_compute: Vec<ComputeOffer> = matching
        .iter()
        .filter_map(|d| d.manifest.as_ref().ok().and_then(|m| m.compute.clone()))
        .collect();
    let job = if offers_compute.is_empty() {
        None
    } else if let Some(job) = job.filter(|j| j.extend.is_some() || !j.image.is_empty()) {
        emit(json!({ "step": "planned", "job": job, "planner": "given" }));
        Some(job)
    } else {
        let (job, planner, note) = plan_job(runner, prompt, &offers_compute).await;
        emit(json!({ "step": "planned", "job": job, "planner": planner, "note": note }));
        Some(job)
    };

    // 2. Quote: price this prompt (or job) with each.
    let request = QuoteRequest {
        prompt: prompt.to_owned(),
        max_output_tokens,
        job,
        action,
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
        return Ok(None);
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
        return Ok(None);
    }

    // 3–5. Authorize, pay, execute: Leash's policy engine decides per
    //    provider, cheapest first, and the first approved quote is paid. If
    //    that provider then fails, nothing settled, so the next approved
    //    quote is tried.
    let mut first_denial: Option<Value> = None;
    let mut failed: usize = 0;
    let mut bought: Option<(&Offer, Box<InferResponse>, Option<Settlement>)> = None;
    for (index, offer) in affordable.iter().enumerate() {
        match authorize(offer, agent).await {
            Ok(decision) => {
                let approved = decision.get("approved").and_then(Value::as_bool).unwrap_or(false);
                emit(json!({
                    "step": "authorization",
                    "provider": offer.manifest.provider,
                    "quote_id": offer.quote.quote_id,
                    "decision": decision,
                }));
                if !approved {
                    first_denial.get_or_insert(decision);
                    continue;
                }
            }
            Err(error) => {
                emit(json!({
                    "step": "authorization_failed",
                    "provider": offer.manifest.provider,
                    "message": format!("{error:#}"),
                }));
                continue;
            }
        }
        emit(json!({
            "step": "selected",
            "provider": offer.manifest.provider,
            "amount": offer.quote.amount,
            "asset": offer.quote.asset,
            "passed_over": offers.len() - 1,
            "quote_id": offer.quote.quote_id,
        }));

        // The gated endpoint re-checks the mandate and names its price
        // (402), then the signed transfer settles through the facilitator.
        match client.challenge(offer, agent).await? {
            Challenge::MandateRejected { reason } => {
                emit(json!({ "step": "refused", "reason": reason }));
                return Ok(None);
            }
            Challenge::PaymentRequired { requirements } => {
                emit(json!({ "step": "payment_required", "requirements": requirements }));
            }
        }
        emit(json!({ "step": "paying", "payer": runner.wallet.account_id.to_string() }));
        let outcome = match client.purchase(offer, agent, budget).await {
            Ok(outcome) => outcome,
            Err(error) => {
                emit(json!({ "step": "payment_failed", "message": format!("{error:#}") }));
                return Ok(None);
            }
        };
        match outcome {
            PurchaseOutcome::MandateRejected { reason } => {
                emit(json!({ "step": "refused", "reason": reason }));
                return Ok(None);
            }
            PurchaseOutcome::ServiceFailed { reason } => {
                failed += 1;
                emit(json!({
                    "step": "service_failed",
                    "provider": offer.manifest.provider,
                    "reason": reason,
                    "trying_next": index + 1 < affordable.len(),
                }));
            }
            PurchaseOutcome::Approved { result, settlement } => {
                bought = Some((offer, result, settlement));
                break;
            }
        }
    }
    let Some((chosen, result, settlement)) = bought else {
        if failed == 0 {
            emit(json!({ "step": "denied", "decision": first_denial }));
        }
        return Ok(None);
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
        "resource": result.resource,
        "base_url": chosen.manifest.base_url.trim_end_matches('/'),
    }));

    // 6. Audit: the receipt reaching consensus on the topic.
    let topic = chosen.manifest.receipts_topic.clone().or_else(|| runner.topic_id.clone());
    if await_audit {
        audit(runner, topic.as_deref(), settlement.as_ref(), emit).await;
    }
    Ok(Some(Bought {
        result,
        settlement,
        topic,
        amount: chosen.quote.amount,
        asset: chosen.quote.asset.clone(),
    }))
}

/// Waits for a settlement's receipt on the topic and says how it went.
async fn audit(runner: &Runner, topic: Option<&str>, settlement: Option<&Settlement>, emit: &impl Fn(Value)) {
    match (topic, settlement) {
        (Some(topic), Some(s)) => match await_receipt(runner, topic, &s.transaction).await {
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
}

#[cfg(test)]
mod tests {
    use super::valid_agent_name;

    #[test]
    fn rules_pick_an_offered_image_and_a_bounded_runtime() {
        let images = vec!["alpine:3.20".to_owned(), "python:3.12-alpine".to_owned(), "redis:7-alpine".to_owned()];
        let job = super::rules_plan("Run a Redis cache for 12 minutes", &images, 30);
        assert_eq!((job.image.as_str(), job.command.as_str(), job.minutes), ("redis:7-alpine", "", 12));
        let job = super::rules_plan("start a python worker for 90 min", &images, 30);
        assert_eq!((job.image.as_str(), job.minutes), ("python:3.12-alpine", 30));
        assert_eq!(super::rules_plan("do something", &images, 30).image, "alpine:3.20");
    }

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
