//! Shared modules for this crate's three binaries: the HTTP server
//! (`gateway`), the one-shot `create-topic` helper, and the recurring
//! `allowance-drip` task.

pub mod compute;
pub mod env;
pub mod hcs;
pub mod inference;
pub mod ledger;
pub mod mandate_guard;
pub mod ops;
pub mod quotes;
pub mod routes;
