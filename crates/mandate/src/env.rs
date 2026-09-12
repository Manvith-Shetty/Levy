//! Environment configuration for resolving mandates against the live ENSv2
//! registry — only needed when the gateway runs with `MANDATE_MODE=ens`.

use alloy::transports::http::reqwest::Url;
use common::utils::get_from_env_unsafe;

use crate::Address;

/// What's needed to read mandate policy from a live registry on Sepolia.
#[derive(Debug, Clone)]
pub struct EnsEnv {
    /// Sepolia JSON-RPC endpoint.
    pub rpc_url: Url,
    /// The deployed `PermissionedRegistry` address.
    pub registry: Address,
}

impl EnsEnv {
    /// Reads `SEPOLIA_RPC_URL` and `MANDATE_REGISTRY_ADDRESS`.
    ///
    /// # Errors
    ///
    /// Returns an error when either variable is missing or fails to parse.
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            rpc_url: get_from_env_unsafe("SEPOLIA_RPC_URL")?,
            registry: get_from_env_unsafe("MANDATE_REGISTRY_ADDRESS")?,
        })
    }
}
