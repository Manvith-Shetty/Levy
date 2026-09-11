//! The `MandateGuard` axum layer: the gate that runs before x402 ever prices
//! a request. Stacked as the outer `.layer()` on `/v1/infer`, it resolves the
//! `?agent=` ENS subname, walks its whole ancestor chain, and 403s before any
//! price tag is issued if one dead or expired ancestor turns up anywhere in
//! it.

use axum::extract::{Query, Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::Response;
use mandate::{MandateError, MandateNode, MandateResolver, MockResolver};

use crate::routes::{AppState, InferQuery, error};

/// The one resolver type the gateway builds a guard against, whichever
/// `MANDATE_MODE` picked it — `MandateGuard` itself doesn't know or care
/// which.
pub enum AnyResolver {
    /// In-memory resolver for local demos, ahead of a deployed registry.
    Mock(std::sync::Arc<MockResolver>),
    /// The live ENSv2 registry on Sepolia.
    Ens(mandate::SepoliaResolver),
}

impl MandateResolver for AnyResolver {
    async fn resolve(&self, ens_name: &str) -> Result<MandateNode, MandateError> {
        match self {
            Self::Mock(resolver) => resolver.resolve(ens_name).await,
            Self::Ens(resolver) => resolver.resolve(ens_name).await,
        }
    }
}

/// Axum middleware: gates `/v1/infer` on the resolved mandate tree.
///
/// Runs ahead of the x402 paid layer (see `main.rs`'s layer ordering), so an
/// agent whose mandate is dead never even gets a price quoted. On success,
/// records the resolved chain against the quote so the settlement receipt
/// can carry it.
pub async fn gate(
    State(state): State<AppState>,
    Query(query): Query<InferQuery>,
    request: Request,
    next: Next,
) -> Response {
    let Some(guard) = &state.mandate else {
        return next.run(request).await;
    };

    let Some(agent) = query.agent else {
        return error(StatusCode::BAD_REQUEST, "missing ?agent=<ens-subname>");
    };
    let Some(quote_id) = query.quote else {
        return error(StatusCode::BAD_REQUEST, "missing ?quote=<id>");
    };
    let Some(amount) = state.quotes.price_of(&quote_id) else {
        return error(StatusCode::BAD_REQUEST, "unknown or spent quote id");
    };

    match guard.check(&agent, amount).await {
        Ok(path) => {
            state.quotes.record_mandate_path(&quote_id, path);
            next.run(request).await
        }
        Err(violation) => {
            tracing::warn!(%agent, node = %violation.node, reason = ?violation.reason, "mandate check failed");
            error(StatusCode::FORBIDDEN, &violation.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::Router;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use axum::routing::post;
    use mandate::MandateGuard;
    use meter::{AssetInfo, PriceModel};
    use r402_hedera::chain::HederaChainReference;
    use time::{Duration, OffsetDateTime};
    use tower::ServiceExt;

    use super::*;
    use crate::config::Config;
    use crate::hcs::ReceiptLog;
    use crate::quotes::QuoteStore;

    fn healthy_node() -> MandateNode {
        MandateNode {
            budget: 1_000,
            allowed_services: vec!["inference".into()],
            rate_per_minute: 1_000,
            max_per_call: 1_000,
            expires_at: OffsetDateTime::now_utc() + Duration::days(1),
            parent: None,
        }
    }

    fn test_state(mock: MockResolver) -> AppState {
        let mock = Arc::new(mock);
        let guard = Arc::new(MandateGuard::new(AnyResolver::Mock(Arc::clone(&mock))));

        let cfg = Config {
            provider: "test-provider".into(),
            model: "test-model".into(),
            port: 0,
            base_url: "http://localhost:0".parse().unwrap(),
            network: "hedera:testnet".into(),
            chain: HederaChainReference::Testnet,
            pay_to: "0.0.1001".into(),
            pay_to_address: "0.0.1001".parse().unwrap(),
            asset: AssetInfo {
                id: "0.0.0".into(),
                symbol: "HBAR".into(),
                decimals: 8,
            },
            pricing: PriceModel {
                per_1k_input: 1,
                per_1k_output: 1,
                minimum: 1,
            },
            facilitator_url: "http://localhost:0".into(),
            quote_ttl_secs: 60,
            hcs: None,
            upstream: None,
        };

        AppState {
            config: Arc::new(cfg),
            quotes: Arc::new(QuoteStore::new(60)),
            receipts: Arc::new(ReceiptLog::default()),
            mandate: Some(guard),
            mandate_mock: Some(mock),
        }
    }

    fn app(state: AppState) -> Router {
        Router::new()
            .route(
                "/v1/infer",
                post(|| async { StatusCode::OK })
                    .layer(axum::middleware::from_fn_with_state(state.clone(), gate)),
            )
            .with_state(state)
    }

    async fn infer(state: &AppState, quote: &str, agent: &str) -> Response {
        app(state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/v1/infer?quote={quote}&agent={agent}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn a_healthy_mandate_reaches_the_handler_and_records_its_path() {
        let mock = MockResolver::new();
        mock.set("root.eth", healthy_node());
        let state = test_state(mock);
        state.quotes.insert("q1".into(), "hi".into(), 16, 100);

        let response = infer(&state, "q1", "root.eth").await;

        assert_eq!(response.status(), StatusCode::OK);
        let path = state.quotes.get("q1").unwrap().mandate_path.unwrap();
        let names: Vec<&str> = path.iter().map(|hop| hop.name.as_str()).collect();
        assert_eq!(names, vec!["root.eth"], "mandate path root-first");
    }

    #[tokio::test]
    async fn a_dead_mandate_is_blocked_before_the_handler_ever_runs() {
        let mock = MockResolver::new();
        mock.set("root.eth", healthy_node());
        mock.revoke("root.eth");
        let state = test_state(mock);
        state.quotes.insert("q1".into(), "hi".into(), 16, 100);

        let response = infer(&state, "q1", "root.eth").await;

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(state.quotes.get("q1").unwrap().mandate_path.is_none());
    }

    #[tokio::test]
    async fn an_unknown_agent_is_blocked() {
        let state = test_state(MockResolver::new());
        state.quotes.insert("q1".into(), "hi".into(), 16, 100);

        let response = infer(&state, "q1", "nobody.eth").await;

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn an_unknown_quote_is_rejected_before_the_mandate_is_even_resolved() {
        let mock = MockResolver::new();
        mock.set("root.eth", healthy_node());
        let state = test_state(mock);

        let response = infer(&state, "no-such-quote", "root.eth").await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}
