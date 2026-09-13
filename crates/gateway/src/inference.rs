//! The work being sold.
//!
//! Either an OpenAI-compatible upstream — Hugging Face's router when
//! `HF_TOKEN` is set, or any server at `OPENAI_BASE_URL` (LM Studio, Ollama,
//! vLLM), on whichever model `common::models` picked from its live catalog —
//! or a deterministic local stub so the payment flow can be demoed
//! without a model. What matters for x402 is that the handler runs only after
//! payment is verified, and that settlement waits for it: if the model fails,
//! the handler answers 502 and the payment is never settled.

use anyhow::{Context, Result};
use common::models::{ModelPicker, model_unavailable};
use meter::{Usage, count_tokens};
use serde::Deserialize;

/// A generated completion plus its token accounting.
#[derive(Debug, Clone)]
pub struct Completion {
    /// Generated text.
    pub text: String,
    /// Tokens consumed by this request.
    pub usage: Usage,
    /// Model that produced it.
    pub model: String,
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

/// Runs `prompt`, capping generation at `max_output_tokens`, on the model
/// the picker has chosen. If that model is no longer served, picks another
/// and retries once — the payment settles only after this returns.
///
/// # Errors
///
/// Returns an error when the upstream is unreachable, returns a
/// non-success status, or no model answers.
pub async fn run(
    models: Option<&ModelPicker>,
    stub_model: &str,
    prompt: &str,
    max_output_tokens: u64,
) -> Result<Completion> {
    let Some(models) = models else {
        return Ok(run_stub(stub_model, prompt, max_output_tokens));
    };
    let model = models.current();
    match run_upstream(models, &model, prompt, max_output_tokens).await {
        Err(Failure::ModelGone(why)) => {
            tracing::warn!(%model, %why, "model no longer served; picking another");
            let next = models
                .resolve(std::slice::from_ref(&model))
                .await
                .with_context(|| format!("{model} is no longer served"))?;
            run_upstream(models, &next, prompt, max_output_tokens).await.map_err(Failure::into_error)
        }
        other => other.map_err(Failure::into_error),
    }
}

enum Failure {
    /// The upstream doesn't serve this model (any more).
    ModelGone(String),
    Other(anyhow::Error),
}

impl Failure {
    fn into_error(self) -> anyhow::Error {
        match self {
            Self::ModelGone(why) => anyhow::anyhow!("model not served: {why}"),
            Self::Other(error) => error,
        }
    }
}

impl From<anyhow::Error> for Failure {
    fn from(error: anyhow::Error) -> Self {
        Self::Other(error)
    }
}

async fn run_upstream(
    models: &ModelPicker,
    model: &str,
    prompt: &str,
    max_output_tokens: u64,
) -> Result<Completion, Failure> {
    let url = format!("{}/chat/completions", models.base_url());
    let mut request = reqwest::Client::new().post(&url).json(&serde_json::json!({
        "model": model,
        "messages": [{ "role": "user", "content": prompt }],
        "max_tokens": max_output_tokens,
    }));
    if let Some(key) = models.api_key() {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .await
        .with_context(|| format!("upstream request to {url} failed"))?;
    let status = response.status();
    let body = response.text().await.context("reading upstream body")?;
    if !status.is_success() {
        if model_unavailable(status.as_u16(), &body) {
            return Err(Failure::ModelGone(format!("{status}: {}", body.chars().take(200).collect::<String>())));
        }
        return Err(anyhow::anyhow!("upstream returned {status}: {body}").into());
    }

    let parsed: ChatResponse = serde_json::from_str(&body).context("parsing upstream body")?;
    let text = strip_reasoning(
        &parsed
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content)
            .unwrap_or_default(),
    );
    if text.is_empty() {
        return Err(anyhow::anyhow!("upstream returned an empty completion").into());
    }

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

    Ok(Completion { text, usage, model: model.to_owned() })
}

/// Drops a `<think>…</think>` block some reasoning models put before the
/// answer, so the buyer gets the answer.
fn strip_reasoning(text: &str) -> String {
    match (text.find("<think>"), text.find("</think>")) {
        (Some(start), Some(end)) if end > start => {
            format!("{}{}", &text[..start], &text[end + "</think>".len()..])
                .trim()
                .to_owned()
        }
        _ => text.trim().to_owned(),
    }
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
         before this handler ran. Set HF_TOKEN (Hugging Face) or OPENAI_BASE_URL \
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
        model: model.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_blocks_are_dropped_from_the_answer() {
        assert_eq!(strip_reasoning("<think>hmm, ok</think>\n\nThe answer."), "The answer.");
        assert_eq!(strip_reasoning("  Plain answer. "), "Plain answer.");
        assert_eq!(strip_reasoning("<think>unterminated"), "<think>unterminated");
    }

    #[test]
    fn stub_respects_the_output_budget() {
        let small = run_stub("echo-1", "explain hashgraph consensus", 8);
        assert!(small.usage.output_tokens <= 12, "budget must cap output");
        let large = run_stub("echo-1", "explain hashgraph consensus", 256);
        assert!(large.usage.output_tokens > small.usage.output_tokens);
    }
}
