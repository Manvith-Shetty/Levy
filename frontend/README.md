# Leash dashboard

The Leash control plane: the agent authority tree, spending, the audit log,
policies, services and settings. React + Vite + Tailwind.

It runs in two modes, switched by the **Demo Mode** toggle in the topbar:

- **Live (default)** — reads the real deployment: the ENSv2 mandate tree on
  Sepolia, and every receipt and refusal the gateway publishes to its HCS topic
  on Hedera testnet. Revoke, restore and create are real Sepolia transactions
  signed in your browser wallet.
- **Demo** — generated data and a simulation panel, for walking through the
  product without any network.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
```

No `.env` is needed: every setting defaults to the public deployment. To point
at a redeploy, copy `.env.example` to `.env`, override what changed, and
rebuild — `VITE_*` values are baked in at build time. Nothing deployment-specific
is written into `src/`: contract addresses, chain and explorer URLs, RPCs and
their fallbacks, Hedera ids, the asset, the default agent, the service list,
default tasks, Autopilot's shop link and labels, and refresh intervals all come
from `src/lib/config.ts`, which reads `.env.example`'s keys. Network names in
the interface follow `VITE_ENS_CHAIN_NAME` and `VITE_HEDERA_NETWORK`.
`scripts/set-record.mjs` reads the same `.env`, so one file points both the
dashboard and the script at a deployment.

## Where live data comes from

| What | Source | Notes |
|---|---|---|
| Agent tree, budgets, expiries | Sepolia RPC, straight from the browser | Rebuilt from registry + registrar events from the deploy block, then current state (expiry, resolver, subregistry, text records) read in batched calls — the same walk `crates/mandate` does for the gateway. |
| Payments and refusals | HCS topic via the Hedera mirror node | The gateway publishes both to one topic (`kind` tells them apart), so the log survives gateway restarts and anyone can replay it. |
| Manifest, in-memory receipts and refusals | The gateway, through `/api` | Optional — HCS already carries the same records. |
| Shared agent wallet balance | Hedera mirror node | Every demo agent pays from `VITE_HEDERA_PAYER_ACCOUNT`. |
| Paid requests | The agent runner, through `/runner` | Optional: only needed to start purchases from the dashboard. |

Amounts: on-chain budgets and receipt amounts are raw integers. The dashboard
reads them as USDC (6 decimals — `VITE_ASSET_*`), so the live tree's
`100000 / 50000 / 10000` budgets are $0.10 / $0.05 / $0.01. Receipts settled in
another asset (e.g. HBAR) are listed with their own unit and never added to
USDC spend.

What the gateway enforces on each payment, at every node up the chain:
`budget` and `maxPerCall` (each against the single payment — there's no
running total). `ratePerMinute` and `allowedServices` are recorded and shown,
but not enforced yet. "Spent" in the dashboard is the sum of that agent's
receipts.

## Making a paid request

**Run a paid request** (Overview, any agent's page, a service's "Buy with an
agent", or ⌘K) gives an agent a task and follows it through the agent runner
(`cargo run -p agent --bin agent-runner`), which holds the shared Hedera
wallet: Discover (providers announced on HCS) → Quote (per token) → Authorize
(the policy engine's checklist) → Pay (x402, settled by Blocky402) → Execute →
Result → Audit (the receipt confirmed on the HCS topic). Every failure has its
own state: no provider, over the spend cap, policy denied, insufficient
authority, payment failed, service failed, audit pending.

**Policies → Policy simulator** asks the gateway's policy engine
(`POST /api/v1/authorize`) about a payment that never happens.

The runner has no CORS, so it's reached at `/runner` like the gateway is at
`/api`: `RUNNER_PROXY_TARGET` in dev (default `http://localhost:4030`), and a
`/runner/*` rewrite when deployed. If the runner was started with
`RUNNER_TOKEN`, set `VITE_RUNNER_TOKEN` to match.

## Writing to the tree

Revoke, restore and create need a browser wallet (MetaMask) on Sepolia, and an
account holding the registry roles — for the current deployment that's the
deployer, `0x06de…7c08`. Every transaction is simulated before the wallet is
asked to sign, so a missing role or a registrar rule comes back as a readable
reason.

- **Revoke** — one `unregister` on the registry holding the name. Every
  descendant is blocked by the same transaction; nothing loops over children.
- **Restore** — `renew` the name, back to its parent's expiry (90 days at the
  root).
- **Create** — `MandateRegistrar.registerChild` (which checks budget ≤ parent's
  and expiry ≤ parent's on-chain), then one resolver `multicall` writing the
  five policy records (budget, maxPerCall, ratePerMinute, allowedServices,
  allowedAssets). Only agents with a subregistry and a registrar binding
  can have children — today that's `root` and `agent.root`.

## Deploying

`npm run build` produces a static `dist/`. The gateway sends no CORS headers,
so the browser can't call it cross-origin — two ways around that:

**Same-origin proxy (recommended)** — leave `VITE_GATEWAY_URL` unset. The app
calls relative `/api/*`; configure whatever serves `dist/` to proxy that prefix
to the gateway, stripping it:

- Vercel (`vercel.json`): `{ "rewrites": [{ "source": "/api/:path*", "destination": "https://your-gateway/:path*" }] }`
- Netlify (`_redirects`): `/api/*  https://your-gateway/:splat  200`
- Nginx: `location /api/ { rewrite ^/api/(.*)$ /$1 break; proxy_pass https://your-gateway; }`

Do the same for `/runner/*` → the agent runner. Keep `proxy_buffering off` (Nginx)
so its step stream isn't held back until the run ends.

**Direct calls** — set `VITE_GATEWAY_URL=https://your-gateway` at build time,
once the gateway sends CORS headers for your origin.

Or skip the gateway entirely with `VITE_GATEWAY_ENABLED=false` — the tree and
the HCS audit trail are read without it.

In dev, `GATEWAY_PROXY_TARGET` (server-side only, default
`http://localhost:4021`) is where the Vite dev server forwards `/api`.

## Screenshot tooling

`node serve.mjs` serves the app at http://localhost:3000 (it won't start a
second instance). `node screenshot.mjs <url> [label]` saves a PNG to
`./temporary screenshots/` — see its header comment for `--click`, `--type`,
`--key` and `--full`.
