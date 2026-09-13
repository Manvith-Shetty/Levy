//! Reads a subname's live mandate policy from a real ENSv2 hierarchy on Sepolia.
//!
//! The tree lives across one [`PermissionedRegistry`](https://docs.ens.domains/ensv2/permissioned-registry)
//! per level (e.g. `root` in L1, `agent` in L2, `sub` in L3), linked by
//! `setSubregistry` pointers. This reader walks DOWN from the configured
//! top-level registry following those pointers, so a name only resolves when
//! the on-chain hierarchy actually contains it — no string-splitting
//! shortcuts, no hardcoded level addresses.
//!
//! Per level, two reads: `getExpiry(labelhash)` first, then `getResolver(label)`
//! for the `PermissionedResolver` holding that name's records. Policy comes
//! from ENSIP-5 `text(node, key)` records for `budget`, `allowedServices`,
//! `ratePerMinute`, `maxPerCall`, keyed by the full name's namehash.
//!
//! Dead ancestors are attributed precisely: a missing pointer or resolver on
//! a never-registered name is `NotFound`; an expired entry surfaces as
//! `AncestorExpired` carrying the dead ancestor's full name, so
//! [`MandateGuard`](crate::MandateGuard) blames `root` — not the leaf that
//! merely walks through it.

use alloy::primitives::{Address, B256, U256, keccak256};
use alloy::providers::{DynProvider, Provider, ProviderBuilder};
use alloy::sol;
use alloy::transports::http::reqwest::Url;
use time::OffsetDateTime;

use crate::resolver::{MandateError, MandateNode, MandateResolver};

sol! {
    #[sol(rpc)]
    interface IRegistry {
        function getSubregistry(string calldata label) external view returns (address);
        function getResolver(string calldata label) external view returns (address);
        function getExpiry(uint256 anyId) external view returns (uint64);
    }

    #[sol(rpc)]
    interface IPermissionedResolver {
        function text(bytes32 node, string calldata key) external view returns (string memory);
    }
}

/// Resolves mandate policy from a live ENSv2 hierarchy over any [`Provider`].
#[derive(Clone)]
pub struct EnsResolver<P> {
    provider: P,
    /// Registry holding the TOP of our namespace (level holding `root`).
    /// Deeper levels are discovered by walking `getSubregistry` pointers,
    /// so only this one address is ever configured.
    top_registry: Address,
}

impl<P: Provider + Clone> EnsResolver<P> {
    /// Builds a resolver against `top_registry` using an already-constructed
    /// provider.
    pub const fn new(provider: P, top_registry: Address) -> Self {
        Self {
            provider,
            top_registry,
        }
    }
}

/// Builds an [`EnsResolver`] over a plain HTTP JSON-RPC endpoint.
///
/// The provider is type-erased ([`DynProvider`]) so `EnsResolver<DynProvider>`
/// is a single, nameable type regardless of transport — the same type
/// [`MandateGuard`](crate::MandateGuard) can be built against whether the
/// gateway picks it at compile time or at runtime from configuration.
#[must_use]
pub fn http(rpc_url: Url, top_registry: Address) -> EnsResolver<DynProvider> {
    let provider = ProviderBuilder::new().connect_http(rpc_url).erased();
    EnsResolver::new(provider, top_registry)
}

/// Builds an [`EnsResolver`] straight from [`EnsEnv::from_env`](crate::EnsEnv::from_env)
/// — `SEPOLIA_RPC_URL` and `MANDATE_REGISTRY_ADDRESS`.
///
/// # Errors
///
/// Returns an error when either variable is missing or fails to parse.
pub fn from_env() -> Result<EnsResolver<DynProvider>, String> {
    let env = crate::EnsEnv::from_env()?;
    Ok(http(env.rpc_url, env.registry))
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

/// Labelhash as the `anyId` the registry's expiry views accept.
fn labelhash(label: &str) -> U256 {
    U256::from_be_bytes(keccak256(label.as_bytes()).0)
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
        let labels: Vec<&str> = ens_name.split('.').collect();
        if labels.iter().any(|l| l.is_empty()) {
            return Err(MandateError::NotFound(ens_name.to_owned()));
        }

        // Walk down: top registry holds the last label; each getSubregistry
        // pointer leads to the registry holding the next label down. A zero
        // pointer means the ancestor at this level is gone: never-registered
        // (expiry 0) is NotFound, an expired entry names its ancestor.
        let mut registry_addr = self.top_registry;
        for depth in (1..labels.len()).rev() {
            let reg = IRegistry::new(registry_addr, self.provider.clone());
            let next = reg
                .getSubregistry(labels[depth].to_owned())
                .call()
                .await
                .map_err(|e| backend(ens_name, e))?;
            if next.is_zero() {
                let ancestor = labels[depth..].join(".");
                let expiry = reg
                    .getExpiry(labelhash(labels[depth]))
                    .call()
                    .await
                    .map_err(|e| backend(ens_name, e))?;
                if expiry == 0 {
                    return Err(MandateError::NotFound(ens_name.to_owned()));
                }
                return Err(MandateError::AncestorExpired(ancestor));
            }
            registry_addr = next;
        }

        let leaf = labels[0];
        let reg = IRegistry::new(registry_addr, self.provider.clone());
        // Expiry and resolver in one round trip. Expiry is judged first: an
        // expired leaf must report Expired even though its resolver reads
        // back as zero (expired entries resolve to address(0)).
        let expiry_call = reg.getExpiry(labelhash(leaf));
        let resolver_call = reg.getResolver(leaf.to_owned());
        let (leaf_expiry, resolver_address) = tokio::join!(expiry_call.call(), resolver_call.call());
        let leaf_expiry = leaf_expiry.map_err(|e| backend(ens_name, e))?;
        if leaf_expiry == 0 {
            return Err(MandateError::NotFound(ens_name.to_owned()));
        }
        let now = OffsetDateTime::now_utc();
        let leaf_expires_at = OffsetDateTime::from_unix_timestamp(
            i64::try_from(leaf_expiry).map_err(|e| backend(ens_name, e))?,
        )
        .map_err(|e| backend(ens_name, e))?;
        if leaf_expires_at <= now {
            return Err(MandateError::AncestorExpired(ens_name.to_owned()));
        }

        let resolver_address = resolver_address.map_err(|e| backend(ens_name, e))?;
        if resolver_address.is_zero() {
            return Err(MandateError::NotFound(ens_name.to_owned()));
        }
        let expires_at = leaf_expires_at;

        let node = namehash(ens_name);
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

        // Every record in one round trip.
        let (budget, rate_per_minute, max_per_call, allowed_services, allowed_assets) = tokio::join!(
            text("budget"),
            text("ratePerMinute"),
            text("maxPerCall"),
            text("allowedServices"),
            text("allowedAssets")
        );
        let budget: u64 = budget?
            .parse()
            .map_err(|e| backend(ens_name, anyhow::anyhow!("bad budget record: {e}")))?;
        let rate_per_minute: u64 = rate_per_minute?
            .parse()
            .map_err(|e| backend(ens_name, anyhow::anyhow!("bad ratePerMinute record: {e}")))?;
        let max_per_call: u64 = max_per_call?
            .parse()
            .map_err(|e| backend(ens_name, anyhow::anyhow!("bad maxPerCall record: {e}")))?;
        let list = |raw: String| -> Vec<String> {
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        };
        let allowed_services = list(allowed_services?);
        // Optional: names minted before it existed simply don't have it.
        let allowed_assets = list(allowed_assets.unwrap_or_default());

        Ok(MandateNode {
            budget,
            allowed_services,
            allowed_assets,
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
        assert_eq!(parent_of("leaf.mid.root"), Some("mid.root".to_owned()));
        assert_eq!(parent_of("root"), None);
    }

    #[test]
    fn labelhash_matches_keccak_of_the_label() {
        let expected = U256::from_be_bytes(keccak256("agent".as_bytes()).0);
        assert_eq!(labelhash("agent"), expected);
    }
}
