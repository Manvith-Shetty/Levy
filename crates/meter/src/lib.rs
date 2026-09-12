//! Shared metering, pricing, and wire types for the x402 Hedera PoC.
//!
//! Both the resource server (`service`) and the buyer (`agent`) depend on this
//! crate so the quote a provider issues and the quote an agent compares are
//! literally the same struct.

use serde::{Deserialize, Serialize};

/// Approximate token count for a piece of text.
///
/// A real deployment would call the model's tokenizer. The PoC needs only that
/// the count is deterministic and that both sides agree on it, so this uses the
/// standard ~4-characters-per-token heuristic with a word-count floor.
#[must_use]
pub fn count_tokens(text: &str) -> u64 {
    let by_chars = text.chars().count().div_ceil(4) as u64;
    let by_words = text.split_whitespace().count() as u64;
    by_chars.max(by_words).max(1)
}

/// The asset a provider prices in, as advertised on its manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssetInfo {
    /// Hedera entity id: `0.0.0` for native HBAR, otherwise an HTS token id.
    pub id: String,
    /// Display ticker, e.g. `HBAR` or `USDC`.
    pub symbol: String,
    /// Decimals used to render `amount` for humans.
    pub decimals: u8,
}

impl AssetInfo {
    /// Renders an atomic amount as a decimal string in whole units.
    #[must_use]
    pub fn format(&self, atomic: u64) -> String {
        let scale = 10u64.pow(u32::from(self.decimals));
        let whole = atomic / scale;
        let frac = atomic % scale;
        format!(
            "{whole}.{frac:0width$} {sym}",
            width = self.decimals as usize,
            sym = self.symbol
        )
    }
}

/// Per-token price schedule, in atomic units of [`AssetInfo`].
///
/// Charging per 1000 tokens rather than per request is what makes this metered
/// rather than a flat fee: two different prompts cost two different amounts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PriceModel {
    /// Atomic units charged per 1000 input (prompt) tokens.
    pub per_1k_input: u64,
    /// Atomic units charged per 1000 output (completion) tokens.
    pub per_1k_output: u64,
    /// Floor applied after metering, so dust requests still pay something.
    pub minimum: u64,
}

impl PriceModel {
    /// Price for a request of `input_tokens` that may generate up to
    /// `max_output_tokens`.
    ///
    /// The `exact` x402 scheme settles one precise amount, so the buyer is
    /// quoted the ceiling: input tokens (known) plus the output budget it
    /// asked for. The response reports what was actually consumed.
    #[must_use]
    pub fn quote(&self, input_tokens: u64, max_output_tokens: u64) -> u64 {
        let input = input_tokens.saturating_mul(self.per_1k_input) / 1000;
        let output = max_output_tokens.saturating_mul(self.per_1k_output) / 1000;
        input.saturating_add(output).max(self.minimum)
    }
}

/// What a provider publishes at `GET /.well-known/x402` so agents can find and
/// compare it without a directory service or an API key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceManifest {
    /// Human-readable provider name.
    pub provider: String,
    /// Model served behind the paywall.
    pub model: String,
    /// Public base URL of this provider.
    pub base_url: String,
    /// Free endpoint that meters a prompt and returns a priced quote.
    pub quote_url: String,
    /// x402-gated endpoint; takes `?quote=<id>`.
    pub infer_url: String,
    /// CAIP-2 network payments settle on, e.g. `hedera:testnet`.
    pub network: String,
    /// Hedera account credited by the transfer.
    pub pay_to: String,
    /// Asset the provider prices in.
    pub asset: AssetInfo,
    /// Published price schedule.
    pub pricing: PriceModel,
    /// Facilitator that verifies and settles payments for this provider.
    pub facilitator: String,
    /// HCS topic carrying this provider's settlement receipts, when enabled.
    pub receipts_topic: Option<String>,
    /// x402 protocol version.
    pub x402_version: u8,
}

/// Body of `POST /v1/quote`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuoteRequest {
    /// Prompt to be metered and later run.
    pub prompt: String,
    /// Upper bound on generated tokens, which the quote charges for.
    #[serde(default = "default_max_output")]
    pub max_output_tokens: u64,
}

fn default_max_output() -> u64 {
    256
}

/// A priced, time-limited offer to run one specific prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuoteResponse {
    /// Opaque id; pass it to the gated endpoint as `?quote=<id>`.
    pub quote_id: String,
    /// Provider that issued this quote.
    pub provider: String,
    /// Model that will run the prompt.
    pub model: String,
    /// Metered prompt tokens.
    pub input_tokens: u64,
    /// Output budget this quote paid for.
    pub max_output_tokens: u64,
    /// Price in atomic units of `asset`.
    pub amount: u64,
    /// Asset the amount is denominated in.
    pub asset: AssetInfo,
    /// CAIP-2 settlement network.
    pub network: String,
    /// Fully-qualified gated URL, quote id already attached.
    pub infer_url: String,
    /// Seconds until this quote can no longer be redeemed.
    pub expires_in_secs: u64,
}

/// Tokens actually consumed by a completed request.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Usage {
    /// Prompt tokens.
    pub input_tokens: u64,
    /// Generated tokens.
    pub output_tokens: u64,
}

/// Body returned by the gated endpoint once payment is verified.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InferResponse {
    /// Quote this request redeemed.
    pub quote_id: String,
    /// Provider that served it.
    pub provider: String,
    /// Model that generated the completion.
    pub model: String,
    /// The completion itself.
    pub completion: String,
    /// Tokens actually used.
    pub usage: Usage,
    /// Atomic units charged, matching the quote.
    pub charged: u64,
    /// Atomic units the buyer paid for but did not consume.
    pub unused_output_credit: u64,
}

/// One node the mandate guard walked through on the way from an agent to the
/// root of its ENS ancestor chain, as it stood at settlement time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MandateHop {
    /// ENS subname of this node.
    pub name: String,
    /// Spending budget resolved from this node's resolver, in atomic units.
    pub budget: u64,
    /// RFC 3339 expiry (or, for the root, the Selfie Check deadline).
    pub expires_at: String,
}

/// One settlement record, published to HCS and served from `GET /v1/receipts`.
///
/// This is the audit trail: it ties an on-chain transfer to the exact metered
/// work it paid for, and anyone can replay the topic to verify it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Receipt {
    /// Schema marker so consumers can version the topic.
    pub kind: String,
    /// Provider that issued the receipt.
    pub provider: String,
    /// Quote redeemed.
    pub quote_id: String,
    /// Hedera account that paid.
    pub payer: String,
    /// Hedera account credited.
    pub pay_to: String,
    /// Atomic units transferred.
    pub amount: u64,
    /// Asset id transferred.
    pub asset: String,
    /// CAIP-2 network.
    pub network: String,
    /// Settlement transaction id reported by the facilitator.
    pub transaction_id: String,
    /// Tokens metered for this request.
    pub usage: Usage,
    /// RFC 3339 timestamp the receipt was written.
    pub settled_at: String,
    /// The resolved mandate chain, root first, that authorized this spend.
    /// Empty when the mandate guard was not in the request path.
    #[serde(default)]
    pub mandate_path: Vec<MandateHop>,
}

/// One payment the mandate guard refused, before any price tag was issued.
///
/// Published to the same HCS topic as [`Receipt`]s (told apart by `kind`) and
/// served from `GET /v1/refusals`, so the audit trail covers every
/// authorization decision — not only the ones that settled.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Refusal {
    /// Schema marker, `leash.mandate.refusal.v1`.
    pub kind: String,
    /// Provider that refused the request.
    pub provider: String,
    /// Quote the refused request tried to redeem.
    pub quote_id: String,
    /// ENS subname the request claimed to spend as.
    pub agent: String,
    /// Atomic units the request would have cost.
    pub amount: u64,
    /// Asset id the amount is denominated in.
    pub asset: String,
    /// CAIP-2 network the payment would have settled on.
    pub network: String,
    /// ENS subname of the ancestor that failed — may be the agent itself.
    pub blocked_by: String,
    /// Machine-readable violation: `unresolvable`, `expired`, `over_budget`
    /// or `over_per_call_limit`.
    pub violation: String,
    /// The ceiling that was breached, for `over_budget` and
    /// `over_per_call_limit`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u64>,
    /// Human-readable reason, as the guard reported it.
    pub reason: String,
    /// RFC 3339 timestamp the refusal was recorded.
    pub refused_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn longer_prompts_cost_more() {
        let model = PriceModel {
            per_1k_input: 1_000_000,
            per_1k_output: 4_000_000,
            minimum: 100_000,
        };
        let short = model.quote(count_tokens("hello"), 16);
        let long = model.quote(count_tokens(&"hello ".repeat(500)), 16);
        assert!(long > short, "metering must scale with prompt length");
    }

    #[test]
    fn minimum_is_a_floor_not_a_flat_fee() {
        let model = PriceModel {
            per_1k_input: 1_000_000,
            per_1k_output: 4_000_000,
            minimum: 100_000,
        };
        assert_eq!(model.quote(1, 0), 100_000);
        assert!(model.quote(10_000, 1_000) > 100_000);
    }

    #[test]
    fn amounts_render_with_asset_decimals() {
        let hbar = AssetInfo {
            id: "0.0.0".into(),
            symbol: "HBAR".into(),
            decimals: 8,
        };
        assert_eq!(hbar.format(123_456_789), "1.23456789 HBAR");
    }
}
