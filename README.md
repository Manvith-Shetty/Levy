# Leash — agent spending authority as an ENSv2 namespace tree

Live on ENSv2 Sepolia. Each agent is a non-transferable, expiring subname whose
resolver text records are its budget. Agents mint sub-agents whose budgets and
expiries are enforced **on-chain as strict subsets** of their parent's. Every
payment settles on Hedera via x402, writes to HCS, and clears a middleware that
walks the whole ancestor chain first.

## Live on Sepolia (chain id 11155111)

| What | Address |
|---|---|
| L1 registry (holds `root`) | [`0x51d32dfa5baf7e3e1d718fdd37d0c346c5ba7838`](https://sepolia.etherscan.io/address/0x51d32dfa5baf7e3e1d718fdd37d0c346c5ba7838) |
| L2 registry (holds `agent`) | [`0xec8F768460DD212Fc83d47B048045EB6b6B13097`](https://sepolia.etherscan.io/address/0xec8F768460DD212Fc83d47B048045EB6b6B13097) |
| L3 registry (holds `sub`) | [`0x1189D5A05e60F7144b40b5F0FA144d1e2B695CF8`](https://sepolia.etherscan.io/address/0x1189D5A05e60F7144b40b5F0FA144d1e2B695CF8) |
| `MandateRegistrar` | [`0x33699c74f777c581db3b9c7079d87b778cae2312`](https://sepolia.etherscan.io/address/0x33699c74f777c581db3b9c7079d87b778cae2312) |
| Tree | `root` → `agent.root` → `sub.agent.root` (100000 / 50000 / 10000 budget, +90d / +60d / +30d) |

Verify without a wallet: `cast call $L3 'getResolver(string)(address)' sub`,
`cast call $L1 'getSubregistry(string)(address)' root`, or run the live test below.

## How it works

- **`contracts/src/MandateRegistrar.sol`** — `registerChild` enforces `child.budget ≤
  parent.budget` (live resolver text read) and `child.expiry ≤ parent.expiry` (live
  registry read), then mints with a bitmap that omits transfer roles. Parent bindings
  are owner-set once, so callers can never substitute a richer parent. 8/8 forge tests.
- **`contracts/script/DeployMandate.s.sol`** — one broadcast: 3 UserRegistry proxies +
  3 per-name resolver proxies via the Verifiable Factory, registrar auth, tree minting,
  hierarchy wiring (`setSubregistry`/`setParent`), record seeding, single-key ops delegation.
- **`crates/mandate`** — `MandateGuard` walks the ancestor chain fresh on every payment;
  `EnsResolver` walks down real `getSubregistry` pointers (no hardcoded levels) and maps
  expired-but-registered names to lapsed nodes so the guard reports *Expired*, not missing.
- **`crates/gateway`** — x402-gated inference; `MANDATE_MODE=mock` (seeded in-memory tree),
  `=ens` (this deployment), `=off`. HCS receipts + scheduled drip when Hedera keys set.

## Run it

```sh
cargo test --workspace          # all green (needs protoc for hedera-proto build)
cd contracts && forge test      # registrar unit tests

# Live tree check (needs any Sepolia RPC + the L1 address above):
LEASH_RPC_URL=... LEASH_TOP_REGISTRY=0x51d32...ba7838 LEASH_LEAF=sub.agent.root \
  cargo test -p mandate --test live_sepolia -- --ignored --nocapture
# expect: live chain ok: ["root", "agent.root", "sub.agent.root"]

# Gateway against the live tree:
MANDATE_MODE=ens SEPOLIA_RPC_URL=... MANDATE_REGISTRY_ADDRESS=0x51d32...ba7838 \
  cargo run -p gateway
```

Redeploy from scratch: fill `SEPOLIA_RPC_URL` + `DEPLOYER_KEY` (testnet only, never
commit) and follow `contracts/DEPLOY.md`.

## Demo (≤5 min)

1. One real paid `/v1/infer` clearing the live tree. 2. Revoke `root` (one
`unregister` tx — no loop over children) and show the next payment blocked naming
the root. 3. Replay the HCS trail. Budgets: `budget/allowedServices/ratePerMinute/maxPerCall`
text records; expiry doubles as the Selfie-Check heartbeat deadline at the root.
