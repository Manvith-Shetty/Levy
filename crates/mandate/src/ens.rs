//! Reads a subname's live mandate policy straight from an ENSv2
//! `PermissionedRegistry` deployment on Sepolia.
//!
//! Two calls per node: the registry's `resolver(bytes32)` to find the
//! `PermissionedResolver`, then that resolver's ENSIP-5 `text(bytes32,string)`
//! for each policy field. Both are part of the stable, standard interface the
//! Model doc commits to regardless of the registrar's own custom logic.
//!
//! `expiryOf` is a placeholder for the `PermissionedRegistry`'s native
//! absolute-expiry read — point it at the real function name once that
//! contract is deployed; everything else in this module is unaffected.

use alloy::primitives::{Address, B256, keccak256};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::sol;
use alloy::transports::http::reqwest::Url;
use time::OffsetDateTime;

use crate::resolver::{MandateError, MandateNode, MandateResolver};

sol! {
    #[sol(rpc)]
    interface IEnsRegistry {
        function resolver(bytes32 node) external view returns (address);
        function expiryOf(bytes32 node) external view returns (uint64);
    }

    #[sol(rpc)]
    interface IPermissionedResolver {
        function text(bytes32 node, string calldata key) external view returns (string memory);
    }
}

/// Resolves mandate policy from a live ENSv2 registry over any [`Provider`].
#[derive(Clone)]
pub struct EnsResolver<P> {
    provider: P,
    registry: Address,
}

impl<P: Provider + Clone> EnsResolver<P> {
    /// Builds a resolver against `registry` using an already-constructed
    /// provider.
    pub const fn new(provider: P, registry: Address) -> Self {
        Self { provider, registry }
    }
}

/// Builds an [`EnsResolver`] over a plain HTTP JSON-RPC endpoint.
///
/// The provider is type-erased ([`DynProvider`]) so `EnsResolver<DynProvider>`
/// is a single, nameable type regardless of transport — the same type
/// [`MandateGuard`](crate::MandateGuard) can be built against whether the
/// gateway picks it at compile time or at runtime from configuration.
#[must_use]
pub fn http(rpc_url: Url, registry: Address) -> EnsResolver<DynProvider> {
    let provider = ProviderBuilder::new().connect_http(rpc_url).erased();
    EnsResolver::new(provider, registry)
}

/// ENSIP-1 namehash.
fn namehash(name: &str) -> B256 {
    if name.is_empty() {
        return B256::ZERO;
    }
    name.split('.').rev().fold(B256::ZERO, |node, label| {
        let label_hash = keccak256(label.as_bytes());
        keccak256([node.as_slice(), label_hash.as_slice()].concat())
    })
}

/// Strips the leftmost label to get the parent name, or `None` at the root.
fn parent_of(name: &str) -> Option<String> {
    name.split_once('.').map(|(_, rest)| rest.to_owned())
}

fn backend(node: &str, error: impl Into<anyhow::Error>) -> MandateError {
    MandateError::Backend {
        node: node.to_owned(),
        source: error.into(),
    }
}

impl<P: Provider + Clone> MandateResolver for EnsResolver<P> {
    async fn resolve(&self, ens_name: &str) -> Result<MandateNode, MandateError> {
        let node = namehash(ens_name);
        let registry = IEnsRegistry::new(self.registry, self.provider.clone());

        let resolver_address = registry
            .resolver(node)
            .call()
            .await
            .map_err(|e| backend(ens_name, e))?;
        if resolver_address.is_zero() {
            return Err(MandateError::NotFound(ens_name.to_owned()));
        }

        let expiry = registry
            .expiryOf(node)
            .call()
            .await
            .map_err(|e| backend(ens_name, e))?;
        let expires_at = OffsetDateTime::from_unix_timestamp(
            i64::try_from(expiry).map_err(|e| backend(ens_name, e))?,
        )
        .map_err(|e| backend(ens_name, e))?;

        let resolver = IPermissionedResolver::new(resolver_address, self.provider.clone());
        let text = |key: &'static str| {
            let resolver = &resolver;
            async move {
                resolver
                    .text(node, key.to_owned())
                    .call()
                    .await
                    .map_err(|e| backend(ens_name, e))
            }
        };

        let budget: u64 = text("budget")
            .await?
            .parse()
            .map_err(|e| backend(ens_name, anyhow::anyhow!("bad budget record: {e}")))?;
        let rate_per_minute: u64 = text("ratePerMinute")
            .await?
            .parse()
            .map_err(|e| backend(ens_name, anyhow::anyhow!("bad ratePerMinute record: {e}")))?;
        let max_per_call: u64 = text("maxPerCall")
            .await?
            .parse()
            .map_err(|e| backend(ens_name, anyhow::anyhow!("bad maxPerCall record: {e}")))?;
        let allowed_services = text("allowedServices")
            .await?
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned)
            .collect();

        Ok(MandateNode {
            budget,
            allowed_services,
            rate_per_minute,
            max_per_call,
            expires_at,
            parent: parent_of(ens_name),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namehash_of_the_empty_name_is_zero() {
        assert_eq!(namehash(""), B256::ZERO);
    }

    #[test]
    fn namehash_matches_the_known_eth_tld_value() {
        // Canonical ENSIP-1 test vector.
        let expected: B256 =
            "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae"
                .parse()
                .unwrap();
        assert_eq!(namehash("eth"), expected);
    }

    #[test]
    fn parent_of_strips_one_label_at_a_time() {
        assert_eq!(parent_of("leaf.mid.root.eth"), Some("mid.root.eth".to_owned()));
        assert_eq!(parent_of("root.eth"), Some("eth".to_owned()));
        assert_eq!(parent_of("eth"), None);
    }
}
