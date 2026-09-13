//! The compute broker: rents out real containers (local Docker), prepaid by
//! the minute over x402, torn down when the time runs out.
//!
//! The agent never holds infrastructure credentials. It pays for a job
//! (`image`, `command`, `minutes`); the broker starts the container with
//! CPU, memory and process limits and a deadline; a reaper removes it when
//! the deadline passes — or sooner, when the agent that paid for it loses
//! its authority. Paying for more minutes (`extend`) is a new payment, so it
//! goes through the policy engine like the first one.
//!
//! Enabled with `COMPUTE_BACKEND=docker`. Talks to Docker through its CLI,
//! so there's nothing to link against.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use common::utils::get_from_env_unsafe;
use mandate::{MandateGuard, Violation};
use meter::{ComputeEvent, ComputeOffer, ComputeResource, JobSpec};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use tokio::process::Command;
use tokio::sync::{Mutex, mpsc};

use crate::hcs::{HcsMessage, now_rfc3339};
use crate::mandate_guard::AnyResolver;

const LABEL_PROVIDER: &str = "leash.provider";
const LABEL_AGENT: &str = "leash.agent";
const LABEL_QUOTE: &str = "leash.quote";
const LABEL_EXPIRES: &str = "leash.expires";
const MAX_COMMAND_CHARS: usize = 500;

#[derive(Debug, Clone)]
struct Tracked {
    resource: ComputeResource,
    expires: OffsetDateTime,
}

/// Docker-backed compute, sold by the minute.
pub struct Broker {
    provider: String,
    offer: ComputeOffer,
    cpus: String,
    memory: String,
    resources: Mutex<HashMap<String, Tracked>>,
    hcs: Option<mpsc::UnboundedSender<HcsMessage>>,
}

impl Broker {
    /// A broker when `COMPUTE_BACKEND=docker`, else `None`.
    ///
    /// `COMPUTE_IMAGES` (allowlist), `COMPUTE_PER_MINUTE` (atomic units),
    /// `COMPUTE_MAX_MINUTES`, `COMPUTE_CPUS` and `COMPUTE_MEMORY` shape the
    /// offer; `default_per_minute` is used when the price isn't set.
    #[must_use]
    pub fn from_env(
        provider: &str,
        default_per_minute: u64,
        hcs: Option<mpsc::UnboundedSender<HcsMessage>>,
    ) -> Option<Self> {
        let backend: String = get_from_env_unsafe("COMPUTE_BACKEND").ok()?;
        if !backend.eq_ignore_ascii_case("docker") {
            return None;
        }
        let images: String = get_from_env_unsafe("COMPUTE_IMAGES")
            .unwrap_or_else(|_| "alpine:3.20,python:3.12-alpine,redis:7-alpine".into());
        let cpus: String = get_from_env_unsafe("COMPUTE_CPUS").unwrap_or_else(|_| "0.5".into());
        let memory: String = get_from_env_unsafe("COMPUTE_MEMORY").unwrap_or_else(|_| "256m".into());
        Some(Self {
            provider: provider.to_owned(),
            offer: ComputeOffer {
                per_minute: get_from_env_unsafe("COMPUTE_PER_MINUTE").unwrap_or(default_per_minute),
                max_minutes: get_from_env_unsafe("COMPUTE_MAX_MINUTES").unwrap_or(30),
                images: images
                    .split(',')
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
                    .collect(),
                limits: format!("{cpus} CPU, {memory} memory"),
            },
            cpus,
            memory,
            resources: Mutex::new(HashMap::new()),
            hcs,
        })
    }

    /// What this broker sells, for the manifest.
    #[must_use]
    pub const fn offer(&self) -> &ComputeOffer {
        &self.offer
    }

    /// Checks `job` against the offer and prices it, in atomic units.
    ///
    /// # Errors
    ///
    /// Why the job can't be sold: an image off the allowlist, a runtime
    /// outside `1..=max_minutes`, or an extension of something that isn't
    /// running here.
    pub async fn price(&self, job: &JobSpec) -> Result<u64, String> {
        if job.minutes == 0 || job.minutes > self.offer.max_minutes {
            return Err(format!("minutes must be between 1 and {}", self.offer.max_minutes));
        }
        match &job.extend {
            Some(id) => {
                let resources = self.resources.lock().await;
                let Some(tracked) = resources.get(id) else {
                    return Err(format!("no resource {id} is running here"));
                };
                if tracked.resource.status != "running" {
                    return Err(format!("resource {id} is {}", tracked.resource.status));
                }
            }
            None => {
                if !self.offer.images.iter().any(|i| i == &job.image) {
                    return Err(format!(
                        "image {:?} isn't offered; choose one of {}",
                        job.image,
                        self.offer.images.join(", ")
                    ));
                }
                if job.command.chars().count() > MAX_COMMAND_CHARS {
                    return Err(format!("command is longer than {MAX_COMMAND_CHARS} characters"));
                }
            }
        }
        Ok(self.offer.per_minute.saturating_mul(job.minutes))
    }

    /// Starts (or extends) the paid-for container. Called only after the
    /// payment is verified; settlement follows only if this succeeds.
    ///
    /// # Errors
    ///
    /// Docker failing to start the container, or the extended resource
    /// being gone.
    pub async fn provision(&self, agent: &str, quote_id: &str, job: &JobSpec) -> Result<ComputeResource> {
        if let Some(id) = &job.extend {
            let mut resources = self.resources.lock().await;
            let tracked = resources.get_mut(id).context("that resource is gone")?;
            if tracked.resource.agent != agent {
                bail!("{id} belongs to {}, not {agent}", tracked.resource.agent);
            }
            tracked.expires += time::Duration::minutes(i64::try_from(job.minutes)?);
            tracked.resource.expires_at = tracked.expires.format(&Rfc3339)?;
            tracked.resource.paid_by.push(quote_id.to_owned());
            return Ok(tracked.resource.clone());
        }

        let expires = OffsetDateTime::now_utc() + time::Duration::minutes(i64::try_from(job.minutes)?);
        let expires_at = expires.format(&Rfc3339)?;
        let short = &uuid::Uuid::new_v4().simple().to_string()[..8];
        let name = format!("leash-{}-{short}", self.provider);

        let mut args: Vec<String> = [
            "run", "-d", "--name", &name,
            "--cpus", &self.cpus, "--memory", &self.memory,
            "--pids-limit", "128", "--security-opt", "no-new-privileges",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        for (key, value) in [
            (LABEL_PROVIDER, self.provider.as_str()),
            (LABEL_AGENT, agent),
            (LABEL_QUOTE, quote_id),
            (LABEL_EXPIRES, expires_at.as_str()),
        ] {
            args.push("--label".into());
            args.push(format!("{key}={value}"));
        }
        args.push(job.image.clone());
        if !job.command.trim().is_empty() {
            args.extend(["sh".into(), "-c".into(), job.command.clone()]);
        }

        let id = docker(&args).await?;
        let id = id.chars().take(12).collect::<String>();
        let resource = ComputeResource {
            id: id.clone(),
            name,
            agent: agent.to_owned(),
            image: job.image.clone(),
            command: job.command.clone(),
            started_at: now_rfc3339(),
            expires_at,
            status: "running".into(),
            paid_by: vec![quote_id.to_owned()],
            logs: String::new(),
        };
        self.resources
            .lock()
            .await
            .insert(id, Tracked { resource: resource.clone(), expires });
        tracing::info!(resource = %resource.id, %agent, image = %job.image, minutes = job.minutes, "container started");
        Ok(resource)
    }

    /// Everything this broker is running (or ran and is keeping until its
    /// paid time ends), with live status and recent output.
    pub async fn list(&self) -> Vec<ComputeResource> {
        let snapshot: Vec<Tracked> = self.resources.lock().await.values().cloned().collect();
        let mut out = Vec::with_capacity(snapshot.len());
        for mut tracked in snapshot {
            if let Ok(status) = docker(&["inspect", "-f", "{{.State.Status}}", &tracked.resource.id]).await {
                tracked.resource.status = status.trim().to_owned();
            }
            tracked.resource.logs = logs(&tracked.resource.id).await;
            out.push(tracked.resource);
        }
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out
    }

    /// Removes a container now and records why.
    ///
    /// # Errors
    ///
    /// The resource isn't one of this broker's.
    pub async fn stop(&self, id: &str, reason: &str) -> Result<()> {
        let Some(tracked) = self.resources.lock().await.remove(id) else {
            bail!("no resource {id} here");
        };
        if let Err(error) = docker(&["rm", "-f", id]).await {
            tracing::warn!(%error, resource = %id, "docker rm failed");
        }
        tracing::info!(resource = %id, agent = %tracked.resource.agent, %reason, "container torn down");
        let event = ComputeEvent {
            kind: "leash.compute.teardown.v1".into(),
            provider: self.provider.clone(),
            resource: id.to_owned(),
            agent: tracked.resource.agent,
            reason: reason.to_owned(),
            at: now_rfc3339(),
        };
        if let Some(tx) = &self.hcs {
            let _ = tx.send(HcsMessage::Teardown(event));
        }
        Ok(())
    }

    /// Re-adopts containers this provider started before a restart, from
    /// their labels, so their deadlines still hold.
    pub async fn adopt(&self) {
        let filter = format!("label={LABEL_PROVIDER}={}", self.provider);
        let format = format!(
            "{{{{.ID}}}}\t{{{{.Names}}}}\t{{{{.Image}}}}\t{{{{.Label \"{LABEL_AGENT}\"}}}}\t{{{{.Label \"{LABEL_QUOTE}\"}}}}\t{{{{.Label \"{LABEL_EXPIRES}\"}}}}\t{{{{.State}}}}"
        );
        let Ok(listing) = docker(&["ps", "-a", "--filter", &filter, "--format", &format]).await else {
            return;
        };
        let mut resources = self.resources.lock().await;
        for line in listing.lines() {
            let f: Vec<&str> = line.split('\t').collect();
            let [id, name, image, agent, quote, expires_at, status] = f[..] else {
                continue;
            };
            let Ok(expires) = OffsetDateTime::parse(expires_at, &Rfc3339) else {
                continue;
            };
            resources.insert(
                id.to_owned(),
                Tracked {
                    resource: ComputeResource {
                        id: id.to_owned(),
                        name: name.to_owned(),
                        agent: agent.to_owned(),
                        image: image.to_owned(),
                        command: String::new(),
                        started_at: String::new(),
                        expires_at: expires_at.to_owned(),
                        status: status.to_owned(),
                        paid_by: vec![quote.to_owned()],
                        logs: String::new(),
                    },
                    expires,
                },
            );
        }
        if !resources.is_empty() {
            tracing::info!(count = resources.len(), "re-adopted running containers");
        }
    }

    /// Tears down containers whose paid time is over (checked every few
    /// seconds) and those whose agent lost its authority (checked every
    /// `revocation_every`): revoking an agent stops its infrastructure.
    pub fn spawn_reaper(self: Arc<Self>, guard: Option<Arc<MandateGuard<AnyResolver>>>, revocation_every: Duration) {
        tokio::spawn(async move {
            let mut last_revocation_check = tokio::time::Instant::now();
            loop {
                tokio::time::sleep(Duration::from_secs(3)).await;
                let now = OffsetDateTime::now_utc();
                let expired: Vec<String> = self
                    .resources
                    .lock()
                    .await
                    .iter()
                    .filter(|(_, t)| t.expires <= now)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in expired {
                    let _ = self.stop(&id, "expired").await;
                }

                let Some(guard) = &guard else { continue };
                if last_revocation_check.elapsed() < revocation_every {
                    continue;
                }
                last_revocation_check = tokio::time::Instant::now();
                let owners: HashMap<String, Vec<String>> =
                    self.resources.lock().await.values().fold(HashMap::new(), |mut acc, t| {
                        acc.entry(t.resource.agent.clone()).or_default().push(t.resource.id.clone());
                        acc
                    });
                for (agent, ids) in owners {
                    match guard.check(&agent, 0).await {
                        Err(v) if matches!(v.reason, Violation::Expired | Violation::Unresolvable) => {
                            tracing::warn!(%agent, blocked_by = %v.node, "authority gone; tearing down its containers");
                            for id in ids {
                                let _ = self.stop(&id, "revoked").await;
                            }
                        }
                        // A backend hiccup (RPC down) must not tear down paid infrastructure.
                        _ => {}
                    }
                }
            }
        });
    }
}

async fn docker(args: &[impl AsRef<std::ffi::OsStr>]) -> Result<String> {
    let output = Command::new("docker")
        .args(args)
        .output()
        .await
        .context("running docker (is it installed and running?)")?;
    if !output.status.success() {
        bail!("docker: {}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

async fn logs(id: &str) -> String {
    match Command::new("docker").args(["logs", "--tail", "12", id]).output().await {
        Ok(out) => {
            let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            text.trim().chars().rev().take(2_000).collect::<String>().chars().rev().collect()
        }
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn broker() -> Broker {
        Broker {
            provider: "test".into(),
            offer: ComputeOffer {
                per_minute: 200,
                max_minutes: 30,
                images: vec!["alpine:3.20".into()],
                limits: String::new(),
            },
            cpus: "0.5".into(),
            memory: "256m".into(),
            resources: Mutex::new(HashMap::new()),
            hcs: None,
        }
    }

    fn job(image: &str, minutes: u64) -> JobSpec {
        JobSpec {
            image: image.into(),
            command: "echo hi".into(),
            minutes,
            extend: None,
        }
    }

    #[tokio::test]
    async fn a_job_costs_its_minutes() {
        assert_eq!(broker().price(&job("alpine:3.20", 5)).await, Ok(1_000));
    }

    #[tokio::test]
    async fn only_allowlisted_images_and_bounded_runtimes_are_sold() {
        let b = broker();
        assert!(b.price(&job("ubuntu:latest", 5)).await.is_err());
        assert!(b.price(&job("alpine:3.20", 0)).await.is_err());
        assert!(b.price(&job("alpine:3.20", 31)).await.is_err());
    }

    /// Real Docker: start, list with logs, extend, expire. Run with
    /// `cargo test -p gateway compute -- --ignored` (needs Docker running).
    #[tokio::test]
    #[ignore = "needs Docker"]
    async fn a_container_runs_until_its_paid_time_ends() {
        let b = Arc::new(broker());
        let mut j = job("alpine:3.20", 1);
        j.command = "echo leash-broker-test; sleep 300".into();
        let started = b.provision("sub.agent.root", "q1", &j).await.expect("docker run");
        tokio::time::sleep(Duration::from_millis(800)).await;

        let listed = b.list().await;
        let found = listed.iter().find(|r| r.id == started.id).expect("listed");
        assert_eq!(found.status, "running");
        assert!(found.logs.contains("leash-broker-test"), "logs: {:?}", found.logs);

        // Extending is only for its own agent.
        let ext = JobSpec { image: String::new(), command: String::new(), minutes: 2, extend: Some(started.id.clone()) };
        assert!(b.provision("someone.else", "q2", &ext).await.is_err());
        let extended = b.provision("sub.agent.root", "q2", &ext).await.expect("extend");
        assert_eq!(extended.paid_by, vec!["q1".to_owned(), "q2".to_owned()]);

        // Force the deadline into the past and let the reaper take it.
        b.resources.lock().await.get_mut(&started.id).unwrap().expires = OffsetDateTime::now_utc();
        Arc::clone(&b).spawn_reaper(None, Duration::from_secs(3600));
        tokio::time::sleep(Duration::from_secs(5)).await;
        assert!(b.resources.lock().await.is_empty(), "reaped");
        assert!(docker(&["inspect", &started.id]).await.is_err(), "container removed");
    }

    #[tokio::test]
    async fn extending_needs_a_running_resource() {
        let mut j = job("", 5);
        j.extend = Some("nope".into());
        assert!(broker().price(&j).await.is_err());
    }
}
