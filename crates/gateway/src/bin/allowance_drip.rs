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
use gateway::env::{DripEnv, OperatorEnv};
use gateway::hcs::client_for;
use hedera::{AccountId, Hbar, ScheduleCreateTransaction, TransferTransaction};

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
    let operator = OperatorEnv::from_env().map_err(|e| anyhow::anyhow!(e))?;
    let drip = DripEnv::from_env().map_err(|e| anyhow::anyhow!(e))?;

    let client = client_for(&operator.network, &operator.operator_id, &operator.operator_key)?;
    let operator_id =
        AccountId::from_str(&operator.operator_id).context("invalid HEDERA_OPERATOR_ID")?;
    let agent = AccountId::from_str(&drip.agent_account_id)
        .context("invalid DRIP_AGENT_ACCOUNT_ID")?;

    let amount = Hbar::from_tinybars(drip.amount_tinybar);
    let explorer = if operator.network.contains("mainnet") {
        "mainnet"
    } else {
        "testnet"
    };

    tracing::info!(
        %operator_id, %agent, %amount, interval_secs = drip.interval_secs,
        "starting allowance drip"
    );

    let mut ticks = tokio::time::interval(Duration::from_secs(drip.interval_secs));
    loop {
        ticks.tick().await;

        let mut transfer = TransferTransaction::new();
        transfer
            .hbar_transfer(operator_id, -amount)
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
