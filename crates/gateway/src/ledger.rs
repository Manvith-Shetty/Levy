//! Spending so far, per mandate node — what turns `budget` from a ceiling on
//! one payment into authority that gets used up.
//!
//! The source of truth is the HCS topic. Every provider publishes its
//! receipts there, so replaying the topic from a mirror node sums spending
//! across all of them, including providers this process never talked to, and
//! survives restarts. A receipt this gateway settles counts immediately,
//! before the topic catches up; its transaction id keeps it from counting
//! twice when the topic delivers it.
//!
//! Each receipt carries the mandate path that authorized it, root first, so
//! its amount is added to every node on that path: a node's spend is the
//! roll-up of its whole subtree.
//!
//! Known gap: two payments authorized at the same instant can both fit and
//! both settle. Each is capped by `maxPerCall`, and the next check sees both.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use base64::prelude::{BASE64_STANDARD, Engine as _};
use mandate::Spent;
use meter::Receipt;
use serde::Deserialize;
use tokio::sync::Mutex;

/// Shortest gap between two mirror-node syncs.
const MIN_SYNC_GAP: Duration = Duration::from_millis(1_500);
/// Pages read per sync, 100 messages each.
const MAX_PAGES: usize = 20;

#[derive(Default)]
struct State {
    /// Last topic sequence number applied.
    last_sequence: u64,
    /// Settlement transactions already counted.
    seen: HashSet<String>,
    spent: Spent,
    synced_at: Option<Instant>,
    /// Why the last sync failed, if it did.
    error: Option<String>,
}

/// Roll-up spending per mandate node, in atomic units of the tree's asset.
pub struct SpendLedger {
    mirror_url: String,
    topic_id: Option<String>,
    /// Only receipts in this asset count against budgets.
    asset_id: String,
    http: reqwest::Client,
    state: Mutex<State>,
}

#[derive(Deserialize)]
struct Page {
    messages: Vec<Message>,
    links: Option<Links>,
}

#[derive(Deserialize)]
struct Message {
    sequence_number: u64,
    message: String,
}

#[derive(Deserialize)]
struct Links {
    next: Option<String>,
}

impl SpendLedger {
    /// A ledger replaying `topic_id` (when there is one) through `mirror_url`.
    #[must_use]
    pub fn new(mirror_url: &str, topic_id: Option<String>, asset_id: &str) -> Self {
        Self {
            mirror_url: mirror_url.trim_end_matches('/').to_owned(),
            topic_id,
            asset_id: asset_id.to_owned(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap_or_default(),
            state: Mutex::new(State::default()),
        }
    }

    /// Current spending per node, after catching up with the topic. If the
    /// mirror node doesn't answer, the last known totals are used.
    pub async fn spent(&self) -> Spent {
        let mut state = self.state.lock().await;
        let due = state.synced_at.is_none_or(|at| at.elapsed() >= MIN_SYNC_GAP);
        if due && let Some(topic) = &self.topic_id {
            match self.sync(topic, &mut state).await {
                Ok(()) => state.error = None,
                Err(error) => {
                    tracing::warn!(%error, "spend ledger could not reach the mirror node; using last known totals");
                    state.error = Some(error.to_string());
                }
            }
            state.synced_at = Some(Instant::now());
        }
        state.spent.clone()
    }

    /// Why the ledger is stale, if the last sync failed.
    pub async fn error(&self) -> Option<String> {
        self.state.lock().await.error.clone()
    }

    /// Counts a receipt this gateway just settled.
    pub async fn record(&self, receipt: &Receipt) {
        let mut state = self.state.lock().await;
        apply(&mut state, receipt, &self.asset_id);
    }

    async fn sync(&self, topic: &str, state: &mut State) -> anyhow::Result<()> {
        // `gte:` because the mirror node rejects `gt:0`; sequence numbers start at 1.
        let mut url = format!(
            "{}/api/v1/topics/{topic}/messages?sequencenumber=gte:{}&limit=100&order=asc",
            self.mirror_url,
            state.last_sequence + 1
        );
        for _ in 0..MAX_PAGES {
            let page: Page = self.http.get(&url).send().await?.error_for_status()?.json().await?;
            for message in &page.messages {
                state.last_sequence = state.last_sequence.max(message.sequence_number);
                let Ok(bytes) = BASE64_STANDARD.decode(&message.message) else {
                    continue;
                };
                // Refusals and announcements share the topic; only
                // settlement receipts parse as one with a transaction.
                if let Ok(receipt) = serde_json::from_slice::<Receipt>(&bytes)
                    && receipt.kind.contains("settlement")
                {
                    apply(state, &receipt, &self.asset_id);
                }
            }
            match page.links.and_then(|l| l.next) {
                Some(next) if !page.messages.is_empty() => url = format!("{}{next}", self.mirror_url),
                _ => break,
            }
        }
        Ok(())
    }
}

fn apply(state: &mut State, receipt: &Receipt, asset_id: &str) {
    if receipt.asset != asset_id
        || receipt.transaction_id.is_empty()
        || !state.seen.insert(normalize(&receipt.transaction_id))
    {
        return;
    }
    for hop in &receipt.mandate_path {
        *state.spent.entry(hop.name.clone()).or_default() += receipt.amount;
    }
}

/// Hedera transaction ids come as `0.0.x@s.n` or `0.0.x-s-n`.
fn normalize(id: &str) -> String {
    id.replacen('@', "-", 1).replace('.', "-")
}

#[cfg(test)]
mod tests {
    use meter::{MandateHop, Usage};

    use super::*;

    fn receipt(tx: &str, amount: u64, asset: &str) -> Receipt {
        Receipt {
            kind: "x402.hedera.settlement.v1".into(),
            provider: "p".into(),
            quote_id: "q".into(),
            payer: "0.0.1".into(),
            pay_to: "0.0.2".into(),
            amount,
            asset: asset.into(),
            network: "hedera:testnet".into(),
            transaction_id: tx.into(),
            usage: Usage {
                input_tokens: 1,
                output_tokens: 1,
            },
            settled_at: String::new(),
            mandate_path: ["root", "agent.root", "sub.agent.root"]
                .iter()
                .map(|name| MandateHop {
                    name: (*name).into(),
                    budget: 0,
                    expires_at: String::new(),
                })
                .collect(),
            service: None,
            resource: None,
        }
    }

    #[tokio::test]
    async fn a_receipt_counts_once_against_every_node_on_its_path() {
        let ledger = SpendLedger::new("http://unused", None, "0.0.429274");
        ledger.record(&receipt("0.0.9@1.2", 300, "0.0.429274")).await;
        // The same settlement arriving again (from the topic) isn't recounted.
        ledger.record(&receipt("0.0.9-1-2", 300, "0.0.429274")).await;
        let spent = ledger.spent().await;
        assert_eq!(spent.get("root"), Some(&300));
        assert_eq!(spent.get("sub.agent.root"), Some(&300));
    }

    #[tokio::test]
    async fn receipts_in_another_asset_never_count() {
        let ledger = SpendLedger::new("http://unused", None, "0.0.429274");
        ledger.record(&receipt("0.0.9@1.3", 5_000_000, "0.0.0")).await;
        assert!(ledger.spent().await.is_empty());
    }
}
