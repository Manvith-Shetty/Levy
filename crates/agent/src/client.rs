//! The buyer side of the protocol: discovery, quoting, payment, and calling
//! the gated endpoint — one `Client`, reusable against any number of gateway
//! URLs, each potentially gated by a different mandate.

use std::str::FromStr;

use anyhow::{Context, Result, bail};
use base64::prelude::{BASE64_STANDARD, Engine as _};
use hedera::{AccountId, PrivateKey};
use meter::{InferResponse, QuoteRequest, QuoteResponse, ServiceManifest};
use r402_client::{AllowedAssets, MaxAmountPerPayment, SpendControlAsset, SpendControls};
use r402_hedera::{HederaExactClient, HederaSigner};
use r402_http::{WithPayments, X402Client};

/// A funded Hedera identity a [`Client`] pays with.
#[derive(Clone)]
pub struct Wallet {
    /// Account the payment is signed and sent from.
    pub account_id: AccountId,
    /// The account's private key.
    pub private_key: PrivateKey,
}

impl Wallet {
    /// Parses a Hedera account id and private key (DER, hex, ECDSA, or
    /// Ed25519 — whichever the string is).
    ///
    /// # Errors
    ///
    /// Returns an error when either value fails to parse.
    pub fn new(account_id: &str, private_key: &str) -> Result<Self> {
        Ok(Self {
            account_id: AccountId::from_str(account_id).context("invalid account id")?,
            private_key: parse_private_key(private_key)?,
        })
    }
}

/// A provider's manifest plus a quote priced against one specific request.
#[derive(Debug, Clone)]
pub struct Offer {
    /// What the provider is and how it prices.
    pub manifest: ServiceManifest,
    /// The price this specific request was metered at.
    pub quote: QuoteResponse,
}

/// Settlement details the gateway echoes back on a successful payment.
#[derive(Debug, Clone)]
pub struct Settlement {
    /// Hedera transaction id the payment settled as.
    pub transaction: String,
    /// CAIP-2 network it settled on.
    pub network: String,
    /// Account that paid.
    pub payer: String,
}

/// What buying against a mandate can come back as.
#[derive(Debug)]
pub enum PurchaseOutcome {
    /// Paid and served.
    Approved {
        /// The gated response.
        result: InferResponse,
        /// Settlement details, when the gateway returned a `payment-response`
        /// header.
        settlement: Option<Settlement>,
    },
    /// The mandate guard blocked this before any price tag was even
    /// issued — an expected outcome, not a client failure. Carries the
    /// gateway's `403` body (see `gateway::mandate_guard::gate`).
    MandateRejected {
        /// Which ancestor failed and why, as reported by `MandateViolation`.
        reason: String,
    },
    /// Payment was authorized but the service itself failed (the model
    /// backend didn't answer). Settlement only happens after the handler
    /// succeeds, so nothing was paid.
    ServiceFailed {
        /// The provider's error.
        reason: String,
    },
}

/// What the gated endpoint says before any payment is attached.
#[derive(Debug)]
pub enum Challenge {
    /// The mandate passed and the provider named its price: the `402`
    /// payment requirements, decoded from the `payment-required` header (or
    /// the body, for gateways that send it there).
    PaymentRequired {
        /// The decoded x402 requirements, as the provider sent them.
        requirements: serde_json::Value,
    },
    /// The mandate guard refused before any price tag was issued.
    MandateRejected {
        /// The gateway's `403` reason.
        reason: String,
    },
}

/// Buys metered, mandate-gated work from any gateway speaking this protocol.
pub struct Client {
    http: reqwest::Client,
    wallet: Wallet,
}

impl Client {
    /// Builds a client that pays with `wallet`.
    #[must_use]
    pub fn new(wallet: Wallet) -> Self {
        Self {
            http: reqwest::Client::new(),
            wallet,
        }
    }

    /// `GET /.well-known/x402` then `POST /v1/quote` against `base_url` —
    /// discovery plus pricing, no payment involved yet.
    ///
    /// # Errors
    ///
    /// Returns an error when the base URL is unreachable or returns a body
    /// that isn't the expected shape.
    pub async fn quote(&self, base_url: &str, request: &QuoteRequest) -> Result<Offer> {
        let manifest: ServiceManifest = self
            .http
            .get(format!("{base_url}/.well-known/x402"))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
            .context("manifest was not a ServiceManifest")?;

        let quote: QuoteResponse = self
            .http
            .post(&manifest.quote_url)
            .json(request)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
            .context("quote was not a QuoteResponse")?;

        Ok(Offer { manifest, quote })
    }

    /// Calls the gated endpoint once without paying, to see what it will
    /// ask for. Nothing is signed and the quote is not spent: the mandate
    /// guard answers `403`, or the x402 layer answers `402` with its price.
    ///
    /// # Errors
    ///
    /// Returns an error when the gateway is unreachable or answers with
    /// anything other than `402` or `403`.
    pub async fn challenge(&self, offer: &Offer, agent_ens_name: &str) -> Result<Challenge> {
        let url = format!("{}&agent={agent_ens_name}", offer.quote.infer_url);
        let response = self
            .http
            .post(&url)
            .json(&serde_json::json!({}))
            .send()
            .await
            .context("probe request failed")?;
        let status = response.status();
        let header = response
            .headers()
            .get("payment-required")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| BASE64_STANDARD.decode(v).ok())
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
        let body = response.text().await.unwrap_or_default();

        match status {
            reqwest::StatusCode::FORBIDDEN => Ok(Challenge::MandateRejected {
                reason: rejection_reason(body),
            }),
            reqwest::StatusCode::PAYMENT_REQUIRED => Ok(Challenge::PaymentRequired {
                requirements: header
                    .or_else(|| serde_json::from_str(&body).ok())
                    .unwrap_or(serde_json::Value::Null),
            }),
            other => bail!("provider answered {other} to an unpaid request: {body}"),
        }
    }

    /// Pays for `offer` and calls its gated endpoint as `agent_ens_name`,
    /// capped at `budget` atomic units of the offer's asset.
    ///
    /// # Errors
    ///
    /// Returns an error for anything other than a clean approval or a
    /// mandate rejection: network failure, insufficient balance, or an
    /// unparsable response.
    pub async fn purchase(
        &self,
        offer: &Offer,
        agent_ens_name: &str,
        budget: u64,
    ) -> Result<PurchaseOutcome> {
        let signer = HederaSigner::new(self.wallet.account_id, self.wallet.private_key.clone());

        // Spend controls cap what this call will sign for, in atomic units
        // of exactly the asset the provider expects to be paid in.
        let controls = SpendControls {
            max_amount_per_payment: MaxAmountPerPayment::Disabled,
            allowed_assets: AllowedAssets::List(vec![SpendControlAsset {
                network: offer
                    .quote
                    .network
                    .parse()
                    .context("provider advertised an unparsable network")?,
                asset: offer.quote.asset.id.as_str().into(),
                max_amount_per_payment: Some(budget.to_string().into()),
            }]),
        };

        let paying = reqwest::Client::new().with_payments(
            X402Client::new()
                .register(HederaExactClient::new(signer))
                .with_spend_controls(controls),
        );

        let url = format!("{}&agent={agent_ens_name}", offer.quote.infer_url);
        let response = paying
            .post(&url)
            .json(&serde_json::json!({}))
            .send()
            .await
            .context("paid request failed")?;

        let status = response.status();
        let settlement = response
            .headers()
            .get("payment-response")
            .and_then(|v| v.to_str().ok())
            .and_then(decode_settlement);
        let body = response.text().await.context("reading response body")?;

        // The mandate guard is the only thing in this system that returns
        // 403 — anything else (insufficient balance, bad request) uses a
        // different status, so this check is unambiguous.
        if status == reqwest::StatusCode::FORBIDDEN {
            return Ok(PurchaseOutcome::MandateRejected {
                reason: rejection_reason(body),
            });
        }

        // The gateway answers 502 when its model backend fails; x402 settles
        // only after a successful handler, so this is a failed service, not a
        // charged one.
        if status == reqwest::StatusCode::BAD_GATEWAY {
            return Ok(PurchaseOutcome::ServiceFailed {
                reason: rejection_reason(body),
            });
        }

        if !status.is_success() {
            if body.contains("insufficient_balance") {
                bail!(
                    "the facilitator rejected the payment: account {} cannot cover {}. \
                     Fund it at https://portal.hedera.com/faucet and retry.",
                    self.wallet.account_id,
                    offer.quote.asset.format(offer.quote.amount)
                );
            }
            bail!("provider returned {status}: {body}");
        }

        let result: InferResponse = serde_json::from_str(&body)
            .with_context(|| format!("unexpected response body: {body}"))?;

        Ok(PurchaseOutcome::Approved { result, settlement })
    }
}

/// The `error` field of a mandate guard `403`, or the raw body.
fn rejection_reason(body: String) -> String {
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
        .unwrap_or(body)
}

fn decode_settlement(header: &str) -> Option<Settlement> {
    let json: serde_json::Value =
        serde_json::from_slice(&BASE64_STANDARD.decode(header).ok()?).ok()?;
    Some(Settlement {
        transaction: json.get("transaction")?.as_str()?.to_owned(),
        network: json
            .get("network")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned(),
        payer: json
            .get("payer")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_owned(),
    })
}

/// `https://hashscan.io/<net>/transaction/<id>` for a settled transaction.
#[must_use]
pub fn hashscan_tx(network: &str, transaction: &str) -> String {
    let net = if network.contains("mainnet") {
        "mainnet"
    } else {
        "testnet"
    };
    format!("https://hashscan.io/{net}/transaction/{transaction}")
}

// DER-encoded keys are self-describing and always parse correctly. A raw,
// undecorated 32-byte hex string is not — it's valid input for both curves,
// and `PrivateKey::from_str`/`from_bytes` silently assumes Ed25519 for it,
// which misparses the ECDSA keys the Hedera portal now hands out by
// default. Trying `from_str_ecdsa` before `from_str_ed25519` (and before
// the ambiguous generic `from_str`) makes that common case correct; a
// genuinely Ed25519 raw hex key still parses fine via the later fallback.
fn parse_private_key(raw: &str) -> Result<PrivateKey> {
    let trimmed = raw.trim();
    let s = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    [
        PrivateKey::from_str_der(s).ok(),
        PrivateKey::from_str_ecdsa(s).ok(),
        PrivateKey::from_str_ed25519(s).ok(),
        PrivateKey::from_str(s).ok(),
    ]
    .into_iter()
    .flatten()
    .next()
    .context("could not parse private key")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashscan_tx_picks_the_network_from_the_caip2_string() {
        assert_eq!(
            hashscan_tx("hedera:testnet", "0.0.1@1.2"),
            "https://hashscan.io/testnet/transaction/0.0.1@1.2"
        );
        assert_eq!(
            hashscan_tx("hedera:mainnet", "0.0.1@1.2"),
            "https://hashscan.io/mainnet/transaction/0.0.1@1.2"
        );
    }

    #[test]
    fn decode_settlement_reads_the_base64_json_header() {
        let header = BASE64_STANDARD.encode(
            serde_json::json!({
                "transaction": "0.0.1@1.2",
                "network": "hedera:testnet",
                "payer": "0.0.99",
            })
            .to_string(),
        );
        let settlement = decode_settlement(&header).unwrap();
        assert_eq!(settlement.transaction, "0.0.1@1.2");
        assert_eq!(settlement.network, "hedera:testnet");
        assert_eq!(settlement.payer, "0.0.99");
    }

    #[test]
    fn decode_settlement_rejects_garbage() {
        assert!(decode_settlement("not-base64!!").is_none());
    }
}
