//! `MandateGuard` — the policy engine every x402 payment must clear before it
//! settles.
//!
//! Walks an agent's ENS ancestor chain, root to leaf, re-resolving every hop
//! fresh on every call, and evaluates six deterministic checks against every
//! hop: the agent exists, nothing on the chain is expired or revoked, the
//! service and the asset are permitted, the amount fits the per-call limit,
//! and it fits what's left of the authority once the subtree's spending so far
//! is counted. One failing hop anywhere blocks the leaf. Nothing is cached
//! past a single request, so a revoke reaches the very next check.

use std::collections::HashMap;

use meter::MandateHop;
use serde::Serialize;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use crate::resolver::{MandateNode, MandateResolver};

/// Why a spend was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Violation {
    /// This node could not be resolved at all (unregistered, or expired and
    /// so back to `AVAILABLE` on ENSv2).
    Unresolvable,
    /// This node's own expiry (or, at the root, its Selfie Check deadline)
    /// has passed, or it was revoked.
    Expired,
    /// The requested amount alone exceeds this node's authority.
    OverBudget { budget: u64 },
    /// What the subtree has already spent plus this amount exceeds this
    /// node's authority.
    InsufficientAuthority { budget: u64, spent: u64 },
    /// The requested amount exceeds this node's per-call ceiling.
    OverPerCallLimit { max_per_call: u64 },
    /// This node's `allowedServices` doesn't include the service.
    ServiceNotPermitted { service: String },
    /// This node doesn't allow paying in this asset.
    AssetNotPermitted { asset: String },
}

impl Violation {
    /// Stable machine name, as recorded in refusals.
    #[must_use]
    pub const fn kind(&self) -> &'static str {
        match self {
            Self::Unresolvable => "unresolvable",
            Self::Expired => "expired",
            Self::OverBudget { .. } => "over_budget",
            Self::InsufficientAuthority { .. } => "insufficient_authority",
            Self::OverPerCallLimit { .. } => "over_per_call_limit",
            Self::ServiceNotPermitted { .. } => "service_not_permitted",
            Self::AssetNotPermitted { .. } => "asset_not_permitted",
        }
    }

    /// The limit that was hit, in atomic units, when there is one.
    #[must_use]
    pub const fn limit(&self) -> Option<u64> {
        match self {
            Self::OverBudget { budget } | Self::InsufficientAuthority { budget, .. } => Some(*budget),
            Self::OverPerCallLimit { max_per_call } => Some(*max_per_call),
            _ => None,
        }
    }
}

/// A blocked spend, naming exactly which ancestor blocked it and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MandateViolation {
    /// ENS subname of the offending ancestor (may be the agent itself).
    pub node: String,
    /// Why that node failed.
    pub reason: Violation,
}

impl std::fmt::Display for MandateViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let node = &self.node;
        match &self.reason {
            Violation::Unresolvable => write!(f, "{node} is not a registered agent"),
            Violation::Expired => write!(f, "{node}'s authority has expired or was revoked"),
            Violation::OverBudget { budget } => {
                write!(f, "request exceeds {node}'s authority of {budget}")
            }
            Violation::InsufficientAuthority { budget, spent } => write!(
                f,
                "request exceeds {node}'s remaining authority ({spent} of {budget} already spent)"
            ),
            Violation::OverPerCallLimit { max_per_call } => {
                write!(f, "request exceeds {node}'s per-request limit of {max_per_call}")
            }
            Violation::ServiceNotPermitted { service } => {
                write!(f, "{node}'s policy does not permit {service}")
            }
            Violation::AssetNotPermitted { asset } => {
                write!(f, "{node}'s policy does not permit paying in {asset}")
            }
        }
    }
}

impl std::error::Error for MandateViolation {}

/// What an agent wants to spend, and on what.
#[derive(Debug, Clone)]
pub struct SpendRequest {
    /// The agent's ENS name.
    pub agent: String,
    /// Atomic units of `asset`.
    pub amount: u64,
    /// Service category being bought (`inference`, `compute`, …). `None`
    /// skips the service check.
    pub service: Option<String>,
    /// Asset the payment is in: its token id, and its symbol when known.
    /// `None` skips the asset check.
    pub asset: Option<AssetRef>,
}

/// A payment asset, as the policy compares it.
#[derive(Debug, Clone)]
pub struct AssetRef {
    /// HTS token id (`0.0.429274`) or `hbar`.
    pub id: String,
    /// Symbol (`USDC`), matched case-insensitively.
    pub symbol: String,
}

/// Where already-settled spending comes from: atomic units each node's
/// subtree has spent. A node with no entry has spent nothing.
pub type Spent = HashMap<String, u64>;

/// Outcome of one policy check, across the whole chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    /// Every hop passed.
    Pass,
    /// At least one hop failed.
    Fail,
    /// Couldn't be evaluated (the chain didn't resolve, or the request
    /// didn't name a service/asset).
    Skipped,
}

/// One line of the decision: what was checked and how it came out.
#[derive(Debug, Clone, Serialize)]
pub struct Check {
    /// Stable id: `active`, `authority`, `per_call`, `service`, `asset`, `expiry`.
    pub id: &'static str,
    /// Human label, e.g. "Within per-request limit".
    pub label: &'static str,
    pub status: CheckStatus,
    /// The hop that failed, when one did.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    /// One sentence saying why, when it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The policy engine's full answer for one request.
#[derive(Debug, Clone)]
pub struct Decision {
    /// Every check, in display order.
    pub checks: Vec<Check>,
    /// The chain, root first, when it resolved.
    pub path: Vec<MandateHop>,
    /// The deciding violation — `None` means approved.
    pub violation: Option<MandateViolation>,
}

impl Decision {
    /// Whether the request is authorized.
    #[must_use]
    pub const fn approved(&self) -> bool {
        self.violation.is_none()
    }
}

/// Gates a spend against the whole resolved ancestor chain of an agent.
pub struct MandateGuard<R> {
    resolver: R,
}

impl<R: MandateResolver> MandateGuard<R> {
    /// Builds a guard backed by `resolver` — a [`crate::MockResolver`] for
    /// tests/demos, or [`crate::EnsResolver`] against the live registry.
    pub const fn new(resolver: R) -> Self {
        Self { resolver }
    }

    /// Checks whether `agent` may spend `amount` right now, on authority and
    /// expiry alone (no service, asset or prior spending).
    ///
    /// # Errors
    ///
    /// The deciding [`MandateViolation`].
    pub async fn check(&self, agent: &str, amount: u64) -> Result<Vec<MandateHop>, MandateViolation> {
        let request = SpendRequest {
            agent: agent.to_owned(),
            amount,
            service: None,
            asset: None,
        };
        let decision = self.evaluate(&request, &Spent::new(), None).await;
        decision.violation.map_or(Ok(decision.path), Err)
    }

    /// Evaluates every check for `request` against the live chain.
    ///
    /// `spent` is what each node's subtree has already settled; `tree_asset`
    /// is the asset budgets are denominated in, which is the only asset a
    /// node without an `allowedAssets` record permits.
    pub async fn evaluate(
        &self,
        request: &SpendRequest,
        spent: &Spent,
        tree_asset: Option<&AssetRef>,
    ) -> Decision {
        // ENS parents are the dotted suffixes, so every ancestor can be read
        // at once. The walk below still follows each node's own `parent`,
        // and resolves anything the guess didn't cover.
        let mut guessed: Vec<String> = Vec::new();
        let mut name = request.agent.as_str();
        loop {
            guessed.push(name.to_owned());
            match name.split_once('.') {
                Some((_, rest)) if !rest.is_empty() => name = rest,
                _ => break,
            }
        }
        let mut prefetched: HashMap<String, Result<MandateNode, crate::MandateError>> = guessed
            .iter()
            .cloned()
            .zip(futures::future::join_all(guessed.iter().map(|n| self.resolver.resolve(n))).await)
            .collect();

        let mut chain: Vec<(String, MandateNode)> = Vec::new();
        let mut current = request.agent.clone();
        let broken = loop {
            let resolved = match prefetched.remove(&current) {
                Some(result) => result,
                None => self.resolver.resolve(&current).await,
            };
            match resolved {
                Ok(node) => {
                    let parent = node.parent.clone();
                    chain.push((current, node));
                    match parent {
                        Some(next) => current = next,
                        None => break None,
                    }
                }
                Err(crate::MandateError::AncestorExpired(dead)) => {
                    break Some(MandateViolation {
                        node: dead,
                        reason: Violation::Expired,
                    });
                }
                Err(_) => {
                    break Some(MandateViolation {
                        node: current.clone(),
                        reason: Violation::Unresolvable,
                    });
                }
            }
        };

        let path = chain
            .iter()
            .rev()
            .map(|(name, node)| MandateHop {
                name: name.clone(),
                budget: node.budget,
                expires_at: node.expires_at.format(&Rfc3339).unwrap_or_default(),
            })
            .collect();

        if let Some(violation) = broken {
            // Nothing past "is it there, is it alive" can be judged.
            let unresolvable = violation.reason == Violation::Unresolvable;
            let mut checks = vec![
                fail_or_pass("active", "Agent active", unresolvable.then_some(&violation)),
                skipped("authority", "Within authority"),
                skipped("per_call", "Within per-request limit"),
                skipped("service", "Service permitted"),
                skipped("asset", "Asset permitted"),
            ];
            checks.push(fail_or_pass(
                "expiry",
                "Authority not expired or revoked",
                (!unresolvable).then_some(&violation),
            ));
            return Decision {
                checks,
                path,
                violation: Some(violation),
            };
        }

        let now = OffsetDateTime::now_utc();
        let first = |f: &dyn Fn(&str, &MandateNode) -> Option<Violation>| {
            chain.iter().find_map(|(name, node)| {
                f(name, node).map(|reason| MandateViolation {
                    node: name.clone(),
                    reason,
                })
            })
        };

        let expiry = first(&|_, n| (n.expires_at <= now).then_some(Violation::Expired));
        let authority = first(&|name, n| {
            let used = spent.get(name).copied().unwrap_or(0);
            if request.amount > n.budget {
                Some(Violation::OverBudget { budget: n.budget })
            } else if used + request.amount > n.budget {
                Some(Violation::InsufficientAuthority {
                    budget: n.budget,
                    spent: used,
                })
            } else {
                None
            }
        });
        let per_call = first(&|_, n| {
            (request.amount > n.max_per_call).then_some(Violation::OverPerCallLimit {
                max_per_call: n.max_per_call,
            })
        });
        let service = request.service.as_ref().and_then(|service| {
            first(&|_, n| {
                (!n.allowed_services.iter().any(|s| s.eq_ignore_ascii_case(service)))
                    .then(|| Violation::ServiceNotPermitted {
                        service: service.clone(),
                    })
            })
        });
        let asset = request.asset.as_ref().and_then(|asset| {
            first(&|_, n| {
                let permitted = if n.allowed_assets.is_empty() {
                    tree_asset.is_none_or(|tree| same_asset(tree, asset))
                } else {
                    n.allowed_assets.iter().any(|a| {
                        a.eq_ignore_ascii_case(&asset.id) || a.eq_ignore_ascii_case(&asset.symbol)
                    })
                };
                (!permitted).then(|| Violation::AssetNotPermitted {
                    asset: asset.symbol.clone(),
                })
            })
        });

        let checks = vec![
            fail_or_pass("active", "Agent active", None),
            fail_or_pass("authority", "Within authority", authority.as_ref()),
            fail_or_pass("per_call", "Within per-request limit", per_call.as_ref()),
            if request.service.is_some() {
                fail_or_pass("service", "Service permitted", service.as_ref())
            } else {
                skipped("service", "Service permitted")
            },
            if request.asset.is_some() {
                fail_or_pass("asset", "Asset permitted", asset.as_ref())
            } else {
                skipped("asset", "Asset permitted")
            },
            fail_or_pass("expiry", "Authority not expired or revoked", expiry.as_ref()),
        ];

        // What's being bought is decided before how much: a forbidden service
        // is the reason, even when it's also too expensive.
        let violation = expiry.or(service).or(asset).or(authority).or(per_call);
        Decision {
            checks,
            path,
            violation,
        }
    }
}

fn same_asset(a: &AssetRef, b: &AssetRef) -> bool {
    a.id.eq_ignore_ascii_case(&b.id)
}

fn fail_or_pass(id: &'static str, label: &'static str, violation: Option<&MandateViolation>) -> Check {
    Check {
        id,
        label,
        status: if violation.is_some() {
            CheckStatus::Fail
        } else {
            CheckStatus::Pass
        },
        node: violation.map(|v| v.node.clone()),
        detail: violation.map(ToString::to_string),
    }
}

const fn skipped(id: &'static str, label: &'static str) -> Check {
    Check {
        id,
        label,
        status: CheckStatus::Skipped,
        node: None,
        detail: None,
    }
}

#[cfg(test)]
mod tests {
    use time::Duration;

    use super::*;
    use crate::MockResolver;

    fn node(budget: u64, parent: Option<&str>) -> MandateNode {
        MandateNode {
            budget,
            allowed_services: vec!["inference".into()],
            allowed_assets: Vec::new(),
            rate_per_minute: budget,
            max_per_call: budget,
            expires_at: OffsetDateTime::now_utc() + Duration::days(1),
            parent: parent.map(str::to_owned),
        }
    }

    fn three_level_tree() -> MockResolver {
        let resolver = MockResolver::new();
        resolver.set("root.eth", node(1_000, None));
        resolver.set("mid.root.eth", node(500, Some("root.eth")));
        resolver.set("leaf.mid.root.eth", node(100, Some("mid.root.eth")));
        resolver
    }

    #[tokio::test]
    async fn a_healthy_chain_authorizes_the_leaf() {
        let guard = MandateGuard::new(three_level_tree());
        let path = guard.check("leaf.mid.root.eth", 50).await.unwrap();
        assert_eq!(
            path.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(),
            vec!["root.eth", "mid.root.eth", "leaf.mid.root.eth"],
            "path is returned root first"
        );
    }

    #[tokio::test]
    async fn a_mid_chain_expiry_blocks_the_leaf_even_though_the_leaf_is_fine() {
        let resolver = three_level_tree();
        resolver.revoke("mid.root.eth");
        let guard = MandateGuard::new(resolver);

        let err = guard.check("leaf.mid.root.eth", 50).await.unwrap_err();
        assert_eq!(err.node, "mid.root.eth");
        assert_eq!(err.reason, Violation::Expired);
    }

    #[tokio::test]
    async fn revoking_the_root_blocks_every_descendant_live() {
        let resolver = three_level_tree();
        let guard = MandateGuard::new(resolver);

        // Works before the revoke.
        assert!(guard.check("leaf.mid.root.eth", 50).await.is_ok());

        // The very next check after a revoke fails — nothing was cached.
        guard.resolver.revoke("root.eth");
        let err = guard.check("leaf.mid.root.eth", 50).await.unwrap_err();
        assert_eq!(err.node, "root.eth");
        assert_eq!(err.reason, Violation::Expired);
    }

    #[tokio::test]
    async fn an_amount_over_an_ancestors_budget_is_rejected() {
        let guard = MandateGuard::new(three_level_tree());
        // Under the leaf's own 100 budget, but over the mid node's 500? No —
        // pick an amount over the *leaf's* budget to prove the leaf itself
        // is checked too, not just ancestors.
        let err = guard.check("leaf.mid.root.eth", 150).await.unwrap_err();
        assert_eq!(err.node, "leaf.mid.root.eth");
        assert_eq!(err.reason, Violation::OverBudget { budget: 100 });
    }

    fn request(amount: u64, service: &str) -> SpendRequest {
        SpendRequest {
            agent: "leaf.mid.root.eth".into(),
            amount,
            service: Some(service.into()),
            asset: Some(usdc()),
        }
    }

    fn usdc() -> AssetRef {
        AssetRef {
            id: "0.0.429274".into(),
            symbol: "USDC".into(),
        }
    }

    #[tokio::test]
    async fn an_allowed_request_passes_every_check() {
        let guard = MandateGuard::new(three_level_tree());
        let decision = guard.evaluate(&request(50, "inference"), &Spent::new(), Some(&usdc())).await;
        assert!(decision.approved());
        assert!(decision.checks.iter().all(|c| c.status == CheckStatus::Pass));
    }

    #[tokio::test]
    async fn a_service_outside_the_policy_is_the_reason_even_when_also_too_dear() {
        let guard = MandateGuard::new(three_level_tree());
        let decision = guard.evaluate(&request(150, "compute"), &Spent::new(), Some(&usdc())).await;
        let violation = decision.violation.unwrap();
        assert_eq!(violation.reason, Violation::ServiceNotPermitted { service: "compute".into() });
        let failed: Vec<_> = decision
            .checks
            .iter()
            .filter(|c| c.status == CheckStatus::Fail)
            .map(|c| c.id)
            .collect();
        assert_eq!(failed, vec!["authority", "per_call", "service"]);
    }

    #[tokio::test]
    async fn spending_so_far_counts_against_every_ancestor() {
        let guard = MandateGuard::new(three_level_tree());
        // The leaf has 100; 80 is already spent in its subtree.
        let spent = Spent::from([("leaf.mid.root.eth".to_owned(), 80)]);
        let decision = guard.evaluate(&request(30, "inference"), &spent, Some(&usdc())).await;
        let violation = decision.violation.unwrap();
        assert_eq!(violation.node, "leaf.mid.root.eth");
        assert_eq!(violation.reason, Violation::InsufficientAuthority { budget: 100, spent: 80 });

        // The mid node's own roll-up can block too.
        let spent = Spent::from([("mid.root.eth".to_owned(), 480)]);
        let decision = guard.evaluate(&request(30, "inference"), &spent, Some(&usdc())).await;
        assert_eq!(decision.violation.unwrap().node, "mid.root.eth");
    }

    #[tokio::test]
    async fn only_the_tree_asset_is_permitted_without_an_allowed_assets_record() {
        let guard = MandateGuard::new(three_level_tree());
        let mut req = request(50, "inference");
        req.asset = Some(AssetRef {
            id: "hbar".into(),
            symbol: "HBAR".into(),
        });
        let decision = guard.evaluate(&req, &Spent::new(), Some(&usdc())).await;
        assert_eq!(decision.violation.unwrap().reason, Violation::AssetNotPermitted { asset: "HBAR".into() });
    }

    #[tokio::test]
    async fn a_revoked_ancestor_skips_what_cannot_be_judged() {
        let resolver = three_level_tree();
        resolver.revoke("root.eth");
        let guard = MandateGuard::new(resolver);
        let decision = guard.evaluate(&request(50, "inference"), &Spent::new(), Some(&usdc())).await;
        let expiry = decision.checks.iter().find(|c| c.id == "expiry").unwrap();
        assert_eq!(expiry.status, CheckStatus::Fail);
        assert_eq!(expiry.node.as_deref(), Some("root.eth"));
    }

    #[tokio::test]
    async fn an_unregistered_agent_is_unresolvable() {
        let guard = MandateGuard::new(MockResolver::new());
        let err = guard.check("nobody.eth", 1).await.unwrap_err();
        assert_eq!(err.node, "nobody.eth");
        assert_eq!(err.reason, Violation::Unresolvable);
    }
}
