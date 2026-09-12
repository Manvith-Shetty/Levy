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
at a redeploy, copy `.env.example` to `.env` and override what changed.

## Where live data comes from

| What | Source | Notes |
|---|---|---|
| Agent tree, budgets, expiries | Sepolia RPC, straight from the browser | Rebuilt from registry + registrar events from the deploy block, then current state (expiry, resolver, subregistry, text records) read in batched calls — the same walk `crates/mandate` does for the gateway. |
| Payments and refusals | HCS topic via the Hedera mirror node | The gateway publishes both to one topic (`kind` tells them apart), so the log survives gateway restarts and anyone can replay it. |
| Manifest, in-memory receipts and refusals | The gateway, through `/api` | Optional — HCS already carries the same records. |
| Shared agent wallet balance | Hedera mirror node | Every demo agent pays from `VITE_HEDERA_PAYER_ACCOUNT`. |

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
  four text records. Only agents with a subregistry and a registrar binding
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
