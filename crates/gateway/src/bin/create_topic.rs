//! One-shot helper: creates the HCS topic that carries settlement receipts.
//!
//! ```bash
//! cargo run -p service --bin create-topic
//! # -> put the printed id in HCS_TOPIC_ID
//! ```

use std::str::FromStr;

use anyhow::{Context, Result};
use hedera::{AccountId, Client, PrivateKey, TopicCreateTransaction};

fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tokio::runtime::Runtime::new()?.block_on(run())
}

async fn run() -> Result<()> {
    let network = std::env::var("HEDERA_NETWORK").unwrap_or_else(|_| "testnet".into());
    let operator_id =
        std::env::var("HEDERA_OPERATOR_ID").context("HEDERA_OPERATOR_ID must be set")?;
    let operator_key =
        std::env::var("HEDERA_OPERATOR_KEY").context("HEDERA_OPERATOR_KEY must be set")?;

    let client = if network.contains("mainnet") {
        Client::for_mainnet()
    } else {
        Client::for_testnet()
    };

    let key = parse_private_key(&operator_key)?;
    client.set_operator(
        AccountId::from_str(&operator_id).context("invalid HEDERA_OPERATOR_ID")?,
        key.clone(),
    );

    let receipt = TopicCreateTransaction::new()
        .topic_memo("x402 Hedera metered inference — settlement receipts")
        .submit_key(key.public_key())
        .execute(&client)
        .await
        .context("topic create failed")?
        .get_receipt(&client)
        .await
        .context("topic create did not reach consensus")?;

    let topic_id = receipt.topic_id.context("receipt carried no topic id")?;
    let explorer = if network.contains("mainnet") {
        "mainnet"
    } else {
        "testnet"
    };

    println!("HCS_TOPIC_ID={topic_id}");
    println!("https://hashscan.io/{explorer}/topic/{topic_id}");
    Ok(())
}

fn parse_private_key(raw: &str) -> Result<PrivateKey> {
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
    .context("could not parse HEDERA_OPERATOR_KEY")
}
