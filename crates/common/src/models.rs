//! Picks a chat model an OpenAI-compatible server will actually serve,
//! instead of trusting a name written into a config file.
//!
//! Hosted catalogs change: a model this project used dropped out of Hugging
//! Face's router for a while (its providers went offline) and came back. So a model setting is an ordered preference list
//! (`a,b,c`), optionally ending in `auto`. The picker reads the server's live
//! catalog (`GET /models` — Hugging Face's router, LM Studio, Ollama and vLLM
//! all serve one), keeps the preferences that are listed and live, and
//! confirms each with a one-token call, because a model can be listed yet not
//! enabled for this account. With `auto`, any other live text model may
//! stand in, cheapest first. If the chosen model stops answering later, the
//! caller asks for the next one with [`ModelPicker::resolve`].

use std::sync::RwLock;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde::Deserialize;

/// How many catalog models `auto` will try before giving up.
const AUTO_TRIES: usize = 6;

/// The model an upstream serves right now, and how to find another.
#[derive(Debug)]
pub struct ModelPicker {
    base_url: String,
    api_key: Option<String>,
    preferences: Vec<String>,
    auto: bool,
    current: RwLock<String>,
    http: reqwest::Client,
}

#[derive(Deserialize)]
struct Catalog {
    data: Vec<CatalogModel>,
}

#[derive(Deserialize)]
struct CatalogModel {
    id: String,
    /// Hugging Face lists who serves each model; other servers don't.
    #[serde(default)]
    providers: Option<Vec<CatalogProvider>>,
    #[serde(default)]
    architecture: Option<Architecture>,
}

#[derive(Deserialize)]
struct CatalogProvider {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    pricing: Option<Pricing>,
}

#[derive(Deserialize)]
struct Pricing {
    #[serde(default)]
    output: Option<f64>,
}

#[derive(Deserialize)]
struct Architecture {
    #[serde(default)]
    input_modalities: Option<Vec<String>>,
    #[serde(default)]
    output_modalities: Option<Vec<String>>,
}

impl CatalogModel {
    fn live(&self) -> bool {
        self.providers
            .as_ref()
            .is_none_or(|list| list.iter().any(|p| p.status.as_deref().is_none_or(|s| s == "live")))
    }

    fn text_to_text(&self) -> bool {
        let has_text = |m: &Option<Vec<String>>| m.as_ref().is_none_or(|m| m.iter().any(|x| x == "text"));
        self.architecture
            .as_ref()
            .is_none_or(|a| has_text(&a.input_modalities) && has_text(&a.output_modalities))
    }

    /// Cheapest live output price, for ordering `auto` candidates.
    fn cheapest(&self) -> f64 {
        self.providers
            .iter()
            .flatten()
            .filter(|p| p.status.as_deref().is_none_or(|s| s == "live"))
            .filter_map(|p| p.pricing.as_ref().and_then(|x| x.output))
            .fold(f64::INFINITY, f64::min)
    }
}

impl ModelPicker {
    /// `spec` is `a,b,c`, optionally with `auto` (alone or last). Empty means `auto`.
    #[must_use]
    pub fn new(base_url: &str, api_key: Option<String>, spec: &str) -> Self {
        let entries: Vec<String> = spec.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect();
        let auto = entries.is_empty() || entries.iter().any(|e| e.eq_ignore_ascii_case("auto"));
        let preferences: Vec<String> = entries.into_iter().filter(|e| !e.eq_ignore_ascii_case("auto")).collect();
        Self {
            base_url: base_url.trim_end_matches('/').to_owned(),
            api_key,
            current: RwLock::new(preferences.first().cloned().unwrap_or_default()),
            preferences,
            auto,
            http: reqwest::Client::new(),
        }
    }

    /// The model to use now (the first preference until [`resolve`](Self::resolve) runs).
    #[must_use]
    pub fn current(&self) -> String {
        self.current.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
    }

    /// Base URL requests go to, including `/v1`.
    #[must_use]
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Bearer token, if the server wants one.
    #[must_use]
    pub fn api_key(&self) -> Option<&str> {
        self.api_key.as_deref()
    }

    /// Finds a model that answers, skipping `exclude`, and makes it current.
    ///
    /// # Errors
    ///
    /// No candidate answered (or there were none).
    pub async fn resolve(&self, exclude: &[String]) -> Result<String> {
        let mut candidates: Vec<String> = match self.catalog().await {
            Ok(catalog) => {
                let usable: Vec<&CatalogModel> = catalog.iter().filter(|m| m.live() && m.text_to_text()).collect();
                let mut out: Vec<String> = self
                    .preferences
                    .iter()
                    .filter(|p| usable.iter().any(|m| &m.id == *p))
                    .cloned()
                    .collect();
                let missing: Vec<&String> = self.preferences.iter().filter(|p| !out.contains(p)).collect();
                if !missing.is_empty() {
                    tracing::warn!(?missing, "preferred models aren't live in the catalog");
                }
                if self.auto {
                    let mut rest: Vec<&CatalogModel> = usable.into_iter().filter(|m| !out.contains(&m.id)).collect();
                    rest.sort_by(|a, b| a.cheapest().total_cmp(&b.cheapest()));
                    out.extend(rest.into_iter().take(AUTO_TRIES).map(|m| m.id.clone()));
                }
                out
            }
            Err(error) => {
                tracing::warn!(%error, "model catalog unavailable; trying the preferences as given");
                self.preferences.clone()
            }
        };
        candidates.retain(|c| !exclude.contains(c));

        for candidate in &candidates {
            match self.probe(candidate).await {
                Ok(()) => {
                    *self.current.write().unwrap_or_else(std::sync::PoisonError::into_inner) = candidate.clone();
                    tracing::info!(model = %candidate, "model selected");
                    return Ok(candidate.clone());
                }
                Err(error) => tracing::warn!(model = %candidate, %error, "model didn't answer"),
            }
        }
        bail!(
            "no model answered at {} (tried: {})",
            self.base_url,
            if candidates.is_empty() { "none available".into() } else { candidates.join(", ") }
        )
    }

    async fn catalog(&self) -> Result<Vec<CatalogModel>> {
        let mut request = self.http.get(format!("{}/models", self.base_url)).timeout(Duration::from_secs(10));
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }
        let catalog: Catalog = request.send().await?.error_for_status()?.json().await.context("reading the model catalog")?;
        Ok(catalog.data)
    }

    /// One token, to prove the model is served to this account.
    async fn probe(&self, model: &str) -> Result<()> {
        let mut request = self
            .http
            .post(format!("{}/chat/completions", self.base_url))
            .timeout(Duration::from_secs(20))
            .json(&serde_json::json!({
                "model": model,
                "messages": [{ "role": "user", "content": "Reply with: ok" }],
                "max_tokens": 1,
            }));
        if let Some(key) = &self.api_key {
            request = request.bearer_auth(key);
        }
        let response = request.send().await?;
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            bail!("{status}: {}", body.chars().take(160).collect::<String>());
        }
        Ok(())
    }
}

/// Whether an upstream error means "this model isn't served here (any
/// more)" — worth switching models for — rather than a bad request.
#[must_use]
pub fn model_unavailable(status: u16, body: &str) -> bool {
    let body = body.to_lowercase();
    matches!(status, 404 | 410 | 503)
        || (matches!(status, 400 | 422)
            && body.contains("model")
            && ["not supported", "not_supported", "not found", "does not exist", "unavailable", "no provider"]
                .iter()
                .any(|needle| body.contains(needle)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_spec_is_a_preference_list_with_optional_auto() {
        let p = ModelPicker::new("http://x/v1/", None, " a/b , c/d ");
        assert_eq!((p.preferences.clone(), p.auto, p.current()), (vec!["a/b".to_owned(), "c/d".to_owned()], false, "a/b".to_owned()));
        assert!(ModelPicker::new("http://x", None, "a/b,auto").auto);
        let empty = ModelPicker::new("http://x", None, "");
        assert!(empty.auto && empty.preferences.is_empty());
        assert_eq!(p.base_url(), "http://x/v1");
    }

    #[test]
    fn a_dropped_model_is_told_apart_from_a_bad_request() {
        assert!(model_unavailable(400, r#"{"error":{"message":"The requested model 'x' is not supported by any provider you have enabled.","code":"model_not_supported"}}"#));
        assert!(model_unavailable(404, "Not Found"));
        assert!(!model_unavailable(400, r#"{"error":"max_tokens must be positive"}"#));
        assert!(!model_unavailable(401, "invalid token"));
    }

    #[test]
    fn catalog_entries_are_live_text_models() {
        let m: CatalogModel = serde_json::from_str(
            r#"{"id":"a","providers":[{"status":"offline"},{"status":"live","pricing":{"output":0.4}}],"architecture":{"input_modalities":["text"],"output_modalities":["text"]}}"#,
        )
        .unwrap();
        assert!(m.live() && m.text_to_text());
        assert!((m.cheapest() - 0.4).abs() < f64::EPSILON);
        let image: CatalogModel = serde_json::from_str(r#"{"id":"b","architecture":{"input_modalities":["text"],"output_modalities":["image"]}}"#).unwrap();
        assert!(!image.text_to_text());
        let local: CatalogModel = serde_json::from_str(r#"{"id":"c"}"#).unwrap();
        assert!(local.live() && local.text_to_text(), "servers without provider data count as live");
    }

    /// Real router: a dropped model at the head of the list is skipped.
    /// `HF_TOKEN=hf_... cargo test -p common models -- --ignored`
    #[test]
    #[ignore = "needs HF_TOKEN and the network"]
    fn a_dropped_preference_is_skipped_for_the_next_live_one() {
        let token = std::env::var("HF_TOKEN").expect("HF_TOKEN");
        let picker = ModelPicker::new(
            "https://router.huggingface.co/v1",
            Some(token),
            "leash-tests/no-such-model,google/gemma-3-27b-it,meta-llama/Llama-3.1-8B-Instruct",
        );
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let picked = runtime.block_on(picker.resolve(&[])).expect("a model answers");
        assert_ne!(picked, "leash-tests/no-such-model");
        assert_eq!(picker.current(), picked);
        // Told the current one is gone, it moves on.
        let next = runtime.block_on(picker.resolve(std::slice::from_ref(&picked))).expect("another answers");
        assert_ne!(next, picked);
    }
}
