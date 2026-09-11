//! In-memory resolver for tests and local demos — a stand-in for the live
//! ENSv2 `PermissionedRegistry` until it's deployed. `MandateGuard` doesn't
//! know or care which resolver it's talking to.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::resolver::{MandateError, MandateNode, MandateResolver};

/// Seeded and mutated directly by tests/demos — `set` registers or updates a
/// node, `revoke` simulates a Selfie Check lapse or an explicit revoke by
/// pulling a node's expiry into the past.
#[derive(Default)]
pub struct MockResolver {
    nodes: Mutex<HashMap<String, MandateNode>>,
}

impl MockResolver {
    /// An empty mock resolver.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers or replaces a node's policy.
    pub fn set(&self, name: impl Into<String>, node: MandateNode) {
        self.lock().insert(name.into(), node);
    }

    /// Expires `name` immediately, as of now — the same effect a lapsed
    /// Selfie Check or an on-chain revoke has on the real registry.
    pub fn revoke(&self, name: &str) {
        if let Some(node) = self.lock().get_mut(name) {
            node.expires_at = time::OffsetDateTime::UNIX_EPOCH;
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, MandateNode>> {
        self.nodes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl MandateResolver for MockResolver {
    async fn resolve(&self, ens_name: &str) -> Result<MandateNode, MandateError> {
        self.lock()
            .get(ens_name)
            .cloned()
            .ok_or_else(|| MandateError::NotFound(ens_name.to_owned()))
    }
}
