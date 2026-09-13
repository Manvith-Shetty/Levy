//! Recursive ENSv2 spending-mandate resolution.
//!
//! An agent's spending authority is a namespace tree: each node is a
//! non-transferable, expiring ENSv2 subname whose resolver text records are
//! its budget. [`MandateGuard`] is the thing every x402 payment calls before
//! it settles — it walks an agent's whole ancestor chain, root to leaf,
//! re-resolving every node fresh on every call, so a revoked or expired
//! ancestor anywhere in the tree blocks the leaf immediately.

mod ens;
mod env;
mod guard;
mod mock;
mod resolver;

pub use ens::{EnsResolver, from_env, http};
pub use env::EnsEnv;
pub use guard::{
    AssetRef, Check, CheckStatus, Decision, MandateGuard, MandateViolation, SpendRequest, Spent, Violation,
};
pub use meter::MandateHop;
pub use mock::MockResolver;
pub use resolver::{MandateError, MandateNode, MandateResolver};

/// An [`EnsResolver`] over a type-erased provider — the concrete type
/// callers get back from [`http`], so they never need `alloy` as a direct
/// dependency just to hold one.
pub type SepoliaResolver = EnsResolver<alloy::providers::DynProvider>;

/// Re-exported so callers can parse a registry address without depending on
/// `alloy` themselves.
pub use alloy::primitives::Address;
