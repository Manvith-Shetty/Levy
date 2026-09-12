//! Environment-driven configuration for every binary in this crate.

use common::utils::get_from_env_unsafe;
use meter::{AssetInfo, PriceModel};
use r402_hedera::chain::{HederaAddress, HederaChainReference, HederaTokenDeployment};
use r402_hedera::{HBAR, USDC};
use url::Url;

/// Which mandate resolver backs `/v1/infer`'s guard.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MandateMode {
    /// In-memory resolver, driven live via `POST /v1/mandate/*` — no
    /// deployed registry needed. The default.
    Mock,
    /// The live ENSv2 registry on Sepolia (see [`mandate::EnsEnv`]).
    Ens,
    /// The guard is disabled entirely; every request passes.
    Off,
}

impl MandateMode {
    /// Reads `MANDATE_MODE`, defaulting to [`Self::Mock`] on anything else.
    #[must_use]
    pub fn from_env() -> Self {
        match get_from_env_unsafe::<String>("MANDATE_MODE")
            .unwrap_or_else(|_| "mock".to_owned())
            .as_str()
        {
            "off" => Self::Off,
            "ens" => Self::Ens,
            _ => Self::Mock,
        }
    }
}

/// Credentials the gateway uses to write receipts to HCS.
#[derive(Debug, Clone)]
pub struct HcsConfig {
    /// Operator account that pays for topic submissions.
    pub operator_id: String,
    /// Operator private key (DER or hex; ECDSA or Ed25519).
    pub operator_key: String,
    /// Topic receipts are published to.
    pub topic_id: String,
}

/// Operator credentials for anything that submits its own Hedera
/// transaction rather than going through x402/Blocky402 — the `create-topic`
/// and `allowance-drip` binaries.
#[derive(Debug, Clone)]
pub struct OperatorEnv {
    /// `testnet` or `mainnet`.
    pub network: String,
    /// Account paying for and signing the transaction.
    pub operator_id: String,
    /// Operator private key (DER or hex; ECDSA or Ed25519).
    pub operator_key: String,
}

impl OperatorEnv {
    /// Reads `HEDERA_NETWORK` (default `testnet`), `HEDERA_OPERATOR_ID`, and
    /// `HEDERA_OPERATOR_KEY`.
    ///
    /// # Errors
    ///
    /// Returns an error when an operator credential is missing.
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            network: get_from_env_unsafe("HEDERA_NETWORK").unwrap_or_else(|_| "testnet".into()),
            operator_id: get_from_env_unsafe("HEDERA_OPERATOR_ID")?,
            operator_key: get_from_env_unsafe("HEDERA_OPERATOR_KEY")?,
        })
    }
}

/// What the `allowance-drip` binary needs beyond [`OperatorEnv`].
#[derive(Debug, Clone)]
pub struct DripEnv {
    /// Account credited by each drip.
    pub agent_account_id: String,
    /// Tinybar credited per drip.
    pub amount_tinybar: i64,
    /// Seconds between drips.
    pub interval_secs: u64,
}

impl DripEnv {
    /// Reads `DRIP_AGENT_ACCOUNT_ID`, `DRIP_AMOUNT_TINYBAR` (default 0.1
    /// HBAR), and `DRIP_INTERVAL_SECS` (default 300).
    ///
    /// # Errors
    ///
    /// Returns an error when `DRIP_AGENT_ACCOUNT_ID` is missing.
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            agent_account_id: get_from_env_unsafe("DRIP_AGENT_ACCOUNT_ID")?,
            amount_tinybar: get_from_env_unsafe("DRIP_AMOUNT_TINYBAR").unwrap_or(10_000_000),
            interval_secs: get_from_env_unsafe("DRIP_INTERVAL_SECS").unwrap_or(300),
        })
    }
}

/// Optional OpenAI-compatible upstream (LM Studio, Ollama, vLLM, …).
#[derive(Debug, Clone)]
pub struct Upstream {
    /// Base URL including `/v1`.
    pub base_url: String,
    /// Model name as the upstream knows it.
    pub model: String,
    /// Bearer token, if the upstream wants one.
    pub api_key: Option<String>,
}

/// Everything the gateway server needs to run.
#[derive(Debug, Clone)]
pub struct Config {
    /// Display name, also used in receipts.
    pub provider: String,
    /// Model name advertised on the manifest.
    pub model: String,
    /// Port to bind.
    pub port: u16,
    /// Public origin used to build `ResourceInfo.url` on 402 responses.
    pub base_url: Url,
    /// CAIP-2 network, e.g. `hedera:testnet`.
    pub network: String,
    /// Hedera chain reference matching `network`.
    pub chain: HederaChainReference,
    /// Account credited by each payment.
    pub pay_to: String,
    /// The same account, parsed for price-tag construction.
    pub pay_to_address: HederaAddress,
    /// Asset prices are denominated in.
    pub asset: AssetInfo,
    /// Published per-token price schedule.
    pub pricing: PriceModel,
    /// Facilitator base URL.
    pub facilitator_url: String,
    /// How long a quote stays redeemable.
    pub quote_ttl_secs: u64,
    /// HCS receipt configuration, when enabled.
    pub hcs: Option<HcsConfig>,
    /// Upstream model server, when configured.
    pub upstream: Option<Upstream>,
}

impl Config {
    /// Reads configuration from the process environment.
    ///
    /// # Errors
    ///
    /// Returns an error when a required variable is missing or a value does
    /// not parse.
    pub fn from_env() -> Result<Self, String> {
        let network: String =
            get_from_env_unsafe("HEDERA_NETWORK").unwrap_or_else(|_| "testnet".into());
        let (chain, caip2) = match network.as_str() {
            "testnet" | "hedera:testnet" => (HederaChainReference::Testnet, "hedera:testnet"),
            "mainnet" | "hedera:mainnet" => (HederaChainReference::Mainnet, "hedera:mainnet"),
            other => return Err(format!("HEDERA_NETWORK must be testnet or mainnet, got {other}")),
        };

        let asset_kind: String = get_from_env_unsafe("ASSET").unwrap_or_else(|_| "hbar".into());
        let asset = match asset_kind.to_lowercase().as_str() {
            "hbar" => AssetInfo {
                id: "0.0.0".into(),
                symbol: "HBAR".into(),
                decimals: 8,
            },
            "usdc" => {
                let deployment = USDC::on(chain)
                    .ok_or_else(|| "no USDC deployment for this network".to_owned())?;
                AssetInfo {
                    id: deployment.address.to_string(),
                    symbol: "USDC".into(),
                    decimals: deployment.decimals,
                }
            }
            other => return Err(format!("ASSET must be hbar or usdc, got {other}")),
        };

        // Defaults are tuned for HBAR (8 decimals): 0.001 HBAR per 1k input
        // tokens, 0.004 per 1k output, 0.0001 floor.
        let pricing = PriceModel {
            per_1k_input: get_from_env_unsafe("PRICE_PER_1K_INPUT").unwrap_or(100_000_u64),
            per_1k_output: get_from_env_unsafe("PRICE_PER_1K_OUTPUT").unwrap_or(400_000_u64),
            minimum: get_from_env_unsafe("PRICE_MINIMUM").unwrap_or(10_000_u64),
        };

        let port: u16 = get_from_env_unsafe("PORT").unwrap_or(4021);
        let base_url: String = get_from_env_unsafe("BASE_URL")
            .unwrap_or_else(|_| format!("http://localhost:{port}"));

        let hcs = match (
            get_from_env_unsafe::<String>("HEDERA_OPERATOR_ID"),
            get_from_env_unsafe::<String>("HEDERA_OPERATOR_KEY"),
            get_from_env_unsafe::<String>("HCS_TOPIC_ID"),
        ) {
            (Ok(operator_id), Ok(operator_key), Ok(topic_id)) => Some(HcsConfig {
                operator_id,
                operator_key,
                topic_id,
            }),
            _ => None,
        };

        let pay_to: String = get_from_env_unsafe("HEDERA_PAY_TO_ACCOUNT_ID").map_err(|e| {
            format!("HEDERA_PAY_TO_ACCOUNT_ID is required (the account payments credit): {e}")
        })?;

        let upstream = get_from_env_unsafe::<String>("OPENAI_BASE_URL")
            .ok()
            .map(|base_url| Upstream {
                base_url,
                model: get_from_env_unsafe("OPENAI_MODEL").unwrap_or_else(|_| "local-model".into()),
                api_key: get_from_env_unsafe("OPENAI_API_KEY").ok(),
            });

        Ok(Self {
            provider: get_from_env_unsafe("PROVIDER_NAME").unwrap_or_else(|_| "provider-a".into()),
            model: upstream.as_ref().map_or_else(
                || get_from_env_unsafe("MODEL").unwrap_or_else(|_| "echo-1".into()),
                |u| u.model.clone(),
            ),
            port,
            base_url: Url::parse(&base_url).map_err(|e| format!("BASE_URL must be a valid URL: {e}"))?,
            network: caip2.to_owned(),
            chain,
            pay_to: pay_to.clone(),
            pay_to_address: pay_to
                .parse()
                .map_err(|e| format!("HEDERA_PAY_TO_ACCOUNT_ID: {e}"))?,
            asset,
            pricing,
            facilitator_url: get_from_env_unsafe("FACILITATOR_URL")
                .unwrap_or_else(|_| "https://api.testnet.blocky402.com".into()),
            quote_ttl_secs: get_from_env_unsafe("QUOTE_TTL_SECS").unwrap_or(180),
            hcs,
            upstream,
        })
    }

    /// The r402 token deployment matching the configured asset and network.
    #[must_use]
    pub fn deployment(&self) -> &'static HederaTokenDeployment {
        let mainnet = matches!(self.chain, HederaChainReference::Mainnet);
        match (self.asset.id.as_str(), mainnet) {
            ("0.0.0", true) => HBAR::hedera(),
            ("0.0.0", false) => HBAR::hedera_testnet(),
            (_, true) => USDC::hedera(),
            (_, false) => USDC::hedera_testnet(),
        }
    }

    /// Absolute URL of the free quoting endpoint.
    #[must_use]
    pub fn quote_url(&self) -> String {
        format!("{}v1/quote", self.base_url)
    }

    /// Absolute URL of the x402-gated endpoint.
    #[must_use]
    pub fn infer_url(&self) -> String {
        format!("{}v1/infer", self.base_url)
    }
}
