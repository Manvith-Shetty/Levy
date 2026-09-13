//! The policy a single mandate-tree node resolves to, and how to read one.

use time::OffsetDateTime;

/// One node's live spending policy, as read from its resolver.
#[derive(Debug, Clone)]
pub struct MandateNode {
    /// Spending budget in atomic units of whatever asset the tree is priced in.
    pub budget: u64,
    /// Services this node (and everything under it) may spend against.
    pub allowed_services: Vec<String>,
    /// Assets (token ids or symbols) this node may pay in. Empty means only
    /// the asset the tree's budgets are denominated in.
    pub allowed_assets: Vec<String>,
    /// Rate limit, in atomic units per minute.
    pub rate_per_minute: u64,
    /// Ceiling on any single call.
    pub max_per_call: u64,
    /// Absolute expiry. For the root this doubles as the World Selfie Check
    /// deadline (last attestation + 90 days) — same field, same code path.
    pub expires_at: OffsetDateTime,
    /// The parent's ENS subname, or `None` at the root of the tree.
    pub parent: Option<String>,
}

/// Why a node could not be resolved.
#[derive(Debug, thiserror::Error)]
pub enum MandateError {
    /// No such subname is registered (expired names return here too, since
    /// ENSv2 returns expired names to `AVAILABLE`).
    #[error("mandate node {0:?} not found")]
    NotFound(String),
    /// An ancestor of the queried name is registered but expired (or its
    /// subregistry pointer is gone because of it). Carries the dead
    /// ancestor's full name so the guard blames the right node instead of
    /// the leaf that merely walks through it.
    #[error("mandate ancestor {0:?} expired")]
    AncestorExpired(String),
    /// The resolver backend itself failed (RPC error, bad ABI response, …).
    #[error("resolving mandate node {node:?}: {source}")]
    Backend {
        node: String,
        #[source]
        source: anyhow::Error,
    },
}

/// Resolves one ENS subname to its live mandate policy.
///
/// `MandateGuard` re-resolves every node on every call — nothing about a
/// node's policy is cached past a single request, which is what makes a
/// revoked ancestor block the very next payment attempt.
pub trait MandateResolver: Send + Sync {
    /// Resolves `ens_name`'s current policy.
    fn resolve(
        &self,
        ens_name: &str,
    ) -> impl std::future::Future<Output = Result<MandateNode, MandateError>> + Send;
}
