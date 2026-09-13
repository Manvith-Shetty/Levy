import type {
  PolicyDecision,
  Receipt,
  Refusal,
  RevokeMandateRequest,
  SeedMandateRequest,
  ServiceManifest,
} from './types'

// By default every call goes through same-origin /api — in dev,
// vite.config.ts proxies that to the gateway (GATEWAY_PROXY_TARGET, default
// http://localhost:4021); in production, whatever serves the built dist/
// needs to proxy /api/* the same way (see .env.example).
//
// Set VITE_GATEWAY_URL at build time to skip the proxy and call the gateway
// directly instead — only once the gateway sends CORS headers for this
// origin, which it doesn't yet.
const BASE = import.meta.env.VITE_GATEWAY_URL || '/api'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function json<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!response.ok) {
    let message = text
    try {
      const body = JSON.parse(text) as { error?: string }
      if (body.error) message = body.error
    } catch {
      // body wasn't JSON — use the raw text as-is
    }
    throw new ApiError(response.status, message || response.statusText)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

export function getManifest(): Promise<ServiceManifest> {
  return fetch(`${BASE}/.well-known/x402`).then(json<ServiceManifest>)
}

export function getReceipts(): Promise<Receipt[]> {
  return fetch(`${BASE}/v1/receipts`).then(json<Receipt[]>)
}

export function getRefusals(): Promise<Refusal[]> {
  return fetch(`${BASE}/v1/refusals`).then(json<Refusal[]>)
}

/** Runs the gateway's policy engine without paying, recording or reserving anything. */
export function authorize(body: {
  agent: string
  amount: number
  service?: string
  asset?: string
}): Promise<PolicyDecision> {
  return fetch(`${BASE}/v1/authorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json<PolicyDecision>)
}

export function seedMandate(body: SeedMandateRequest): Promise<{ seeded: string }> {
  return fetch(`${BASE}/v1/mandate/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json<{ seeded: string }>)
}

export function revokeMandate(body: RevokeMandateRequest): Promise<{ revoked: string }> {
  return fetch(`${BASE}/v1/mandate/revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(json<{ revoked: string }>)
}

/** `https://hashscan.io/<net>/transaction/<id>` for a settled transaction. */
export function hashscanTx(network: string, transaction: string): string {
  const net = network.includes('mainnet') ? 'mainnet' : 'testnet'
  return `https://hashscan.io/${net}/transaction/${transaction}`
}

/** `https://hashscan.io/<net>/topic/<id>` for the HCS receipts topic. */
export function hashscanTopic(network: string, topic: string): string {
  const net = network.includes('mainnet') ? 'mainnet' : 'testnet'
  return `https://hashscan.io/${net}/topic/${topic}`
}
