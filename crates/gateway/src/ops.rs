//! The ops provider: sells repair actions on one Docker Compose stack.
//!
//! What's for sale is deliberately small — `start`, `restart`, `unpause`
//! or `recreate`, on a service the stack defines — so an agent that pays
//! gets exactly that command run and nothing else: no shell, no image,
//! no arguments of its own. Who may buy at all, and how much, is the
//! policy engine's call, like any other payment.
//!
//! Health is free (`GET /v1/ops/health`): watching costs nothing, acting
//! costs money. `POST /v1/ops/chaos` breaks the stack on purpose for a
//! demo, when `OPS_CHAOS` isn't `0`.
//!
//! Enabled with `OPS_COMPOSE_FILE`. Talks to Docker through its CLI.

use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use common::utils::get_from_env_unsafe;
use meter::{InfraHealth, OpsAction, OpsOffer, OpsResult, Probe, ServiceHealth};
use serde::Deserialize;
use tokio::process::Command;

use crate::hcs::now_rfc3339;

/// Actions for sale, and the compose command each one runs.
const ACTIONS: &[(&str, &[&str])] = &[
    ("start", &["start"]),
    ("restart", &["restart"]),
    ("unpause", &["unpause"]),
    ("recreate", &["up", "-d", "--force-recreate", "--no-deps"]),
];

/// Ways to break the stack on purpose.
pub const SCENARIOS: &[(&str, &str)] = &[
    ("kill-cache", "Kill the Redis cache"),
    ("stop-api", "Stop the API"),
    ("freeze-web", "Freeze the web server"),
    ("reset", "Bring everything back up"),
];

/// How long a repair waits for the stack to report healthy again.
const SETTLE_WAIT: Duration = Duration::from_secs(15);

/// One Compose stack, and the repairs sold on it.
pub struct Ops {
    file: String,
    project: String,
    probe_url: String,
    chaos: bool,
    offer: OpsOffer,
}

#[derive(Deserialize)]
struct PsRow {
    #[serde(rename = "Service")]
    service: String,
    #[serde(rename = "State")]
    state: String,
    #[serde(rename = "Health", default)]
    health: String,
    #[serde(rename = "Status", default)]
    status: String,
}

impl Ops {
    /// An ops provider when `OPS_COMPOSE_FILE` is set, else `None`.
    ///
    /// `OPS_PROJECT` (default `leash-shop`), `OPS_PROBE_URL` (the
    /// end-to-end check), `OPS_PRICE` (atomic units per action),
    /// `OPS_TOPOLOGY` (one line on how the services depend on each other)
    /// and `OPS_CHAOS` shape it.
    ///
    /// # Errors
    ///
    /// The compose file can't be read by `docker compose config`.
    pub async fn from_env(default_price: u64) -> Result<Option<Self>> {
        let Ok(file) = get_from_env_unsafe::<String>("OPS_COMPOSE_FILE") else {
            return Ok(None);
        };
        if file.trim().is_empty() {
            return Ok(None);
        }
        let file = std::fs::canonicalize(&file)
            .with_context(|| format!("OPS_COMPOSE_FILE {file} not found"))?
            .to_string_lossy()
            .into_owned();
        let project: String = get_from_env_unsafe("OPS_PROJECT").unwrap_or_else(|_| "leash-shop".into());
        let mut ops = Self {
            file,
            project: project.clone(),
            probe_url: get_from_env_unsafe("OPS_PROBE_URL")
                .unwrap_or_else(|_| "http://localhost:8088/api/visits".into()),
            chaos: get_from_env_unsafe::<String>("OPS_CHAOS").map_or(true, |v| v != "0" && v != "false"),
            offer: OpsOffer {
                project,
                per_action: get_from_env_unsafe("OPS_PRICE").unwrap_or(default_price),
                actions: ACTIONS.iter().map(|(a, _)| (*a).to_owned()).collect(),
                services: Vec::new(),
                topology: get_from_env_unsafe("OPS_TOPOLOGY").unwrap_or_else(|_| {
                    "web (public front end, port 8088) proxies /api to api; \
                     api (Python) keeps its data in cache; cache is Redis. \
                     Nothing restarts on its own."
                        .into()
                }),
            },
        };
        // `config --services` lists dependencies before their dependents.
        ops.offer.services = ops
            .compose(&["config", "--services"])
            .await?
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .collect();
        Ok(Some(ops))
    }

    /// What this provider sells, for the manifest.
    #[must_use]
    pub const fn offer(&self) -> &OpsOffer {
        &self.offer
    }

    /// Whether `POST /v1/ops/chaos` is enabled.
    #[must_use]
    pub const fn chaos_enabled(&self) -> bool {
        self.chaos
    }

    /// Checks `action` against the offer and prices it.
    ///
    /// # Errors
    ///
    /// Why it can't be sold: an action or a service that isn't offered.
    pub fn price(&self, action: &OpsAction) -> Result<u64, String> {
        if !ACTIONS.iter().any(|(a, _)| *a == action.action) {
            return Err(format!(
                "action {:?} isn't sold here; choose one of {}",
                action.action,
                self.offer.actions.join(", ")
            ));
        }
        if !self.offer.services.contains(&action.service) {
            return Err(format!(
                "service {:?} isn't part of {}; choose one of {}",
                action.service,
                self.project,
                self.offer.services.join(", ")
            ));
        }
        Ok(self.offer.per_action)
    }

    /// Brings the stack up, so there's something to keep alive.
    ///
    /// # Errors
    ///
    /// `docker compose up` failing.
    pub async fn up(&self) -> Result<String> {
        self.compose(&["up", "-d", "--remove-orphans"]).await
    }

    /// The stack right now: every service's state and healthcheck, the
    /// end-to-end probe, and — when something's wrong — recent logs.
    pub async fn health(&self) -> InfraHealth {
        let rows: Vec<PsRow> = match self.compose(&["ps", "--all", "--format", "json"]).await {
            // One JSON object per line (older Compose: one array).
            Ok(out) => serde_json::from_str::<Vec<PsRow>>(&out).unwrap_or_else(|_| {
                out.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
            }),
            Err(error) => {
                tracing::warn!(%error, "docker compose ps failed");
                Vec::new()
            }
        };
        let mut services: Vec<ServiceHealth> = self
            .offer
            .services
            .iter()
            .map(|name| {
                rows.iter().find(|r| &r.service == name).map_or_else(
                    || ServiceHealth {
                        name: name.clone(),
                        state: "missing".into(),
                        health: String::new(),
                        status: "no container".into(),
                        logs: String::new(),
                    },
                    |r| ServiceHealth {
                        name: name.clone(),
                        state: r.state.clone(),
                        health: r.health.clone(),
                        status: r.status.clone(),
                        logs: String::new(),
                    },
                )
            })
            .collect();

        let probe = probe(&self.probe_url).await;
        let mut problems: Vec<String> = services
            .iter()
            .filter_map(|s| match (s.state.as_str(), s.health.as_str()) {
                ("running", "healthy" | "") => None,
                ("running", "starting") => Some(format!("{} is starting", s.name)),
                ("running", health) => Some(format!("{} is running but {health}", s.name)),
                (state, _) => Some(format!("{} is {state} ({})", s.name, s.status)),
            })
            .collect();
        match (probe.status, &probe.error) {
            (Some(200), _) => {}
            (Some(code), _) => problems.push(format!("GET {} answers {code}", probe.url)),
            (None, Some(error)) => problems.push(format!("GET {} fails: {error}", probe.url)),
            (None, None) => problems.push(format!("GET {} gets no answer", probe.url)),
        }

        // Evidence for whoever diagnoses it: what each service last said.
        if !problems.is_empty() {
            for service in &mut services {
                service.logs = self
                    .compose(&["logs", "--no-log-prefix", "--tail", "6", &service.name])
                    .await
                    .unwrap_or_default();
            }
        }

        InfraHealth {
            project: self.project.clone(),
            healthy: problems.is_empty(),
            services,
            probe,
            problems,
            checked_at: now_rfc3339(),
        }
    }

    /// Runs a paid-for repair, then waits (up to 15s) for the stack to
    /// report healthy, and returns what happened.
    ///
    /// # Errors
    ///
    /// The action isn't offered, or Docker failed to run it. Either way the
    /// handler answers 502 and the payment isn't settled.
    pub async fn execute(&self, action: &OpsAction) -> Result<OpsResult> {
        self.price(action).map_err(anyhow::Error::msg)?;
        let (_, args) = ACTIONS
            .iter()
            .find(|(a, _)| *a == action.action)
            .context("unknown action")?;
        let mut argv: Vec<&str> = args.to_vec();
        argv.push(&action.service);
        let output = self.compose(&argv).await?;
        let command = format!("docker compose {}", argv.join(" "));
        tracing::info!(%command, "repair ran");

        let started = Instant::now();
        let mut health = self.health().await;
        while !health.healthy && started.elapsed() < SETTLE_WAIT {
            tokio::time::sleep(Duration::from_millis(1_000)).await;
            health = self.health().await;
        }
        Ok(OpsResult {
            action: action.action.clone(),
            service: action.service.clone(),
            command,
            output,
            health,
        })
    }

    /// Breaks the stack on purpose (or, with `reset`, brings it back).
    ///
    /// # Errors
    ///
    /// An unknown scenario, or Docker failing.
    pub async fn chaos(&self, scenario: &str) -> Result<String> {
        let args: &[&str] = match scenario {
            "kill-cache" => &["kill", "cache"],
            "stop-api" => &["stop", "api"],
            "freeze-web" => &["pause", "web"],
            "reset" => {
                // Unpause first: `up` leaves a paused container paused.
                let _ = self.compose(&["unpause"]).await;
                &["up", "-d"]
            }
            other => bail!(
                "unknown scenario {other:?}; choose one of {}",
                SCENARIOS.iter().map(|(s, _)| *s).collect::<Vec<_>>().join(", ")
            ),
        };
        self.compose(args).await?;
        tracing::warn!(%scenario, "chaos");
        Ok(format!("docker compose {}", args.join(" ")))
    }

    async fn compose(&self, args: &[&str]) -> Result<String> {
        let output = Command::new("docker")
            .args(["compose", "-f", &self.file, "-p", &self.project])
            .args(args)
            .output()
            .await
            .context("running docker compose (is Docker running?)")?;
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        if !output.status.success() {
            bail!("docker compose {}: {}", args.join(" "), if stderr.is_empty() { &stdout } else { &stderr });
        }
        // Compose narrates progress on stderr; keep it for `logs` and actions.
        Ok(match (stdout.is_empty(), stderr.is_empty()) {
            (false, false) => format!("{stdout}\n{stderr}"),
            (true, _) => stderr,
            (false, true) => stdout,
        })
    }
}

async fn probe(url: &str) -> Probe {
    let started = Instant::now();
    let result = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(2))
        .send()
        .await;
    let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    match result {
        Ok(response) => Probe {
            url: url.to_owned(),
            status: Some(response.status().as_u16()),
            ms,
            error: None,
        },
        Err(error) => Probe {
            url: url.to_owned(),
            status: None,
            ms,
            error: Some(if error.is_timeout() { "timed out".into() } else { error.to_string() }),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ops() -> Ops {
        Ops {
            file: String::new(),
            project: "shop".into(),
            probe_url: String::new(),
            chaos: false,
            offer: OpsOffer {
                project: "shop".into(),
                per_action: 500,
                actions: ACTIONS.iter().map(|(a, _)| (*a).to_owned()).collect(),
                services: vec!["cache".into(), "api".into(), "web".into()],
                topology: String::new(),
            },
        }
    }

    fn act(action: &str, service: &str) -> OpsAction {
        OpsAction { action: action.into(), service: service.into() }
    }

    #[test]
    fn only_offered_actions_on_known_services_are_sold() {
        let o = ops();
        assert_eq!(o.price(&act("start", "cache")), Ok(500));
        assert_eq!(o.price(&act("recreate", "web")), Ok(500));
        assert!(o.price(&act("rm", "cache")).is_err(), "no destructive actions");
        assert!(o.price(&act("start", "postgres")).is_err(), "no services outside the stack");
        assert!(o.price(&act("start", "cache; rm -rf /")).is_err());
    }

    /// Real Docker: break the demo stack, see it detected, repair it.
    /// `OPS_COMPOSE_FILE=../../demo/shop/docker-compose.yaml cargo test -p gateway ops -- --ignored`
    #[tokio::test]
    #[ignore = "needs Docker and the demo stack"]
    async fn a_killed_cache_is_detected_and_repaired() {
        let ops = Ops::from_env(500).await.expect("compose config").expect("OPS_COMPOSE_FILE set");
        ops.up().await.expect("up");
        tokio::time::sleep(Duration::from_secs(6)).await;
        assert!(ops.health().await.healthy, "starts healthy");

        ops.chaos("kill-cache").await.expect("kill");
        tokio::time::sleep(Duration::from_secs(2)).await;
        let broken = ops.health().await;
        assert!(!broken.healthy);
        assert!(broken.problems.iter().any(|p| p.starts_with("cache is exited")), "{:?}", broken.problems);

        let fixed = ops.execute(&act("start", "cache")).await.expect("repair");
        assert!(fixed.health.healthy, "healthy after repair: {:?}", fixed.health.problems);
    }
}
