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
    /// Reads `AGENT_ACCOUNT_ID`, `DRIP_AMOUNT_TINYBAR` (default 0.1 HBAR),
    /// and `DRIP_INTERVAL_SECS` (default 300).
    ///
    /// # Errors
    ///
    /// Returns an error when `AGENT_ACCOUNT_ID` is missing.
    pub fn from_env() -> Result<Self, String> {
        Ok(Self {
            agent_account_id: get_from_env_unsafe("AGENT_ACCOUNT_ID")?,
            amount_tinybar: get_from_env_unsafe("DRIP_AMOUNT_TINYBAR").unwrap_or(10_000_000),
            interval_secs: get_from_env_unsafe("DRIP_INTERVAL_SECS").unwrap_or(300),
        })
    }
}

/// Default one-liner for a service category.
fn describe(category: &str) -> &'static str {
    match category {
        "compute" => "GPU compute, billed per job",
        "data" => "Metered data feed, priced per query",
        _ => "LLM inference, priced per token",
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
    /// What kind of service this is (`SERVICE_CATEGORY`, default
    /// `inference`) — checked against each agent's `allowedServices`.
    pub category: String,
    /// One line describing what's sold (`SERVICE_DESCRIPTION`).
    pub description: String,
    /// Asset mandate budgets are denominated in (`MANDATE_ASSET`, default
    /// `usdc`). A payment in anything else is refused unless a node's
    /// `allowedAssets` record names it.
    pub tree_asset: AssetInfo,
    /// Mirror node used to replay the HCS topic into the spend ledger
    /// (`MIRROR_URL`, defaults to the public one for the network).
    pub mirror_url: String,
}

/// The asset `kind` (`hbar` or `usdc`) resolves to on `chain`.
fn asset_for(kind: &str, chain: HederaChainReference) -> Result<AssetInfo, String> {
    match kind.to_lowercase().as_str() {
        "hbar" => Ok(AssetInfo {
            id: "0.0.0".into(),
            symbol: "HBAR".into(),
            decimals: 8,
        }),
        "usdc" => {
            let deployment =
                USDC::on(chain).ok_or_else(|| "no USDC deployment for this network".to_owned())?;
            Ok(AssetInfo {
                id: deployment.address.to_string(),
                symbol: "USDC".into(),
                decimals: deployment.decimals,
            })
        }
        other => Err(format!("asset must be hbar or usdc, got {other}")),
    }
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

        let asset_kind: String = get_from_env_unsafe("PAYMENT_ASSET").unwrap_or_else(|_| "hbar".into());
        let asset = asset_for(&asset_kind, chain).map_err(|e| format!("PAYMENT_ASSET: {e}"))?;
        let tree_kind: String = get_from_env_unsafe("MANDATE_ASSET").unwrap_or_else(|_| "usdc".into());
        let tree_asset = asset_for(&tree_kind, chain).map_err(|e| format!("MANDATE_ASSET: {e}"))?;

        let defaults = default_pricing(asset.decimals);
        let pricing = PriceModel {
            per_1k_input: get_from_env_unsafe("INPUT_PRICE_PER_1K").unwrap_or(defaults.per_1k_input),
            per_1k_output: get_from_env_unsafe("OUTPUT_PRICE_PER_1K")
                .unwrap_or(defaults.per_1k_output),
            minimum: get_from_env_unsafe("MIN_PAYMENT").unwrap_or(defaults.minimum),
        };

        let category: String = get_from_env_unsafe::<String>("SERVICE_CATEGORY")
            .map(|c| c.trim().to_lowercase())
            .unwrap_or_else(|_| "inference".into());

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

        let pay_to: String = get_from_env_unsafe("PAYMENT_ACCOUNT_ID").map_err(|e| {
            format!("PAYMENT_ACCOUNT_ID is required (the account payments credit): {e}")
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
                .map_err(|e| format!("PAYMENT_ACCOUNT_ID: {e}"))?,
            asset,
            pricing,
            facilitator_url: get_from_env_unsafe("FACILITATOR_URL")
                .unwrap_or_else(|_| "https://api.testnet.blocky402.com".into()),
            quote_ttl_secs: get_from_env_unsafe("QUOTE_TTL_SECS").unwrap_or(180),
            hcs,
            upstream,
            description: get_from_env_unsafe("SERVICE_DESCRIPTION")
                .unwrap_or_else(|_| describe(&category).to_owned()),
            category,
            tree_asset,
            mirror_url: get_from_env_unsafe("MIRROR_URL").unwrap_or_else(|_| {
                if matches!(chain, HederaChainReference::Mainnet) {
                    "https://mainnet-public.mirrornode.hedera.com".into()
                } else {
                    "https://testnet.mirrornode.hedera.com".into()
                }
            }),
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

/// Default price schedule in atomic units of an asset with `decimals`
/// decimals: 0.001 per 1k input tokens, 0.004 per 1k output, 0.0001 floor —
/// the same human prices whether the gateway settles in HBAR or USDC.
#[must_use]
pub fn default_pricing(decimals: u8) -> PriceModel {
    let unit = 10u64.pow(u32::from(decimals));
    PriceModel {
        per_1k_input: unit / 1_000,
        per_1k_output: unit * 4 / 1_000,
        minimum: unit / 10_000,
    }
}

#[cfg(test)]
mod pricing_tests {
    use super::default_pricing;

    #[test]
    fn hbar_defaults_are_unchanged() {
        let p = default_pricing(8);
        assert_eq!((p.per_1k_input, p.per_1k_output, p.minimum), (100_000, 400_000, 10_000));
    }

    #[test]
    fn usdc_defaults_carry_the_same_human_prices() {
        let p = default_pricing(6);
        assert_eq!((p.per_1k_input, p.per_1k_output, p.minimum), (1_000, 4_000, 100));
    }
}
