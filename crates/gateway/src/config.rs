//! Environment-driven provider configuration.

use anyhow::{Context, Result, bail};
use meter::{AssetInfo, PriceModel};
use r402_hedera::chain::{HederaAddress, HederaChainReference, HederaTokenDeployment};
use r402_hedera::{HBAR, USDC};
use url::Url;

/// Credentials the provider uses to write receipts to HCS.
#[derive(Debug, Clone)]
pub struct HcsConfig {
    /// Operator account that pays for topic submissions.
    pub operator_id: String,
    /// Operator private key (DER or hex; ECDSA or Ed25519).
    pub operator_key: String,
    /// Topic receipts are published to.
    pub topic_id: String,
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

/// Everything one provider instance needs to run.
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

fn var(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

fn parsed<T: std::str::FromStr>(key: &str, default: T) -> Result<T>
where
    T::Err: std::fmt::Display,
{
    match var(key) {
        None => Ok(default),
        Some(raw) => raw
            .parse()
            .map_err(|e| anyhow::anyhow!("{key}: {e}"))
            .context("invalid environment value"),
    }
}

impl Config {
    /// Reads configuration from the process environment.
    ///
    /// # Errors
    ///
    /// Returns an error when a required variable is missing or a value does not
    /// parse.
    pub fn from_env() -> Result<Self> {
        let network = var("HEDERA_NETWORK").unwrap_or_else(|| "testnet".into());
        let (chain, caip2) = match network.as_str() {
            "testnet" | "hedera:testnet" => (HederaChainReference::Testnet, "hedera:testnet"),
            "mainnet" | "hedera:mainnet" => (HederaChainReference::Mainnet, "hedera:mainnet"),
            other => bail!("HEDERA_NETWORK must be testnet or mainnet, got {other}"),
        };

        let asset_kind = var("ASSET").unwrap_or_else(|| "hbar".into()).to_lowercase();
        let asset = match asset_kind.as_str() {
            "hbar" => AssetInfo {
                id: "0.0.0".into(),
                symbol: "HBAR".into(),
                decimals: 8,
            },
            "usdc" => {
                let deployment = USDC::on(chain).context("no USDC deployment for this network")?;
                AssetInfo {
                    id: deployment.address.to_string(),
                    symbol: "USDC".into(),
                    decimals: deployment.decimals,
                }
            }
            other => bail!("ASSET must be hbar or usdc, got {other}"),
        };

        // Defaults are tuned for HBAR (8 decimals): 0.001 HBAR per 1k input
        // tokens, 0.004 per 1k output, 0.0001 floor.
        let pricing = PriceModel {
            per_1k_input: parsed("PRICE_PER_1K_INPUT", 100_000_u64)?,
            per_1k_output: parsed("PRICE_PER_1K_OUTPUT", 400_000_u64)?,
            minimum: parsed("PRICE_MINIMUM", 10_000_u64)?,
        };

        let port = parsed("PORT", 4021_u16)?;
        let base_url = var("BASE_URL").unwrap_or_else(|| format!("http://localhost:{port}"));

        let hcs = match (
            var("HEDERA_OPERATOR_ID"),
            var("HEDERA_OPERATOR_KEY"),
            var("HCS_TOPIC_ID"),
        ) {
            (Some(operator_id), Some(operator_key), Some(topic_id)) => Some(HcsConfig {
                operator_id,
                operator_key,
                topic_id,
            }),
            _ => None,
        };

        let pay_to = var("HEDERA_PAY_TO_ACCOUNT_ID")
            .context("HEDERA_PAY_TO_ACCOUNT_ID is required (the account payments credit)")?;

        let upstream = var("OPENAI_BASE_URL").map(|base_url| Upstream {
            base_url,
            model: var("OPENAI_MODEL").unwrap_or_else(|| "local-model".into()),
            api_key: var("OPENAI_API_KEY"),
        });

        Ok(Self {
            provider: var("PROVIDER_NAME").unwrap_or_else(|| "provider-a".into()),
            model: upstream
                .as_ref()
                .map_or_else(|| var("MODEL").unwrap_or_else(|| "echo-1".into()), |u| u.model.clone()),
            port,
            base_url: Url::parse(&base_url).context("BASE_URL must be a valid URL")?,
            network: caip2.to_owned(),
            chain,
            pay_to: pay_to.clone(),
            pay_to_address: pay_to
                .parse()
                .map_err(|e| anyhow::anyhow!("HEDERA_PAY_TO_ACCOUNT_ID: {e}"))?,
            asset,
            pricing,
            facilitator_url: var("FACILITATOR_URL")
                .unwrap_or_else(|| "https://api.testnet.blocky402.com".into()),
            quote_ttl_secs: parsed("QUOTE_TTL_SECS", 180_u64)?,
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
