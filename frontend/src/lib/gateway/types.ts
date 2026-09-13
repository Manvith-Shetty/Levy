// Mirrors the wire types in crates/meter/src/lib.rs and the request/response
// bodies in crates/gateway/src/routes.rs.

export interface AssetInfo {
  id: string
  symbol: string
  decimals: number
}

export interface PriceModel {
  per_1k_input: number
  per_1k_output: number
  minimum: number
}

export interface ServiceManifest {
  provider: string
  model: string
  base_url: string
  quote_url: string
  infer_url: string
  network: string
  pay_to: string
  asset: AssetInfo
  pricing: PriceModel
  facilitator: string
  receipts_topic: string | null
  x402_version: number
  /** `inference`, `compute`, `data` — what `allowedServices` is checked against. */
  category?: string
  description?: string
}

/** A provider registering itself on the HCS topic — mirrors `meter::ServiceAnnouncement`. */
export interface ServiceAnnouncement {
  kind: string
  provider: string
  category: string
  model: string
  base_url: string
  network: string
  asset: string
  pricing: PriceModel
  announced_at: string
}

export interface PolicyCheck {
  id: 'active' | 'authority' | 'per_call' | 'service' | 'asset' | 'expiry'
  label: string
  status: 'pass' | 'fail' | 'skipped'
  node?: string
  detail?: string
}

/** `POST /v1/authorize` — the policy engine's answer, without paying. */
export interface PolicyDecision {
  approved: boolean
  agent: string
  amount: number
  service: string
  asset: string
  reason: string | null
  blocked_by: string | null
  violation: string | null
  checks: PolicyCheck[]
  path: MandateHop[]
  /** Atomic units each node on the path has already spent (its subtree's roll-up). */
  spent: Record<string, number>
  ledger_error: string | null
  provider: string
}

export interface MandateHop {
  name: string
  budget: number
  expires_at: string
}

export interface Usage {
  input_tokens: number
  output_tokens: number
}

export interface Receipt {
  kind: string
  provider: string
  quote_id: string
  payer: string
  pay_to: string
  amount: number
  asset: string
  network: string
  transaction_id: string
  usage: Usage
  settled_at: string
  mandate_path: MandateHop[]
  service?: string
}

/** A payment the mandate guard blocked before any price tag was issued —
 * mirrors `meter::Refusal`. Published to the same HCS topic as receipts. */
export interface Refusal {
  kind: string
  provider: string
  quote_id: string
  agent: string
  amount: number
  asset: string
  network: string
  blocked_by: string
  violation: 'unresolvable' | 'expired' | 'over_budget' | 'over_per_call_limit' | string
  limit?: number
  reason: string
  refused_at: string
  service?: string
}

export interface SeedMandateRequest {
  name: string
  budget: number
  allowed_services: string[]
  rate_per_minute: number
  max_per_call: number
  expires_in_secs: number
  parent: string | null
}

export interface RevokeMandateRequest {
  name: string
}

/** Client-tracked view of a seeded node — see hooks/useMandateTree.ts for why
 * this is tracked locally rather than read from the gateway. */
export interface TrackedMandateNode {
  name: string
  parent: string | null
  budgetHbar: number
  maxPerCallHbar: number
  ratePerMinuteHbar: number
  allowedServices: string[]
  seededAt: string
  expiresAt: string
  revoked: boolean
}
