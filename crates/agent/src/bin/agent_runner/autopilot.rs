//! Autopilot: three agents keep a Docker Compose stack alive, each acting
//! under its own ENS mandate.
//!
//! - **Detector** (`AUTOPILOT_DETECT_AGENT`, default `watcher`) reads the
//!   ops provider's free health endpoint every 2s. Watching costs nothing,
//!   so it needs no spending authority.
//! - **Diagnoser** (`AUTOPILOT_DIAGNOSE_AGENT`, default `sub.agent.root`)
//!   buys LLM inference over x402 to find the root cause from the evidence
//!   — container states, healthchecks, logs, the end-to-end probe — and
//!   picks the fewest repairs from the provider's menu.
//! - **Fixer** (`AUTOPILOT_FIX_AGENT`, default `agent.root`) buys those
//!   repairs from the ops provider over x402. Its policy has to allow
//!   `ops`; the diagnoser's shouldn't, so the agent that reasons can't act.
//!
//! The detector then confirms the stack is healthy. Every payment goes
//! through the policy engine and lands on HCS like any other. Autopilot
//! pauses itself after an incident it couldn't resolve, so a repair that
//! doesn't work can't keep spending.

use std::collections::VecDeque;
use std::sync::{Arc, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::State as AxumState;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use common::utils::get_from_env_unsafe;
use meter::{AssetInfo, InfraHealth, OpsAction, OpsOffer, ServiceManifest};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Bought, Order, Runner, audit, authorized, discover, purchase, refuse};

const WATCH_EVERY: Duration = Duration::from_secs(2);
/// Consecutive failed checks before an incident opens, so a blip isn't one.
const CONFIRM_CHECKS: u32 = 2;
/// Quiet time after an incident closes before autopilot opens another.
const COOLDOWN: Duration = Duration::from_secs(10);
const REDISCOVER: Duration = Duration::from_secs(60);
/// How long to keep looking when no ops provider was found.
const RETRY_DISCOVERY: Duration = Duration::from_secs(15);
const VERIFY_WAIT: Duration = Duration::from_secs(20);
const MAX_ACTIONS: usize = 3;
const HISTORY: usize = 10;

/// Who the three agents are.
pub(crate) struct Config {
    detect_agent: String,
    diagnose_agent: String,
    fix_agent: String,
    /// Ops provider base URL; discovered on the topic when unset.
    provider: Option<String>,
    enabled_at_start: bool,
}

impl Config {
    pub(crate) fn from_env() -> Self {
        let name = |key: &str, default: &str| {
            get_from_env_unsafe::<String>(key)
                .ok()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| default.to_owned())
        };
        Self {
            detect_agent: name("AUTOPILOT_DETECT_AGENT", "watcher"),
            diagnose_agent: name("AUTOPILOT_DIAGNOSE_AGENT", "sub.agent.root"),
            fix_agent: name("AUTOPILOT_FIX_AGENT", "agent.root"),
            provider: get_from_env_unsafe::<String>("OPS_PROVIDER")
                .ok()
                .map(|v| v.trim().trim_end_matches('/').to_owned())
                .filter(|v| !v.is_empty()),
            enabled_at_start: get_from_env_unsafe::<String>("AUTOPILOT").is_ok_and(|v| v == "1" || v == "true"),
        }
    }
}

#[derive(Clone)]
struct Provider {
    base_url: String,
    manifest: ServiceManifest,
    scenarios: Value,
    found: Instant,
}

/// What autopilot sees and has done.
#[derive(Default)]
pub(crate) struct State {
    enabled: bool,
    paused_reason: Option<String>,
    health: Option<InfraHealth>,
    health_error: Option<String>,
    provider: Option<Provider>,
    last_discovery: Option<Instant>,
    unhealthy_streak: u32,
    current: Option<Incident>,
    history: VecDeque<Incident>,
    last_closed: Option<Instant>,
}

/// One outage, from detection to recovery (or to why it wasn't fixed).
#[derive(Clone, Serialize)]
struct Incident {
    id: String,
    /// `autopilot` or `manual`.
    trigger: &'static str,
    opened_at: String,
    closed_at: Option<String>,
    /// `diagnosing`, `fixing`, `verifying`, then `resolved`, `blocked`
    /// (a policy or budget stopped a payment) or `failed`.
    status: &'static str,
    problems: Vec<String>,
    root_cause: Option<String>,
    /// Model that diagnosed it, or `runbook`.
    diagnosed_by: Option<String>,
    actions: Vec<OpsAction>,
    outcome: Option<String>,
    /// Atomic units paid across the incident.
    spent: u64,
    asset: Option<AssetInfo>,
    /// Detection to verified recovery.
    mttr_ms: Option<u64>,
    /// Every step of every agent, in order, each tagged with its `stage`
    /// (`detect`, `diagnose`, `fix`, `verify`) and `at_ms`.
    steps: Vec<Value>,
    #[serde(skip)]
    started: Option<Instant>,
}

fn lock(runner: &Runner) -> MutexGuard<'_, State> {
    runner.pilot.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Applies `f` to incident `id`, open or already closed (receipts can
/// reach HCS after an incident is over).
fn update(runner: &Runner, id: &str, f: impl FnOnce(&mut Incident)) {
    let mut st = lock(runner);
    if let Some(incident) = st.current.as_mut().filter(|i| i.id == id) {
        f(incident);
    } else if let Some(incident) = st.history.iter_mut().find(|i| i.id == id) {
        f(incident);
    }
}

fn push_step(runner: &Runner, id: &str, stage: &str, mut step: Value) {
    // Discovery lists every manifest; the incident only needs the count.
    if step["step"] == "discovered" {
        let count = step["providers"].as_array().map_or(0, Vec::len);
        step = json!({ "step": "discovered", "count": count });
    }
    update(runner, id, |incident| {
        step["stage"] = json!(stage);
        step["at_ms"] = json!(incident.started.map_or(0, |s| s.elapsed().as_millis() as u64));
        incident.steps.push(step);
    });
}

fn set_status(runner: &Runner, id: &str, status: &'static str) {
    update(runner, id, |i| i.status = status);
}

fn record_spend(runner: &Runner, id: &str, bought: &Bought) {
    let (amount, asset) = (bought.amount, bought.asset.clone());
    update(runner, id, |i| {
        i.spent += amount;
        i.asset.get_or_insert(asset);
    });
}

/// Confirms a payment's receipt on HCS in the background and adds the
/// result to the incident, so waiting for consensus doesn't slow the fix.
fn spawn_audit(runner: &Arc<Runner>, id: &str, stage: &'static str, bought: &Bought) {
    let (runner, id) = (Arc::clone(runner), id.to_owned());
    let (topic, settlement) = (bought.topic.clone(), bought.settlement.clone());
    tokio::spawn(async move {
        let emit = |v: Value| push_step(&runner, &id, stage, v);
        audit(&runner, topic.as_deref(), settlement.as_ref(), &emit).await;
    });
}

/// Starts the detector: a health check every 2s, and — when autopilot is
/// on and the stack has failed two checks in a row — a response.
pub(crate) fn spawn_watcher(runner: Arc<Runner>) {
    lock(&runner).enabled = runner.autopilot.enabled_at_start;
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(WATCH_EVERY).await;
            watch_once(&runner).await;
        }
    });
}

async fn watch_once(runner: &Arc<Runner>) {
    let Some(provider) = ops_provider(runner).await else {
        return;
    };
    match fetch_health(&provider.base_url).await {
        Ok(health) => {
            let opened = {
                let mut st = lock(runner);
                st.unhealthy_streak = if health.healthy { 0 } else { st.unhealthy_streak + 1 };
                let respond = !health.healthy
                    && st.enabled
                    && st.current.is_none()
                    && st.unhealthy_streak >= CONFIRM_CHECKS
                    && st.last_closed.is_none_or(|t| t.elapsed() >= COOLDOWN);
                st.health = Some(health.clone());
                st.health_error = None;
                respond.then(|| open(runner, &mut st, "autopilot", &health))
            };
            if let Some(id) = opened {
                tokio::spawn(respond(Arc::clone(runner), id, None));
            }
        }
        Err(error) => {
            let mut st = lock(runner);
            st.health_error = Some(format!("{} didn't answer its health check: {error:#}", provider.base_url));
            st.provider = None; // find it again, it may have moved
        }
    }
}

/// The ops provider: `OPS_PROVIDER`, or the first one discovery finds.
async fn ops_provider(runner: &Runner) -> Option<Provider> {
    {
        let st = lock(runner);
        if let Some(p) = st.provider.as_ref().filter(|p| p.found.elapsed() < REDISCOVER) {
            return Some(p.clone());
        }
        if st.provider.is_none() && st.last_discovery.is_some_and(|t| t.elapsed() < RETRY_DISCOVERY) {
            return None;
        }
    }
    lock(runner).last_discovery = Some(Instant::now());

    let found = discover(runner).await;
    let pick = found.into_iter().find_map(|d| {
        let manifest = d.manifest.ok()?;
        let wanted = runner.autopilot.provider.as_ref().is_none_or(|url| *url == d.base_url);
        (wanted && manifest.ops.is_some()).then_some((d.base_url, manifest))
    });
    let Some((base_url, manifest)) = pick else {
        lock(runner).health_error = Some(
            "No ops provider found. Start one with scripts/demo-providers.sh (it runs demo/shop).".into(),
        );
        return None;
    };
    let scenarios = reqwest::Client::new()
        .get(format!("{base_url}/v1/ops/scenarios"))
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?
        .json::<Value>()
        .await
        .unwrap_or(Value::Null);
    let provider = Provider { base_url, manifest, scenarios, found: Instant::now() };
    lock(runner).provider = Some(provider.clone());
    Some(provider)
}

async fn fetch_health(base_url: &str) -> anyhow::Result<InfraHealth> {
    Ok(reqwest::Client::new()
        .get(format!("{base_url}/v1/ops/health"))
        .timeout(Duration::from_secs(8))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?)
}

/// Opens an incident with the detector's evidence. Caller holds the lock.
fn open(runner: &Runner, st: &mut State, trigger: &'static str, health: &InfraHealth) -> String {
    let id = format!("inc-{}", &uuid_like()[..8]);
    let now = time_now();
    st.current = Some(Incident {
        id: id.clone(),
        trigger,
        opened_at: now,
        closed_at: None,
        status: "diagnosing",
        problems: health.problems.clone(),
        root_cause: None,
        diagnosed_by: None,
        actions: Vec::new(),
        outcome: None,
        spent: 0,
        asset: None,
        mttr_ms: None,
        steps: vec![json!({
            "stage": "detect",
            "step": "detected",
            "at_ms": 0,
            "agent": runner.autopilot.detect_agent,
            "trigger": trigger,
            "confirmed_checks": st.unhealthy_streak.max(1),
            "problems": health.problems,
            "health": health,
        })],
        started: Some(Instant::now()),
    });
    id
}

/// Runs one response end to end, then closes the incident.
async fn respond(runner: Arc<Runner>, id: String, budget: Option<u64>) {
    // One paid flow at a time across the runner.
    let mut busy = Arc::clone(&runner.busy).lock_owned().await;
    let (status, outcome) = pipeline(&runner, &id, budget).await;
    *busy = Some(Instant::now());
    drop(busy);

    let mut st = lock(&runner);
    if let Some(mut incident) = st.current.take() {
        incident.status = status;
        incident.closed_at = Some(time_now());
        incident.outcome = Some(outcome.clone());
        if status == "resolved" {
            incident.mttr_ms = incident.started.map(|s| s.elapsed().as_millis() as u64);
        }
        st.history.push_front(incident);
        st.history.truncate(HISTORY);
    }
    st.last_closed = Some(Instant::now());
    if status != "resolved" && st.enabled {
        st.enabled = false;
        st.paused_reason = Some(format!("Paused after an incident that wasn't resolved: {outcome}"));
    }
}

/// A diagnosis: what's wrong and what to do about it.
struct Plan {
    root_cause: String,
    actions: Vec<OpsAction>,
    by: String,
    note: Option<String>,
}

async fn pipeline(runner: &Arc<Runner>, id: &str, budget: Option<u64>) -> (&'static str, String) {
    let budget = budget.unwrap_or(runner.max_atomic).min(runner.max_atomic);
    let cfg = &runner.autopilot;
    let (provider, health) = {
        let st = lock(runner);
        (st.provider.clone(), st.health.clone())
    };
    let (Some(provider), Some(health)) = (provider, health) else {
        return ("failed", "the ops provider went away".into());
    };
    let Some(offer) = provider.manifest.ops.clone() else {
        return ("failed", "the provider stopped selling repairs".into());
    };

    // 2. Diagnose: the diagnoser buys inference over the evidence.
    set_status(runner, id, "diagnosing");
    let prompt = diagnosis_prompt(&offer, &health);
    push_step(runner, id, "diagnose", json!({ "step": "briefed", "agent": cfg.diagnose_agent, "prompt": prompt }));
    let emit = |v: Value| push_step(runner, id, "diagnose", v);
    let order = Order {
        agent: &cfg.diagnose_agent,
        service: "inference",
        prompt: &prompt,
        max_output_tokens: 200,
        budget,
        job: None,
        action: None,
        only_provider: None,
        await_audit: false,
    };
    let plan = match purchase(runner, order, &emit).await {
        Ok(Some(bought)) => {
            record_spend(runner, id, &bought);
            spawn_audit(runner, id, "diagnose", &bought);
            match parse_plan(&bought.result.completion, &offer) {
                Ok((root_cause, actions)) => Plan { root_cause, actions, by: bought.result.model.clone(), note: None },
                Err(why) => runbook(&health, &offer, Some(format!("The model's answer wasn't a usable plan ({why}), so the runbook decided."))),
            }
        }
        Ok(None) => {
            let why = stop_reason(runner, id, "diagnose").unwrap_or_else(|| "it stopped short of paying".into());
            runbook(&health, &offer, Some(format!("{} didn't buy a diagnosis ({why}), so the runbook decided.", cfg.diagnose_agent)))
        }
        Err(error) => runbook(&health, &offer, Some(format!("The diagnosis failed ({error:#}), so the runbook decided."))),
    };
    push_step(runner, id, "diagnose", json!({
        "step": "diagnosis",
        "agent": cfg.diagnose_agent,
        "root_cause": plan.root_cause,
        "actions": plan.actions,
        "by": plan.by,
        "note": plan.note,
    }));
    update(runner, id, |i| {
        i.root_cause = Some(plan.root_cause.clone());
        i.actions = plan.actions.clone();
        i.diagnosed_by = Some(plan.by.clone());
    });
    if plan.actions.is_empty() {
        return ("failed", "No repair on the menu fits this outage.".into());
    }

    // 3. Fix: the fixer buys each repair from the ops provider.
    set_status(runner, id, "fixing");
    for action in &plan.actions {
        let label = format!("{} {}", action.action, action.service);
        push_step(runner, id, "fix", json!({ "step": "ordering", "agent": cfg.fix_agent, "action": action }));
        let emit = |v: Value| push_step(runner, id, "fix", v);
        let order = Order {
            agent: &cfg.fix_agent,
            service: "ops",
            prompt: &label,
            max_output_tokens: 0,
            budget,
            job: None,
            action: Some(action.clone()),
            only_provider: Some(provider.base_url.clone()),
            await_audit: false,
        };
        match purchase(runner, order, &emit).await {
            Ok(Some(bought)) => {
                record_spend(runner, id, &bought);
                spawn_audit(runner, id, "fix", &bought);
                let healthy = bought.result.ops.as_ref().is_some_and(|o| o.health.healthy);
                push_step(runner, id, "fix", json!({
                    "step": "repaired",
                    "agent": cfg.fix_agent,
                    "action": action,
                    "ops": bought.result.ops,
                }));
                if healthy {
                    break;
                }
            }
            Ok(None) => {
                let why = stop_reason(runner, id, "fix").unwrap_or_else(|| "it stopped short of paying".into());
                return ("blocked", format!("{} couldn't buy {label}: {why}", cfg.fix_agent));
            }
            Err(error) => return ("failed", format!("{label} failed: {error:#}")),
        }
    }

    // 4. Verify: the detector confirms from the outside.
    set_status(runner, id, "verifying");
    let deadline = Instant::now() + VERIFY_WAIT;
    loop {
        let health = fetch_health(&provider.base_url).await;
        match health {
            Ok(h) if h.healthy => {
                push_step(runner, id, "verify", json!({ "step": "recovered", "agent": cfg.detect_agent, "health": h }));
                return ("resolved", "The stack is healthy again.".into());
            }
            Ok(h) if Instant::now() >= deadline => {
                let problems = h.problems.join("; ");
                push_step(runner, id, "verify", json!({ "step": "still_failing", "agent": cfg.detect_agent, "health": h }));
                return ("failed", format!("Still failing after the repair: {problems}"));
            }
            Err(error) if Instant::now() >= deadline => {
                return ("failed", format!("Couldn't confirm recovery: {error:#}"));
            }
            _ => tokio::time::sleep(Duration::from_secs(1)).await,
        }
    }
}

/// Why the last purchase in `stage` stopped short, from its steps.
fn stop_reason(runner: &Runner, id: &str, stage: &str) -> Option<String> {
    let st = lock(runner);
    let incident = st.current.as_ref().filter(|i| i.id == id)?;
    incident.steps.iter().rev().filter(|s| s["stage"] == stage).find_map(|s| {
        let text = |key: &str| s[key].as_str().map(ToOwned::to_owned);
        match s["step"].as_str()? {
            "denied" => text("decision")
                .or_else(|| s["decision"]["reason"].as_str().map(ToOwned::to_owned))
                .or_else(|| Some("the policy engine denied it".into())),
            "refused" | "service_failed" => text("reason"),
            "payment_failed" | "error" => text("message"),
            "over_budget" => Some("the cheapest quote is over the per-payment cap".into()),
            "no_provider" => Some("no provider is selling it".into()),
            _ => None,
        }
    })
}

/// What the diagnoser is told: the stack, what's wrong, recent logs, and
/// the repairs it may choose from.
fn diagnosis_prompt(offer: &OpsOffer, health: &InfraHealth) -> String {
    let mut p = format!(
        "You are the diagnosis agent for the Docker Compose stack \"{}\".\nHow it fits together: {}\nServices, dependencies first: {}.\n\nWhat the monitor sees now:\n",
        offer.project,
        offer.topology,
        offer.services.join(", ")
    );
    for s in &health.services {
        let check = if s.health.is_empty() { String::new() } else { format!(", {}", s.health) };
        p.push_str(&format!("- {}: {}{check} ({})\n", s.name, s.state, s.status));
    }
    match (health.probe.status, &health.probe.error) {
        (Some(code), _) => p.push_str(&format!("- GET {} answers {code}\n", health.probe.url)),
        (None, error) => p.push_str(&format!(
            "- GET {} fails: {}\n",
            health.probe.url,
            error.as_deref().unwrap_or("no answer")
        )),
    }
    let logs: Vec<String> = health
        .services
        .iter()
        .flat_map(|s| {
            let lines: Vec<&str> = s.logs.lines().filter(|l| !l.trim().is_empty()).collect();
            lines[lines.len().saturating_sub(3)..]
                .iter()
                .map(|l| format!("[{}] {}", s.name, l.chars().take(160).collect::<String>()))
                .collect::<Vec<_>>()
        })
        .collect();
    if !logs.is_empty() {
        p.push_str("\nRecent logs:\n");
        p.push_str(&logs.join("\n"));
        p.push('\n');
    }
    p.push_str(&format!(
        "\nThe repair agent can run only these actions, on one service each: {}. \
         start brings back a stopped or exited service, unpause a paused one, restart a running one that's broken, \
         recreate one whose container is gone.\n\
         On a Compose network a stopped container's name stops resolving, so its dependents log DNS errors.\n\
         Find the root cause, not the symptoms, and the fewest actions that fix it.\n\
         Answer with JSON only: {{\"root_cause\": \"one sentence\", \"actions\": [{{\"action\": \"...\", \"service\": \"...\"}}]}}",
        offer.actions.join(", ")
    ));
    p
}

/// Reads the model's plan, keeping only repairs the provider sells.
fn parse_plan(text: &str, offer: &OpsOffer) -> Result<(String, Vec<OpsAction>), String> {
    #[derive(Deserialize)]
    struct Answer {
        #[serde(default)]
        root_cause: String,
        #[serde(default)]
        actions: Vec<OpsAction>,
    }
    let start = text.find('{').ok_or("no JSON in it")?;
    let end = text.rfind('}').ok_or("no JSON in it")?;
    let answer: Answer = serde_json::from_str(&text[start..=end]).map_err(|e| format!("bad JSON: {e}"))?;
    let mut actions: Vec<OpsAction> = Vec::new();
    for a in answer.actions {
        let a = OpsAction { action: a.action.trim().to_lowercase(), service: a.service.trim().to_lowercase() };
        if offer.actions.contains(&a.action) && offer.services.contains(&a.service) && !actions.contains(&a) {
            actions.push(a);
        }
    }
    actions.truncate(MAX_ACTIONS);
    if actions.is_empty() {
        return Err("no repair from the menu".into());
    }
    let root_cause = if answer.root_cause.trim().is_empty() { "Not stated.".into() } else { answer.root_cause.trim().to_owned() };
    Ok((root_cause, actions))
}

/// The fallback: bring back what's down, dependencies first; if nothing
/// is down, restart what's unhealthy; if only the probe fails, restart
/// the front end.
fn runbook(health: &InfraHealth, offer: &OpsOffer, note: Option<String>) -> Plan {
    let ordered = || offer.services.iter().filter_map(|name| health.services.iter().find(|s| &s.name == name));
    let mut actions: Vec<OpsAction> = ordered()
        .filter_map(|s| {
            let action = match s.state.as_str() {
                "exited" | "dead" | "created" => "start",
                "missing" => "recreate",
                "paused" => "unpause",
                _ => return None,
            };
            Some(OpsAction { action: action.into(), service: s.name.clone() })
        })
        .collect();
    let root_cause = if let Some(first) = actions.first() {
        let s = health.services.iter().find(|s| s.name == first.service);
        format!("{} is {}; what depends on it fails with it.", first.service, s.map_or("down", |s| s.state.as_str()))
    } else if let Some(s) = ordered().find(|s| s.health == "unhealthy") {
        actions.push(OpsAction { action: "restart".into(), service: s.name.clone() });
        format!("{} is running but failing its healthcheck.", s.name)
    } else if let Some(front) = offer.services.last() {
        actions.push(OpsAction { action: "restart".into(), service: front.clone() });
        "Every container looks fine but the site doesn't answer; restarting the front end.".into()
    } else {
        "Nothing to act on.".into()
    };
    actions.truncate(MAX_ACTIONS);
    Plan { root_cause, actions, by: "runbook".into(), note }
}

fn time_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    // RFC 3339 is what the dashboard parses; build it without a time crate.
    let days = (secs / 86_400_000) as i64;
    let ms_of_day = secs % 86_400_000;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z",
        ms_of_day / 3_600_000,
        ms_of_day / 60_000 % 60,
        ms_of_day / 1000 % 60,
        ms_of_day % 1000
    )
}

/// Days since 1970-01-01 to (year, month, day), proleptic Gregorian.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn uuid_like() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("{:016x}", (nanos as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15))
}

// ─── HTTP ────────────────────────────────────────────────────────────────

/// `GET /v1/autopilot` — health, the three agents, the incident under way
/// and the last ten.
pub(crate) async fn state_route(AxumState(runner): AxumState<Arc<Runner>>) -> Json<Value> {
    let cfg = &runner.autopilot;
    let st = lock(&runner);
    Json(json!({
        "enabled": st.enabled,
        "paused_reason": st.paused_reason,
        "agents": { "detect": cfg.detect_agent, "diagnose": cfg.diagnose_agent, "fix": cfg.fix_agent },
        "provider": st.provider.as_ref().map(|p| json!({
            "base_url": p.base_url,
            "provider": p.manifest.provider,
            "offer": p.manifest.ops,
            "asset": p.manifest.asset,
            "scenarios": p.scenarios,
        })),
        "health": st.health,
        "health_error": st.health_error,
        "current": st.current,
        "history": st.history,
        "max_atomic": runner.max_atomic,
    }))
}

#[derive(Deserialize)]
pub(crate) struct Toggle {
    enabled: bool,
}

/// `POST /v1/autopilot` — `{ enabled }`: let the agents respond on their own.
pub(crate) async fn toggle_route(
    AxumState(runner): AxumState<Arc<Runner>>,
    headers: HeaderMap,
    Json(body): Json<Toggle>,
) -> Response {
    if !authorized(&runner, &headers) {
        return refuse(StatusCode::UNAUTHORIZED, "missing or wrong runner token");
    }
    let mut st = lock(&runner);
    st.enabled = body.enabled;
    st.paused_reason = None;
    st.last_closed = None; // act on an outage that's already there
    Json(json!({ "enabled": st.enabled })).into_response()
}

#[derive(Deserialize, Default)]
pub(crate) struct RespondRequest {
    budget_atomic: Option<u64>,
}

/// `POST /v1/autopilot/respond` — `{ budget_atomic? }`: respond to the
/// outage now, once, whether or not autopilot is on.
pub(crate) async fn respond_route(
    AxumState(runner): AxumState<Arc<Runner>>,
    headers: HeaderMap,
    body: Option<Json<RespondRequest>>,
) -> Response {
    if !authorized(&runner, &headers) {
        return refuse(StatusCode::UNAUTHORIZED, "missing or wrong runner token");
    }
    let budget = body.and_then(|Json(b)| b.budget_atomic);
    let id = {
        let mut st = lock(&runner);
        if st.current.is_some() {
            return refuse(StatusCode::CONFLICT, "the agents are already on an incident");
        }
        let Some(health) = st.health.clone() else {
            return refuse(StatusCode::SERVICE_UNAVAILABLE, "no health reading yet");
        };
        if health.healthy {
            return refuse(StatusCode::CONFLICT, "the stack is healthy; there's nothing to fix");
        }
        open(&runner, &mut st, "manual", &health)
    };
    tokio::spawn(respond(Arc::clone(&runner), id.clone(), budget));
    Json(json!({ "incident": id })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct ChaosRequest {
    scenario: String,
}

/// `POST /v1/autopilot/chaos` — `{ scenario }`: break the stack on
/// purpose, through the ops provider.
pub(crate) async fn chaos_route(
    AxumState(runner): AxumState<Arc<Runner>>,
    headers: HeaderMap,
    Json(body): Json<ChaosRequest>,
) -> Response {
    if !authorized(&runner, &headers) {
        return refuse(StatusCode::UNAUTHORIZED, "missing or wrong runner token");
    }
    let Some(provider) = ops_provider(&runner).await else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "no ops provider found");
    };
    match reqwest::Client::new()
        .post(format!("{}/v1/ops/chaos", provider.base_url))
        .timeout(Duration::from_secs(30))
        .json(&json!({ "scenario": body.scenario }))
        .send()
        .await
    {
        Ok(r) => {
            let status = StatusCode::from_u16(r.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
            (status, Json(r.json::<Value>().await.unwrap_or(Value::Null))).into_response()
        }
        Err(e) => refuse(StatusCode::BAD_GATEWAY, &e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use meter::{Probe, ServiceHealth};

    fn offer() -> OpsOffer {
        OpsOffer {
            project: "leash-shop".into(),
            per_action: 500,
            actions: vec!["start".into(), "restart".into(), "unpause".into(), "recreate".into()],
            services: vec!["cache".into(), "api".into(), "web".into()],
            topology: String::new(),
        }
    }

    fn svc(name: &str, state: &str, health: &str) -> ServiceHealth {
        ServiceHealth { name: name.into(), state: state.into(), health: health.into(), status: String::new(), logs: String::new() }
    }

    fn stack(services: Vec<ServiceHealth>, probe: Option<u16>) -> InfraHealth {
        InfraHealth {
            project: "leash-shop".into(),
            healthy: false,
            services,
            probe: Probe { url: "http://localhost:8088/api/visits".into(), status: probe, ms: 3, error: None },
            problems: vec![],
            checked_at: String::new(),
        }
    }

    fn act(action: &str, service: &str) -> OpsAction {
        OpsAction { action: action.into(), service: service.into() }
    }

    #[test]
    fn the_model_can_only_pick_from_the_menu() {
        let text = "<answer>{\"root_cause\": \"Redis died\", \"actions\": [{\"action\": \"Start\", \"service\": \"cache\"}, \
                    {\"action\": \"rm\", \"service\": \"api\"}, {\"action\": \"start\", \"service\": \"postgres\"}, \
                    {\"action\": \"start\", \"service\": \"cache\"}]}</answer>";
        let (root, actions) = parse_plan(text, &offer()).expect("plan");
        assert_eq!(root, "Redis died");
        assert_eq!(actions, vec![act("start", "cache")]);
        assert!(parse_plan("{\"actions\": [{\"action\": \"rm\", \"service\": \"api\"}]}", &offer()).is_err());
        assert!(parse_plan("The cache is down.", &offer()).is_err());
    }

    #[test]
    fn the_runbook_fixes_the_cause_not_the_symptom() {
        // A dead cache makes the API unhealthy: start the cache, leave the API.
        let h = stack(vec![svc("cache", "exited", ""), svc("api", "running", "unhealthy"), svc("web", "running", "healthy")], Some(503));
        assert_eq!(runbook(&h, &offer(), None).actions, vec![act("start", "cache")]);

        let h = stack(vec![svc("cache", "running", "healthy"), svc("api", "running", "healthy"), svc("web", "paused", "")], None);
        assert_eq!(runbook(&h, &offer(), None).actions, vec![act("unpause", "web")]);

        let h = stack(vec![svc("cache", "running", "healthy"), svc("api", "running", "unhealthy"), svc("web", "running", "healthy")], Some(503));
        assert_eq!(runbook(&h, &offer(), None).actions, vec![act("restart", "api")]);
    }

    #[test]
    fn the_brief_carries_states_probe_logs_and_the_menu() {
        let mut api = svc("api", "running", "unhealthy");
        api.logs = "a\nb\nc\nERROR cache unreachable".into();
        let h = stack(vec![svc("cache", "exited", ""), api, svc("web", "running", "healthy")], Some(503));
        let p = diagnosis_prompt(&offer(), &h);
        assert!(p.contains("- cache: exited"));
        assert!(p.contains("- api: running, unhealthy"));
        assert!(p.contains("answers 503"));
        assert!(p.contains("[api] ERROR cache unreachable"));
        assert!(!p.contains("[api] a\n"), "only the last lines");
        assert!(p.contains("start, restart, unpause, recreate"));
    }

    #[test]
    fn timestamps_are_rfc3339() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_709), (2026, 9, 13));
        let now = time_now();
        assert_eq!(now.len(), 24, "{now}");
        assert!(now.ends_with('Z'));
    }
}
