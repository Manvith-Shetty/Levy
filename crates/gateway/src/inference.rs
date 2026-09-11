//! The work being sold.
//!
//! Either an OpenAI-compatible upstream (LM Studio, Ollama, vLLM) when
//! `OPENAI_BASE_URL` is set, or a deterministic local stub so the payment flow
//! can be demoed without a GPU. What matters for x402 is that the handler runs
//! only after payment is verified.

use anyhow::{Context, Result};
use meter::{Usage, count_tokens};
use serde::Deserialize;

use crate::config::Upstream;

/// A generated completion plus its token accounting.
#[derive(Debug, Clone)]
pub struct Completion {
    /// Generated text.
    pub text: String,
    /// Tokens consumed by this request.
    pub usage: Usage,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
    usage: Option<ApiUsage>,
}

#[derive(Deserialize)]
struct Choice {
    message: Message,
}

#[derive(Deserialize)]
struct Message {
    content: String,
}

#[derive(Deserialize)]
struct ApiUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
}

/// Runs `prompt`, capping generation at `max_output_tokens`.
///
/// # Errors
///
/// Returns an error when a configured upstream is unreachable or returns a
/// non-success status.
pub async fn run(
    upstream: Option<&Upstream>,
    model: &str,
    prompt: &str,
    max_output_tokens: u64,
) -> Result<Completion> {
    match upstream {
        Some(upstream) => run_upstream(upstream, prompt, max_output_tokens).await,
        None => Ok(run_stub(model, prompt, max_output_tokens)),
    }
}

async fn run_upstream(
    upstream: &Upstream,
    prompt: &str,
    max_output_tokens: u64,
) -> Result<Completion> {
    let url = format!("{}/chat/completions", upstream.base_url.trim_end_matches('/'));
    let mut request = reqwest::Client::new().post(&url).json(&serde_json::json!({
        "model": upstream.model,
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": max_output_tokens,
    }));
    if let Some(key) = &upstream.api_key {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .await
        .with_context(|| format!("upstream request to {url} failed"))?;
    let status = response.status();
    let body = response.text().await.context("reading upstream body")?;
    anyhow::ensure!(status.is_success(), "upstream returned {status}: {body}");

    let parsed: ChatResponse = serde_json::from_str(&body).context("parsing upstream body")?;
    let text = parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .unwrap_or_default();

    let usage = parsed.usage.map_or_else(
        || Usage {
            input_tokens: count_tokens(prompt),
            output_tokens: count_tokens(&text),
        },
        |u| Usage {
            input_tokens: u.prompt_tokens.unwrap_or_else(|| count_tokens(prompt)),
            output_tokens: u.completion_tokens.unwrap_or_else(|| count_tokens(&text)),
        },
    );

    Ok(Completion { text, usage })
}

/// Deterministic stand-in model: no network, no weights, but a real per-request
/// output length so the usage numbers in the receipt are not fabricated.
fn run_stub(model: &str, prompt: &str, max_output_tokens: u64) -> Completion {
    let words: Vec<&str> = prompt.split_whitespace().collect();
    let subject = words
        .iter()
        .filter(|w| w.len() > 3)
        .take(6)
        .copied()
        .collect::<Vec<_>>()
        .join(" ");

    let mut text = format!(
        "[{model}] Answering a {} word prompt about \"{}\".\n\n",
        words.len(),
        if subject.is_empty() { "the request" } else { &subject }
    );
    text.push_str(
        "This completion was produced only because an x402 payment settled on \
         Hedera first: the gate verified a payer-signed TransferTransaction \
         before this handler ran. Point OPENAI_BASE_URL at a local model server \
         to replace this stub with real inference.",
    );

    // Respect the output budget the buyer paid for.
    let budget = (max_output_tokens.saturating_mul(4)) as usize;
    if text.chars().count() > budget {
        text = text.chars().take(budget).collect();
    }

    Completion {
        usage: Usage {
            input_tokens: count_tokens(prompt),
            output_tokens: count_tokens(&text),
        },
        text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stub_respects_the_output_budget() {
        let small = run_stub("echo-1", "explain hashgraph consensus", 8);
        assert!(small.usage.output_tokens <= 12, "budget must cap output");
        let large = run_stub("echo-1", "explain hashgraph consensus", 256);
        assert!(large.usage.output_tokens > small.usage.output_tokens);
    }
}
