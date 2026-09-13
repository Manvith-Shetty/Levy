//! Associates a Hedera account with the payment token — testnet USDC
//! (0.0.429274) by default — so faucets and transfers that insist on an
//! explicit association will deliver to it. Accounts with automatic
//! association slots can already *receive* the token; this makes the
//! association explicit, which some senders check for.
//!
//! Signs with the account's own key, read from the `.env` in the directory
//! it's run from:
//!
//! ```bash
//! cd crates/agent   && cargo run -p agent --bin associate-token   # the agents' payer
//! cd crates/gateway && cargo run -p agent --bin associate-token   # the gateway's pay_to
//! ```
//!
//! Uses `HEDERA_ACCOUNT_ID` / `HEDERA_PRIVATE_KEY`, falling back to
//! `HEDERA_OPERATOR_ID` / `HEDERA_OPERATOR_KEY`. `TOKEN_ID` and
//! `HEDERA_NETWORK` (default `testnet`) are optional.

use agent::client::Wallet;
use anyhow::{Context, Result};
use hedera::{Client, Status, TokenAssociateTransaction, TokenId};

fn var(primary: &str, fallback: &str) -> Result<String> {
    std::env::var(primary)
        .or_else(|_| std::env::var(fallback))
        .with_context(|| format!("set {primary} (or {fallback})"))
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();

    let account = var("HEDERA_ACCOUNT_ID", "HEDERA_OPERATOR_ID")?;
    let key = var("HEDERA_PRIVATE_KEY", "HEDERA_OPERATOR_KEY")?;
    let wallet = Wallet::new(&account, &key)?;
    let token: TokenId = std::env::var("TOKEN_ID")
        .unwrap_or_else(|_| "0.0.429274".into())
        .parse()
        .context("invalid TOKEN_ID")?;
    let network = std::env::var("HEDERA_NETWORK").unwrap_or_else(|_| "testnet".into());

    let client = if network.contains("mainnet") {
        Client::for_mainnet()
    } else {
        Client::for_testnet()
    };
    client.set_operator(wallet.account_id, wallet.private_key.clone());

    println!("associating {token} with {account} on {network}…");
    let response = TokenAssociateTransaction::new()
        .account_id(wallet.account_id)
        .token_ids([token])
        .execute(&client)
        .await
        .context("submitting the association")?;

    match response.get_receipt(&client).await {
        Ok(receipt) => println!(
            "done: {:?} — https://hashscan.io/{network}/transaction/{}",
            receipt.status, response.transaction_id
        ),
        Err(hedera::Error::ReceiptStatus {
            status: Status::TokenAlreadyAssociatedToAccount,
            ..
        }) => println!("{account} was already associated with {token} — nothing to do"),
        Err(error) => return Err(error).context("association failed"),
    }
    Ok(())
}
