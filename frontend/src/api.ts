import type {
  Receipt,
  RevokeMandateRequest,
  SeedMandateRequest,
  ServiceManifest,
} from './types'

// Every call goes through /api, which vite.config.ts proxies to the
// gateway (GATEWAY_URL, default http://localhost:4021) — see that file for
// why this exists instead of calling the gateway directly.
const BASE = '/api'

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
