//! One-shot helper: creates the HCS topic that carries settlement receipts.
//!
//! ```bash
//! cargo run -p gateway --bin create-topic
//! # -> put the printed id in HCS_TOPIC_ID
//! ```

use anyhow::{Context, Result};
use gateway::env::OperatorEnv;
use gateway::hcs::{client_for, parse_private_key};
use hedera::TopicCreateTransaction;

fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tokio::runtime::Runtime::new()?.block_on(run())
}

async fn run() -> Result<()> {
    let env = OperatorEnv::from_env().map_err(|e| anyhow::anyhow!(e))?;
    let client = client_for(&env.network, &env.operator_id, &env.operator_key)?;
    let key = parse_private_key(&env.operator_key)?;

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
    let explorer = if env.network.contains("mainnet") {
        "mainnet"
    } else {
        "testnet"
    };

    println!("HCS_TOPIC_ID={topic_id}");
    println!("https://hashscan.io/{explorer}/topic/{topic_id}");
    Ok(())
}
