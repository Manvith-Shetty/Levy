//! Buyer/orchestration client: discovers a gated service's manifest, prices
//! a request, pays for it over x402 on Hedera, and calls the gated
//! endpoint — reused by the demo `agent` binary and, later, an orchestrator
//! driving several gateways at once.

pub mod client;
pub mod env;
