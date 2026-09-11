//! `MandateGuard` — the thing every x402 payment must clear before it settles.
//!
//! Walks an agent's ENS ancestor chain, root to leaf, re-resolving every hop
//! fresh on every call. One dead or expired ancestor anywhere in the chain
//! blocks the leaf, regardless of the leaf's own policy — nothing here is
//! cached past a single request, so a revoke reaches even a payment that was
//! already mid-flow the moment the *next* check runs.

use meter::MandateHop;
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
    /// has passed.
    Expired,
    /// The requested amount exceeds this node's spending budget.
    OverBudget { budget: u64 },
    /// The requested amount exceeds this node's per-call ceiling.
    OverPerCallLimit { max_per_call: u64 },
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
        match &self.reason {
            Violation::Unresolvable => write!(f, "mandate node {:?} could not be resolved", self.node),
            Violation::Expired => write!(f, "mandate node {:?} has expired", self.node),
            Violation::OverBudget { budget } => {
                write!(f, "mandate node {:?} budget {budget} exceeded", self.node)
            }
            Violation::OverPerCallLimit { max_per_call } => write!(
                f,
                "mandate node {:?} per-call limit {max_per_call} exceeded",
                self.node
            ),
        }
    }
}

impl std::error::Error for MandateViolation {}

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

    /// Checks whether `agent` may spend `amount` right now.
    ///
    /// Resolves `agent`, then its parent, and so on up to the root, checking
    /// every hop before allowing anything through — a violation on any
    /// ancestor blocks the leaf even if the leaf's own policy is fine.
    ///
    /// # Errors
    ///
    /// The first [`MandateViolation`] found, walking from the agent upward.
    pub async fn check(
        &self,
        agent: &str,
        amount: u64,
    ) -> Result<Vec<MandateHop>, MandateViolation> {
        let mut chain: Vec<(String, MandateNode)> = Vec::new();
        let mut current = agent.to_owned();
        loop {
            let node = match self.resolver.resolve(&current).await {
                Ok(node) => node,
                Err(crate::MandateError::AncestorExpired(dead)) => {
                    return Err(MandateViolation {
                        node: dead,
                        reason: Violation::Expired,
                    });
                }
                Err(_) => {
                    return Err(MandateViolation {
                        node: current.clone(),
                        reason: Violation::Unresolvable,
                    });
                }
            };
            let parent = node.parent.clone();
            chain.push((current, node));
            match parent {
                Some(next) => current = next,
                None => break,
            }
        }

        let now = OffsetDateTime::now_utc();
        for (name, node) in &chain {
            if node.expires_at <= now {
                return Err(MandateViolation {
                    node: name.clone(),
                    reason: Violation::Expired,
                });
            }
            if amount > node.budget {
                return Err(MandateViolation {
                    node: name.clone(),
                    reason: Violation::OverBudget { budget: node.budget },
                });
            }
            if amount > node.max_per_call {
                return Err(MandateViolation {
                    node: name.clone(),
                    reason: Violation::OverPerCallLimit {
                        max_per_call: node.max_per_call,
                    },
                });
            }
        }

        Ok(chain
            .into_iter()
            .rev()
            .map(|(name, node)| MandateHop {
                name,
                budget: node.budget,
                expires_at: node
                    .expires_at
                    .format(&Rfc3339)
                    .unwrap_or_else(|_| String::new()),
            })
            .collect())
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

    #[tokio::test]
    async fn an_unregistered_agent_is_unresolvable() {
        let guard = MandateGuard::new(MockResolver::new());
        let err = guard.check("nobody.eth", 1).await.unwrap_err();
        assert_eq!(err.node, "nobody.eth");
        assert_eq!(err.reason, Violation::Unresolvable);
    }
}
