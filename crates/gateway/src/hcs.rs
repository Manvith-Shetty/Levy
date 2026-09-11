//! Settlement receipts, published to the Hedera Consensus Service.
//!
//! Every settled payment produces a receipt tying an on-chain transfer to the
//! metered work it bought. Receipts go to an HCS topic, so the audit trail is
//! independently verifiable — anyone can replay the topic through a mirror node
//! without trusting this server.

use std::str::FromStr;
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use hedera::{AccountId, Client, PrivateKey, TopicId, TopicMessageSubmitTransaction};
use meter::{Receipt, Usage};
use r402_protocol::payment::SettleResponse;
use r402_server::{ResourceServerHooks, SettleResultContext};
use tokio::sync::mpsc;

use crate::config::{Config, HcsConfig};
use crate::quotes::QuoteStore;

/// Parses a Hedera private key in any of the formats the portal and SDKs emit.
///
/// # Errors
///
/// Returns an error when the string is not a recognisable key.
pub fn parse_private_key(raw: &str) -> Result<PrivateKey> {
    let trimmed = raw.trim();
    let s = trimmed.strip_prefix("0x").unwrap_or(trimmed);
    [
        PrivateKey::from_str(s).ok(),
        PrivateKey::from_str_der(s).ok(),
        PrivateKey::from_str_ecdsa(s).ok(),
        PrivateKey::from_str_ed25519(s).ok(),
    ]
    .into_iter()
    .flatten()
    .next()
    .context("could not parse Hedera private key")
}

/// Builds an SDK client for the configured network with an operator set.
///
/// # Errors
///
/// Returns an error when the account id or key cannot be parsed.
pub fn client_for(network: &str, account_id: &str, private_key: &str) -> Result<Client> {
    let client = if network.contains("mainnet") {
        Client::for_mainnet()
    } else {
        Client::for_testnet()
    };
    client.set_operator(
        AccountId::from_str(account_id).context("invalid operator account id")?,
        parse_private_key(private_key)?,
    );
    Ok(client)
}

/// Receipts held in memory so `GET /v1/receipts` works even without HCS.
#[derive(Debug, Default)]
pub struct ReceiptLog {
    entries: Mutex<Vec<Receipt>>,
}

impl ReceiptLog {
    /// Appends a receipt, keeping the most recent 100.
    pub fn push(&self, receipt: Receipt) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        entries.push(receipt);
        let len = entries.len();
        if len > 100 {
            entries.drain(..len - 100);
        }
    }

    /// Snapshot of the log, newest last.
    #[must_use]
    pub fn snapshot(&self) -> Vec<Receipt> {
        self.entries
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// Spawns a task that submits receipts to an HCS topic.
///
/// Returns the sender half; dropping every sender ends the task. Submission is
/// off the request path on purpose: a topic hiccup must not fail a request the
/// buyer already paid for.
///
/// # Errors
///
/// Returns an error when the client or topic id cannot be built.
pub fn spawn_publisher(network: &str, cfg: &HcsConfig) -> Result<mpsc::UnboundedSender<Receipt>> {
    let client = client_for(network, &cfg.operator_id, &cfg.operator_key)?;
    let topic = TopicId::from_str(&cfg.topic_id).context("invalid HCS_TOPIC_ID")?;
    let (tx, mut rx) = mpsc::unbounded_channel::<Receipt>();

    tokio::spawn(async move {
        while let Some(receipt) = rx.recv().await {
            let Ok(body) = serde_json::to_vec(&receipt) else {
                continue;
            };
            let submitted = TopicMessageSubmitTransaction::new()
                .topic_id(topic)
                .message(body)
                .execute(&client)
                .await;
            match submitted {
                Ok(response) => match response.get_receipt(&client).await {
                    Ok(_) => tracing::info!(
                        topic = %topic,
                        quote = %receipt.quote_id,
                        "receipt published to HCS"
                    ),
                    Err(error) => tracing::warn!(%error, "HCS receipt did not reach consensus"),
                },
                Err(error) => tracing::warn!(%error, "HCS receipt submit failed"),
            }
        }
    });

    Ok(tx)
}

/// Resource-server hook that turns each successful settlement into a receipt.
pub struct ReceiptHook {
    provider: String,
    pay_to: String,
    quotes: Arc<QuoteStore>,
    log: Arc<ReceiptLog>,
    hcs: Option<mpsc::UnboundedSender<Receipt>>,
}

impl ReceiptHook {
    /// Wires the hook to the quote store, the in-memory log, and optionally HCS.
    #[must_use]
    pub fn new(
        cfg: &Config,
        quotes: Arc<QuoteStore>,
        log: Arc<ReceiptLog>,
        hcs: Option<mpsc::UnboundedSender<Receipt>>,
    ) -> Self {
        Self {
            provider: cfg.provider.clone(),
            pay_to: cfg.pay_to.clone(),
            quotes,
            log,
            hcs,
        }
    }
}

/// Pulls `quote` out of the resource URL the 402 was issued for.
fn quote_id_from(resource_url: Option<&str>) -> Option<String> {
    let url = url::Url::parse(resource_url?).ok()?;
    url.query_pairs()
        .find(|(k, _)| k == "quote")
        .map(|(_, v)| v.into_owned())
}

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| String::new())
}

impl ResourceServerHooks for ReceiptHook {
    async fn after_settle(&self, ctx: &SettleResultContext) {
        {
            let SettleResponse::Success {
                payer,
                transaction,
                network,
                ..
            } = &ctx.result
            else {
                return;
            };

            let requirements = &ctx.settle.payment.requirements;
            let quote_id = quote_id_from(ctx.settle.resource_url.as_deref()).unwrap_or_default();
            let quote = self.quotes.get(&quote_id);
            let usage = quote.as_ref().and_then(|q| q.usage).unwrap_or(Usage {
                input_tokens: 0,
                output_tokens: 0,
            });
            let mandate_path = quote.and_then(|q| q.mandate_path).unwrap_or_default();

            let receipt = Receipt {
                kind: "x402.hedera.settlement.v1".into(),
                provider: self.provider.clone(),
                quote_id,
                payer: payer.as_ref().map(ToString::to_string).unwrap_or_default(),
                pay_to: self.pay_to.clone(),
                amount: requirements.amount.parse().unwrap_or_default(),
                asset: requirements.asset.to_string(),
                network: network.to_string(),
                transaction_id: transaction.to_string(),
                usage,
                settled_at: now_rfc3339(),
                mandate_path,
            };

            tracing::info!(
                payer = %receipt.payer,
                amount = receipt.amount,
                tx = %receipt.transaction_id,
                "payment settled"
            );

            if let Some(tx) = &self.hcs
                && let Err(error) = tx.send(receipt.clone())
            {
                tracing::warn!(%error, "receipt channel closed");
            }
            self.log.push(receipt);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_id_is_read_from_the_resource_url() {
        assert_eq!(
            quote_id_from(Some("http://localhost:4021/v1/infer?quote=abc123")),
            Some("abc123".to_owned())
        );
        assert_eq!(quote_id_from(Some("http://localhost:4021/v1/infer")), None);
        assert_eq!(quote_id_from(None), None);
    }
}
