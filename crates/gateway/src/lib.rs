//! Shared modules for this crate's three binaries: the HTTP server
//! (`gateway`), the one-shot `create-topic` helper, and the recurring
//! `allowance-drip` task.

pub mod env;
pub mod hcs;
pub mod inference;
pub mod mandate_guard;
pub mod quotes;
pub mod routes;
