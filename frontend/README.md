# Leash dashboard

A client of the `gateway`'s existing HTTP API — no backend changes needed to
run this. Shows the mandate tree, live settlement activity, and lets you
seed/revoke mandates without `curl`.

## Run it

The gateway must already be running (see `crates/gateway/README`/`.env.example`).

```bash
npm install
npm run dev
```

Open http://localhost:5173. The dev server proxies `/api/*` to the gateway
at `http://localhost:4021` by default — point it at a different instance
(e.g. a second gateway for a provisioning capability) with:

```bash
GATEWAY_URL=http://localhost:4023 npm run dev
```

## Known limitation

The gateway has no `GET` endpoint for mandate state today — `POST
/v1/mandate/seed` and `/revoke` are write-only. So the mandate tree shown
here reflects only what's been seeded or revoked **through this dashboard**,
tracked in the browser's `localStorage`. A node seeded via `curl` (or by
someone else, or in an earlier session on a different browser) won't appear
until it's (re-)seeded through this UI. Fixing this properly means adding a
`GET /v1/mandate/tree` (or reading the real ENSv2 registry directly once
`MANDATE_MODE=ens` is live) — that's the natural next step.

Seeding and revoking only take effect against a gateway running with
`MANDATE_MODE=mock` (the default).
