# Leash — agent spending authority as an ENSv2 namespace tree

Live on ENSv2 Sepolia and Hedera testnet. Each agent is a non-transferable, expiring subname whose
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

## Hedera: x402-gated inference that agents pay for

A real service on Hedera testnet, sold per token over x402 and settled by the
**Blocky402** facilitator in **USDC (HTS `0.0.429274`)**. There are no API keys,
no accounts and no subscriptions: an agent discovers providers, prices its
prompt with each one, pays the cheapest, and gets served. Before a price is
ever named, the gateway checks the agent's ENS mandate and every parent above it.

| What | Value |
|---|---|
| Network | Hedera testnet (`hedera:testnet`), x402 v2 `exact` scheme |
| Facilitator | `https://api.testnet.blocky402.com`, which also pays the Hedera network fee |
| Settlement asset | USDC, HTS token [`0.0.429274`](https://hashscan.io/testnet/token/0.0.429274), 6 decimals |
| Provider payee | [`0.0.10492140`](https://hashscan.io/testnet/account/0.0.10492140) |
| Shared agent wallet (payer) | [`0.0.10499031`](https://hashscan.io/testnet/account/0.0.10499031) |
| Audit trail (HCS topic) | [`0.0.10494264`](https://hashscan.io/testnet/topic/0.0.10494264): every receipt and every refusal |

### Architecture

```mermaid
flowchart LR
  UI[Dashboard<br/>frontend/] -- "POST /v1/run (SSE)" --> R[agent-runner<br/>crates/agent]
  T -- "announcements (discovery)" --> R
  R -- "quote + /v1/authorize" --> A[provider A :4021<br/>inference]
  R -- "quote + /v1/authorize" --> B[providers B, C :4022-4023<br/>inference]
  R -- "quote + /v1/authorize" --> D[provider D :4024<br/>compute]
  A & B & D -- "policy engine" --> ENS[(ENSv2 tree<br/>Sepolia)]
  A & B & D -- "verify + settle" --> F[Blocky402]
  F -- "USDC transfer" --> H[(Hedera testnet)]
  A & B & D -- "announce / receipt / refusal" --> T[(HCS topic)]
  UI -- "mirror node" --> T
  UI -- "RPC" --> ENS
```

- **`crates/gateway`**: the paid service. `GET /.well-known/x402` is the
  manifest (discovery), `POST /v1/quote` prices a prompt, and `POST /v1/infer`
  is gated by the mandate guard and then the x402 layer. It publishes receipts
  and refusals to HCS. The model behind the paywall is real when `HF_TOKEN`
  is set: Hugging Face's Inference Providers router (`HF_MODEL`, default
  `meta-llama/Llama-3.1-8B-Instruct`; the demo providers serve Qwen3 4B and
  Qwen3 235B). Any OpenAI-compatible server works via `OPENAI_BASE_URL`, and a
  deterministic stub answers when neither is set. Payment settles only after
  the model answers: if it fails, the gateway returns 502 and nothing is
  charged.
- **`crates/agent`**: the buyer. `agent` is the CLI; `agent-runner` is the same
  flow behind HTTP, streaming each step to the dashboard as server-sent events.
  Both hold the shared wallet key. The browser never sees it.
- **`crates/meter`**: per-token pricing. A quote is
  `input × per_1k_input + max_output × per_1k_output` (with a minimum), so two
  prompts cost two different amounts. The response reports tokens used and the
  output credit that was paid for but not consumed.
- **`frontend`**: the dashboard. **Run a paid request** drives the runner and
  shows every step live, then finds the run's own message on HCS.

### Payment flow

```mermaid
sequenceDiagram
  participant Ag as Agent (runner)
  participant G as Gateway
  participant M as ENS mandate
  participant F as Blocky402
  participant H as Hedera
  participant T as HCS topic
  Ag->>G: GET /.well-known/x402, POST /v1/quote
  G-->>Ag: quote (amount in USDC, per token)
  Ag->>G: POST /v1/infer?quote=…&agent=sub.agent.root
  Ag->>G: POST /v1/authorize (dry run: six checks, every node)
  G-->>Ag: APPROVED or DENIED + checklist
  G->>M: walk sub.agent.root → agent.root → root again, on the real request
  alt any check fails on any node
    G-->>Ag: 403 names the blocking ancestor
    G->>T: refusal
  else mandate allows it
    G-->>Ag: 402 Payment Required (exact, USDC, payTo, feePayer)
    Ag->>G: retry with a signed TransferTransaction
    G->>F: verify + settle
    F->>H: submit transfer
    G-->>Ag: 200 completion + payment-response (tx id)
    G->>T: receipt (tx id, usage, mandate path)
  end
```

### Run the paid demo locally

```sh
# 1. Provider A: the main gateway (crates/gateway/.env: PAYMENT_ASSET=usdc,
#    MANDATE_MODE=ens, HCS keys; see .env.example)
cd crates/gateway && cargo run -p gateway

# 2. Providers B, C (inference), leash-compute (containers) and leash-ops
#    (repairs on demo/shop, which it brings up): same binary, other names,
#    categories and prices. Each announces itself on HCS.
scripts/demo-providers.sh

# 3. The agent runner (crates/agent/.env: the shared wallet's key)
cd crates/agent && PROVIDERS=http://localhost:4021,http://localhost:4022,http://localhost:4023 \
  cargo run -p agent --bin agent-runner

# 4. The dashboard: Overview → "Run a paid request"
cd frontend && npm install && npm run dev
```

Or run one purchase from the terminal: `cd crates/agent && cargo run -p agent --bin agent`.
Both payer and payee must be associated with the USDC token first
(`cargo run -p agent --bin associate-token`).

### The policy engine

Leash decides; the agent only asks. Before any price is named, the gateway's
policy engine (`crates/mandate`, `MandateGuard::evaluate`) walks the agent's
ENS chain root to leaf and runs six deterministic checks against every node:

| Check | Rule |
|---|---|
| Agent active | The name resolves in the tree |
| Within authority | `budget` ≥ what the node's whole subtree has already spent + this payment. Spending is replayed from the HCS receipts, so it counts across every provider and survives restarts |
| Within per-request limit | amount ≤ `maxPerCall` |
| Service permitted | the provider's category (`SERVICE_CATEGORY`) is in `allowedServices` |
| Asset permitted | the payment asset is in `allowedAssets`, or, without that record, is the asset budgets are denominated in (`MANDATE_ASSET`, USDC) |
| Not expired or revoked | the node's ENS expiry is in the future |

`POST /v1/authorize` runs the same evaluation without paying or recording
anything; the dashboard's policy simulator and the agent's "Authorize" step
both use it. A refusal on `/v1/infer` returns the full checklist in its `403`
and is published to HCS. `ratePerMinute` is recorded but not enforced yet.
Known gap: two payments authorized at the same instant can both fit; each is
still capped by `maxPerCall`, and the next check sees both.

### Discovery

Every gateway announces itself on the HCS topic when it starts
(`leash.service.announce.v1`: provider, category, model, base URL, pricing).
The agent runner discovers providers by replaying the topic (plus any in
`PROVIDERS`), fetches each live manifest, keeps the ones selling the requested
category, quotes them, and asks each one's policy engine, cheapest first, until
one approves. `scripts/demo-providers.sh` starts three extra providers: B and C
sell inference at other prices, D sells compute, which no agent's policy allows.

## Compute: agents renting real infrastructure

The same payment and policy path sells containers, not only tokens. A gateway
started with `COMPUTE_BACKEND=docker` becomes a **compute broker**: it rents
containers on the local Docker daemon, prepaid by the minute, and never hands
out credentials. `scripts/demo-providers.sh` starts one as `leash-compute`
(port 4024, $0.0002/min).

1. **Task → job.** The owner gives an agent a task in plain words ("Run a Redis
   cache for 10 minutes"). The runner plans it into a job the broker offers
   (`image`, `command`, `minutes`): with `HF_TOKEN` set in `crates/agent/.env`,
   a model (`PLANNER_MODEL`, default Qwen3 4B) proposes it, constrained to the
   broker's image allowlist and time limit; otherwise keyword rules do. The
   planner only proposes.
2. **Quote → authorize → pay.** Priced per minute, checked by the policy engine
   (`compute` must be in `allowedServices` at every node), paid over x402.
3. **Provision.** The container starts with CPU, memory and process limits and
   a deadline. Docker failing means a 502, and the payment is never settled.
4. **Teardown.** A reaper removes it when the prepaid time ends, and within
   ~20s if the paying agent's authority is revoked or expires, so revoking an
   agent stops its infrastructure. Every teardown is published to HCS.
5. **Extend.** More time is a new payment through the same policy check
   ("Add 5 min" on Services → Running now); only the paying agent can extend.

Endpoints on a compute broker: `POST /v1/quote` with `{ job }`, the same gated
`/v1/infer`, `GET /v1/resources`, `POST /v1/resources/{id}/stop` (the owner's
kill switch; unauthenticated, so localhost only). Known gap: a container starts
before settlement completes, so a settlement that fails after a successful
start leaves it running until its deadline.

To let an agent buy compute, add `compute` to its `allowedServices` and every
parent's (only the deployer can write records):

```sh
cd frontend
node scripts/set-record.mjs root allowedServices inference,compute --dry-run   # check, no key
DEPLOYER_KEY=0x... node scripts/set-record.mjs root allowedServices inference,compute
DEPLOYER_KEY=0x... node scripts/set-record.mjs agent.root allowedServices inference,compute
```

`agent.root` can then rent containers; `sub.agent.root` stays inference-only
and is denied, which is the other half of the demo.

## Autopilot: three agents keep a stack alive

`demo/shop` is a small Docker Compose app: `web` (front end on :8088) proxies
`/api` to `api`, which keeps its counter in `cache` (Redis). Nothing restarts
on its own. A gateway started with `OPS_COMPOSE_FILE` becomes an **ops
provider** (`leash-ops`, port 4025): it brings the stack up, reports its health
for free (`GET /v1/ops/health`: container states, healthchecks, recent logs,
an end-to-end probe) and sells a small menu of repairs over x402 at $0.0005
each: `start`, `restart`, `unpause` or `recreate`, on a service of that stack
and nothing else. No shell, no arguments.

The agent runner's autopilot (Dashboard → **Autopilot**) splits the work
across three agents, each under its own mandate:

| Agent | Default | Does | Pays for |
|---|---|---|---|
| Detect | `watcher` | reads health every 2s; opens an incident after two failed checks | nothing, so it needs no authority |
| Diagnose | `sub.agent.root` | gets the evidence and the repair menu, returns a root cause and the fewest repairs | LLM inference (`inference`) |
| Repair | `agent.root` | buys each repair, stops once the stack is healthy | repairs (`ops`) |

Then the detector confirms recovery from outside and the incident records the
time to fix. The model only proposes; its plan is filtered to the menu, and if
it can't be bought or parsed the built-in runbook decides (and says so).
`sub.agent.root` can't buy `ops`, so the agent that reasons can't act. If a
repair is denied, or it doesn't bring the stack back, autopilot pauses itself
instead of paying again. Every payment is policy-checked and on HCS; repair
receipts carry what was run (`resource: "start cache"`).

Break it from the page (Kill the Redis cache, Stop the API, Freeze the web
server) or from a terminal (`docker compose -p leash-shop kill cache`). To let
`agent.root` repair, add `ops` along its chain:

```sh
cd frontend
DEPLOYER_KEY=0x... node scripts/set-record.mjs root allowedServices inference,compute,ops
DEPLOYER_KEY=0x... node scripts/set-record.mjs agent.root allowedServices inference,compute,ops
```

Runner endpoints: `GET /v1/autopilot` (state, incidents), `POST /v1/autopilot`
`{ enabled }`, `POST /v1/autopilot/respond` (once, now), `POST
/v1/autopilot/chaos` `{ scenario }`. Set `AUTOPILOT=1` to start it on;
`AUTOPILOT_{DETECT,DIAGNOSE,FIX}_AGENT` and `OPS_PROVIDER` override the defaults.
One incident costs about $0.0013: a diagnosis (~$0.0008) and one repair.

## Demo (≤5 min), all from the dashboard

1. **Overview**: the tree, the shared wallet's USDC balance, the HCS trail.
2. **Give `sub.agent.root` an inference task**: four providers are discovered
   on the HCS registry, three quote per token, Leash approves the cheapest
   (every check ✓), the agent pays it over x402, Blocky402 settles USDC on
   Hedera, the result comes back, and the receipt is confirmed on HCS.
3. **Give it a compute task**: the job is planned and quoted, and Leash denies
   it: compute isn't in `sub.agent.root`'s `allowedServices`. Nothing is
   signed. **Policies → simulator** shows the same decision without a task.
4. **Give `agent.root` "Run a Redis cache for 10 minutes"**: approved, paid, and
   a real container starts; watch it count down in Services → Running now, add
   5 minutes (another checked payment), or let it expire.
5. **Revoke `root`** (one `unregister` tx, no loop over children): the next run
   is blocked naming `root`, and the running container is torn down within
   seconds ("its agent's authority was revoked", on HCS). Restore it.
6. **Autopilot**: switch it on and click "Kill the Redis cache". The watcher
   sees the cache exit and the API turn unhealthy; `sub.agent.root` pays a
   model, which names the cache (not the API) as the cause; `agent.root` pays
   for `start cache`; the watcher confirms and the page shows the time to fix.
   Before `ops` is granted, the repair is denied and autopilot pauses.
7. **Activity**: the whole trail, replayed from HCS.

Budgets are the `budget/allowedServices/ratePerMinute/maxPerCall` text records.
