# Leash dashboard

The Leash control-plane UI: an agent authority tree, spending, activity, policies,
services and settings. Built with React + Vite + Tailwind.

Runs entirely on generated mock data (`src/data/mockData.ts`) today — every
action (create/revoke an agent, simulate a payment) mutates local state via
`src/lib/store.tsx`, nothing hits a network. A client for the `gateway`'s HTTP
API already exists at `src/lib/gateway/` but isn't wired into any screen yet;
see "Connecting to the gateway" below for what that takes.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173.

## Environment variables

Copy `.env.example` to `.env` and adjust as needed — see that file for the
full explanation. The short version: `VITE_GATEWAY_URL` only matters once a
screen is calling `src/lib/gateway/api.ts`; nothing in the running app reads
it yet.

## Connecting to the gateway

The gateway must already be running (see `crates/gateway/README` /
`.env.example`). To wire a screen to it: call the functions in
`src/lib/gateway/api.ts` instead of (or alongside) `src/lib/store.tsx`'s mock
actions.

Two known gaps to expect when you do:

- **No read endpoint for mandate state.** `POST /v1/mandate/seed` and
  `/revoke` are write-only today, so there's no way to fetch the current
  mandate tree from the gateway — only receipts (`GET /v1/receipts`) exist.
  Fixing this means adding a `GET /v1/mandate/tree` (or reading the real
  ENSv2 registry directly once `MANDATE_MODE=ens` is live).
- **Seeding/revoking only takes effect** against a gateway running with
  `MANDATE_MODE=mock` (the default).

## Deploying

The build is static (`npm run build` → `dist/`), but the gateway has no CORS
headers of its own, so the browser can't call it cross-origin. Two ways to
handle that in production, same idea as the dev server's `/api` proxy:

**Same-origin proxy (recommended)** — leave `VITE_GATEWAY_URL` unset. The
app calls relative `/api/*`; configure whatever serves `dist/` to proxy that
prefix to the gateway, stripping it:

- Vercel (`vercel.json`): `{ "rewrites": [{ "source": "/api/:path*", "destination": "https://your-gateway/:path*" }] }`
- Netlify (`_redirects`): `/api/*  https://your-gateway/:splat  200`
- Nginx: `location /api/ { rewrite ^/api/(.*)$ /$1 break; proxy_pass https://your-gateway; }`

**Direct calls** — set `VITE_GATEWAY_URL=https://your-gateway` at build
time. Requests go straight to the gateway, no proxy needed, but only works
once the gateway sends CORS headers allowing the frontend's origin.

## Screenshot tooling

`node serve.mjs` serves the app at http://localhost:3000 (skips starting a
second instance if one's already up); `node screenshot.mjs <url> [label]`
saves a PNG to `./temporary screenshots/` — see that file's header comment
for interaction flags (`--click`, `--type`, `--key`, `--full`).
