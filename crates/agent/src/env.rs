//! Environment configuration for the demo `agent` binary.

use common::utils::get_from_env_unsafe;

/// What the demo `agent` binary needs to run one purchase.
#[derive(Debug, Clone)]
pub struct AgentEnv {
    /// Buyer account id.
    pub account_id: String,
    /// Buyer private key.
    pub private_key: String,
    /// Gateway base URLs to shop against.
    pub providers: Vec<String>,
    /// Prompt to price and run.
    pub prompt: String,
    /// Output budget to quote for.
    pub max_output_tokens: u64,
    /// Ceiling this run will pay, in atomic units.
    pub budget_atomic: u64,
    /// ENS subname this agent spends against — must resolve under the
    /// gateway's mandate tree.
    pub agent_ens_name: String,
}

impl AgentEnv {
    /// Reads `HEDERA_ACCOUNT_ID`, `HEDERA_PRIVATE_KEY`, and
    /// `AGENT_ENS_NAME` (required), plus `PROVIDERS`, `PROMPT`,
    /// `MAX_OUTPUT_TOKENS`, and `BUDGET_ATOMIC` (all defaulted).
    ///
    /// # Errors
    ///
    /// Returns an error when a required variable is missing.
    pub fn from_env() -> Result<Self, String> {
        let providers: String =
            get_from_env_unsafe("PROVIDERS").unwrap_or_else(|_| "http://localhost:4021".into());

        Ok(Self {
            account_id: get_from_env_unsafe("HEDERA_ACCOUNT_ID")?,
            private_key: get_from_env_unsafe("HEDERA_PRIVATE_KEY")?,
            providers: providers
                .split(',')
                .map(|s| s.trim().trim_end_matches('/').to_owned())
                .filter(|s| !s.is_empty())
                .collect(),
            prompt: get_from_env_unsafe("PROMPT")
                .unwrap_or_else(|_| "Explain Hedera's hashgraph consensus in three sentences.".into()),
            max_output_tokens: get_from_env_unsafe("MAX_OUTPUT_TOKENS").unwrap_or(128),
            budget_atomic: get_from_env_unsafe("BUDGET_ATOMIC").unwrap_or(50_000_000),
            agent_ens_name: get_from_env_unsafe("AGENT_ENS_NAME")?,
        })
    }
}
