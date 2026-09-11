//! Scheduled Transactions allowance drip: on a timer, schedules a
//! `TransferTransaction` crediting an agent's Hedera account with its next
//! slice of spendable balance.
//!
//! Hedera's `ScheduleCreateTransaction` is single-shot, not cron-native, so
//! "recurring" here means this loop creates a fresh schedule every tick —
//! each one independently visible on HashScan as a scheduled transfer.
//!
//! ```bash
//! cargo run -p gateway --bin allowance-drip
//! ```

use std::str::FromStr;
use std::time::Duration;

use anyhow::{Context, Result};
use hedera::{AccountId, Client, Hbar, PrivateKey, ScheduleCreateTransaction, TransferTransaction};

fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,allowance_drip=debug".into()),
        )
        .init();
    tokio::runtime::Runtime::new()?.block_on(run())
}

async fn run() -> Result<()> {
    let network = std::env::var("HEDERA_NETWORK").unwrap_or_else(|_| "testnet".into());
    let operator_id =
        std::env::var("HEDERA_OPERATOR_ID").context("HEDERA_OPERATOR_ID must be set")?;
    let operator_key =
        std::env::var("HEDERA_OPERATOR_KEY").context("HEDERA_OPERATOR_KEY must be set")?;
    let agent_id = std::env::var("DRIP_AGENT_ACCOUNT_ID")
        .context("DRIP_AGENT_ACCOUNT_ID must be set (the account being credited)")?;
    let amount_tinybar: i64 = std::env::var("DRIP_AMOUNT_TINYBAR")
        .unwrap_or_else(|_| "10000000".into()) // 0.1 HBAR
        .parse()
        .context("DRIP_AMOUNT_TINYBAR must be an integer")?;
    let interval_secs: u64 = std::env::var("DRIP_INTERVAL_SECS")
        .unwrap_or_else(|_| "300".into())
        .parse()
        .context("DRIP_INTERVAL_SECS must be an integer")?;

    let client = if network.contains("mainnet") {
        Client::for_mainnet()
    } else {
        Client::for_testnet()
    };
    let key = parse_private_key(&operator_key)?;
    let operator = AccountId::from_str(&operator_id).context("invalid HEDERA_OPERATOR_ID")?;
    let agent = AccountId::from_str(&agent_id).context("invalid DRIP_AGENT_ACCOUNT_ID")?;
    client.set_operator(operator, key);

    let amount = Hbar::from_tinybars(amount_tinybar);
    let explorer = if network.contains("mainnet") { "mainnet" } else { "testnet" };

    tracing::info!(
        %operator, %agent, %amount, interval_secs,
        "starting allowance drip"
    );

    let mut ticks = tokio::time::interval(Duration::from_secs(interval_secs));
    loop {
        ticks.tick().await;

        let mut transfer = TransferTransaction::new();
        transfer
            .hbar_transfer(operator, -amount)
            .hbar_transfer(agent, amount);

        let mut schedule = ScheduleCreateTransaction::new();
        schedule
            .scheduled_transaction(transfer)
            .schedule_memo(format!("Leash allowance drip -> {agent}"));

        match schedule.execute(&client).await {
            Ok(response) => match response.get_receipt(&client).await {
                Ok(receipt) => {
                    if let Some(schedule_id) = receipt.schedule_id {
                        tracing::info!(
                            %schedule_id, %agent, %amount,
                            url = %format_args!("https://hashscan.io/{explorer}/schedule/{schedule_id}"),
                            "allowance drip scheduled"
                        );
                    } else {
                        tracing::warn!("schedule created but receipt carried no schedule id");
                    }
                }
                Err(error) => tracing::warn!(%error, "allowance drip schedule did not reach consensus"),
            },
            Err(error) => tracing::warn!(%error, "allowance drip schedule submit failed"),
        }
    }
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
