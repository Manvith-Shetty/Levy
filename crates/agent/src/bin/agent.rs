//! Demo buyer: discovers metered inference providers, compares quotes
//! against a budget, and pays the cheapest one that will have it — subject
//! to its mandate.
//!
//! No API keys, no accounts, no subscriptions: the agent's Hedera key and
//! its ENS mandate subname are the only credentials, and each request is
//! paid for on its own.
//!
//! ```bash
//! cargo run -p agent --bin agent
//! ```

use agent::client::{Client, Offer, PurchaseOutcome, Wallet, hashscan_tx};
use agent::env::AgentEnv;
use anyhow::{Context, Result, bail};
use meter::QuoteRequest;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();

    let env = AgentEnv::from_env().map_err(|e| anyhow::anyhow!(e))?;
    let wallet = Wallet::new(&env.account_id, &env.private_key)?;
    let client = Client::new(wallet);

    println!("agent   {}", env.account_id);
    println!("mandate {}", env.agent_ens_name);
    println!("prompt  \"{}\"", env.prompt);
    println!();

    // 1. Discovery — ask every known provider what it sells and how it prices.
    println!("── discovery ────────────────────────────────────────────");
    let request = QuoteRequest {
        prompt: env.prompt.clone(),
        max_output_tokens: env.max_output_tokens,
    };
    let mut offers: Vec<Offer> = Vec::new();
    for base in &env.providers {
        match client.quote(base, &request).await {
            Ok(offer) => {
                println!(
                    "  {:<14} {:<12} {:>4} in / {:>4} out tok  →  {}",
                    offer.manifest.provider,
                    offer.manifest.model,
                    offer.quote.input_tokens,
                    offer.quote.max_output_tokens,
                    offer.quote.asset.format(offer.quote.amount),
                );
                offers.push(offer);
            }
            Err(error) => println!("  {base:<14} unreachable: {error}"),
        }
    }
    if offers.is_empty() {
        bail!("no provider answered; is the gateway running?");
    }

    // 2. Selection — cheapest quote the budget can cover.
    println!();
    println!("── selection ────────────────────────────────────────────");
    let affordable: Vec<&Offer> = offers
        .iter()
        .filter(|o| o.quote.amount <= env.budget_atomic)
        .collect();
    if affordable.is_empty() {
        let cheapest = offers.iter().map(|o| o.quote.amount).min().unwrap_or(0);
        bail!(
            "budget {} is below the cheapest quote {}",
            offers[0].quote.asset.format(env.budget_atomic),
            offers[0].quote.asset.format(cheapest)
        );
    }
    let chosen = affordable
        .into_iter()
        .min_by_key(|o| o.quote.amount)
        .context("no affordable offer")?;
    println!("  budget   {}", chosen.quote.asset.format(env.budget_atomic));
    println!(
        "  chose    {} at {} ({} other offer(s) passed over)",
        chosen.manifest.provider,
        chosen.quote.asset.format(chosen.quote.amount),
        offers.len().saturating_sub(1)
    );

    // 3. Check Leash, then pay — one 402, one signed TransferTransaction, one
    //    settlement, gated on the mandate the whole way.
    println!();
    println!("── payment ──────────────────────────────────────────────");
    println!("  POST {}&agent={}", chosen.quote.infer_url, env.agent_ens_name);
    match client
        .purchase(chosen, &env.agent_ens_name, env.budget_atomic)
        .await?
    {
        PurchaseOutcome::MandateRejected { reason } => {
            println!("  REJECTED  {reason}");
        }
        PurchaseOutcome::ServiceFailed { reason } => {
            println!("  SERVICE FAILED  {reason} (not settled, nothing paid)");
        }
        PurchaseOutcome::Approved { result, settlement } => {
            match &settlement {
                Some(s) => {
                    println!("  settled  tx {}", s.transaction);
                    println!("  payer    {}", s.payer);
                    println!("  explorer {}", hashscan_tx(&s.network, &s.transaction));
                }
                None => println!("  settled  (no PAYMENT-RESPONSE header returned)"),
            }

            // 4. The thing that was actually bought.
            println!();
            println!("── result ───────────────────────────────────────────────");
            println!("  provider {} / {}", result.provider, result.model);
            println!(
                "  metered  {} in + {} out tokens",
                result.usage.input_tokens, result.usage.output_tokens
            );
            println!("  charged  {}", chosen.quote.asset.format(result.charged));
            if result.unused_output_credit > 0 {
                println!(
                    "  unused   {} of prepaid output budget",
                    chosen.quote.asset.format(result.unused_output_credit)
                );
            }
            println!();
            println!("{}", result.completion);
        }
    }
    Ok(())
}
