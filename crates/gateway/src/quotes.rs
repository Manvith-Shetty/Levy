//! In-memory store of issued quotes.
//!
//! A quote binds a price to one specific prompt. The x402 layer prices a
//! request by looking the quote up from `?quote=<id>`, and the handler redeems
//! it exactly once — so a buyer cannot pay a cheap quote and run an expensive
//! prompt, or replay one payment across two requests.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use meter::{MandateHop, Usage};

/// A quote's lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Issued, not yet paid for.
    Open,
    /// Redeemed by a paid request.
    Redeemed,
}

/// One issued quote.
#[derive(Debug, Clone)]
pub struct Quote {
    /// Prompt this quote was priced for.
    pub prompt: String,
    /// Output budget the buyer asked for.
    pub max_output_tokens: u64,
    /// Price in atomic units.
    pub amount: u64,
    /// Redemption state.
    pub state: State,
    /// Tokens actually used, once the request has run.
    pub usage: Option<Usage>,
    /// The mandate chain the guard resolved for this request, root first —
    /// set once the mandate guard has passed it, read back by the settle
    /// hook to embed in the receipt.
    pub mandate_path: Option<Vec<MandateHop>>,
    issued: Instant,
}

impl Quote {
    /// Whether this quote is past its TTL.
    #[must_use]
    pub fn is_expired(&self, ttl: Duration) -> bool {
        self.issued.elapsed() > ttl
    }
}

/// Why a redemption attempt failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedeemError {
    /// No such quote id.
    Unknown,
    /// Quote existed but has aged out.
    Expired,
    /// Quote was already redeemed by an earlier paid request.
    AlreadyRedeemed,
}

impl RedeemError {
    /// Message suitable for an HTTP error body.
    #[must_use]
    pub const fn message(self) -> &'static str {
        match self {
            Self::Unknown => "unknown quote id; POST /v1/quote first",
            Self::Expired => "quote expired; request a fresh one",
            Self::AlreadyRedeemed => "quote already redeemed",
        }
    }
}

/// Thread-safe quote store with a fixed TTL.
#[derive(Debug)]
pub struct QuoteStore {
    quotes: Mutex<HashMap<String, Quote>>,
    ttl: Duration,
}

impl QuoteStore {
    /// Creates a store whose quotes expire after `ttl_secs`.
    #[must_use]
    pub fn new(ttl_secs: u64) -> Self {
        Self {
            quotes: Mutex::new(HashMap::new()),
            ttl: Duration::from_secs(ttl_secs),
        }
    }

    /// Stores a newly issued quote under `id`.
    pub fn insert(
        &self,
        id: String,
        prompt: String,
        max_output_tokens: u64,
        amount: u64,
    ) {
        let mut quotes = self.lock();
        quotes.retain(|_, q| !q.is_expired(self.ttl));
        quotes.insert(
            id,
            Quote {
                prompt,
                max_output_tokens,
                amount,
                state: State::Open,
                usage: None,
                mandate_path: None,
                issued: Instant::now(),
            },
        );
    }

    /// Price of an open, unexpired quote — what the 402 will charge.
    ///
    /// Returns `None` for unknown, expired, or already-redeemed quotes.
    #[must_use]
    pub fn price_of(&self, id: &str) -> Option<u64> {
        let quotes = self.lock();
        let quote = quotes.get(id)?;
        (quote.state == State::Open && !quote.is_expired(self.ttl)).then_some(quote.amount)
    }

    /// Marks a quote redeemed and returns it, or explains why it cannot be.
    ///
    /// Called by the handler *after* the x402 layer has verified payment. This
    /// is also the guard that closes the dynamic-pricing bypass: an empty price
    /// tag list means "no payment required", so an unknown quote must never
    /// reach the model.
    ///
    /// # Errors
    ///
    /// [`RedeemError`] when the quote is unknown, expired, or already used.
    pub fn redeem(&self, id: &str) -> Result<Quote, RedeemError> {
        let mut quotes = self.lock();
        let quote = quotes.get_mut(id).ok_or(RedeemError::Unknown)?;
        if quote.is_expired(self.ttl) {
            return Err(RedeemError::Expired);
        }
        if quote.state == State::Redeemed {
            return Err(RedeemError::AlreadyRedeemed);
        }
        quote.state = State::Redeemed;
        Ok(quote.clone())
    }

    /// Records what the request actually consumed, for the settlement receipt.
    pub fn record_usage(&self, id: &str, usage: Usage) {
        if let Some(quote) = self.lock().get_mut(id) {
            quote.usage = Some(usage);
        }
    }

    /// Records the mandate chain the guard resolved for this quote, so the
    /// settle hook can embed it in the receipt.
    pub fn record_mandate_path(&self, id: &str, path: Vec<MandateHop>) {
        if let Some(quote) = self.lock().get_mut(id) {
            quote.mandate_path = Some(path);
        }
    }

    /// Snapshot of a quote, for the settle hook.
    #[must_use]
    pub fn get(&self, id: &str) -> Option<Quote> {
        self.lock().get(id).cloned()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Quote>> {
        self.quotes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quote_can_only_be_redeemed_once() {
        let store = QuoteStore::new(60);
        store.insert("q1".into(), "hi".into(), 16, 50_000);
        assert_eq!(store.price_of("q1"), Some(50_000));
        assert!(store.redeem("q1").is_ok());
        assert_eq!(store.redeem("q1").unwrap_err(), RedeemError::AlreadyRedeemed);
        assert_eq!(store.price_of("q1"), None, "redeemed quotes stop pricing");
    }

    #[test]
    fn unknown_quotes_are_unpriced_and_unredeemable() {
        let store = QuoteStore::new(60);
        assert_eq!(store.price_of("nope"), None);
        assert_eq!(store.redeem("nope").unwrap_err(), RedeemError::Unknown);
    }
}
