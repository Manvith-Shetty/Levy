//! Live Sepolia verification for the mandate tree — ignored by default.
//!
//! Healthy tree:
//! ```sh
//! LEASH_RPC_URL=https://sepolia.example.com \
//! LEASH_TOP_REGISTRY=0xL1... \
//! LEASH_LEAF=sub.agent.root \
//! cargo test -p mandate --test live_sepolia -- --ignored --nocapture
//! ```
//! Revoked-root proof (run while the root is unregistered/expired):
//! ```sh
//! LEASH_EXPECT_DARK=1 ... (same)
//! ```
//! Asserts the guard walks the real on-chain hierarchy (root -> agent ->
//! sub) and, when dark, names exactly the dead ancestor (`root`, Expired)
//! instead of blaming the leaf.

use mandate::{MandateGuard, MandateResolver, http};
use url::Url;

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("set {name} to run the live test"))
}

#[tokio::test]
#[ignore]
async fn guard_matches_the_live_tree_state() {
    let rpc: Url = env("LEASH_RPC_URL").parse().expect("bad LEASH_RPC_URL");
    let registry: mandate::Address = env("LEASH_TOP_REGISTRY").parse().expect("bad registry");
    let leaf = env("LEASH_LEAF");
    let expect_dark = std::env::var("LEASH_EXPECT_DARK").is_ok();

    let resolver = http(rpc, registry);
    // Sanity: the leaf resolves at all before the guard walks the chain.
    // (In dark state this is expected to fail — skip it there.)
    if !expect_dark {
        let node = resolver
            .resolve(&leaf)
            .await
            .expect("leaf must resolve on Sepolia");
        assert!(node.budget > 0, "leaf budget must be seeded");
    }

    let guard = MandateGuard::new(resolver);
    match guard.check(&leaf, 1).await {
        Ok(hops) => {
            assert!(
                !expect_dark,
                "tree is dark but the guard authorized — attribution broken"
            );
            let names: Vec<_> = hops.iter().map(|h| h.name.as_str()).collect();
            assert_eq!(
                names,
                ["root", "agent.root", &leaf][..],
                "chain must walk root first, leaf last"
            );
            println!("live chain ok: {names:?}");
        }
        Err(e) => {
            assert!(
                expect_dark,
                "healthy tree must authorize, got violation: {e}"
            );
            assert_eq!(e.node, "root", "dark tree must blame the root");
            assert_eq!(
                e.reason,
                mandate::Violation::Expired,
                "dead root must report Expired"
            );
            println!("dark tree ok: blocked by root ({e})");
        }
    }
}
