/**
 * Talks to the agent runner — the Rust buyer behind an HTTP endpoint — so the
 * dashboard can start a real x402 purchase and follow it step by step. The
 * runner holds the shared Hedera wallet; the browser never sees a key.
 */

import { config } from '../config'
import type { PolicyDecision } from '../gateway/types'

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

export interface JobSpec {
  image: string
  command: string
  minutes: number
  extend?: string
}

export interface ComputeResource {
  id: string
  name: string
  agent: string
  image: string
  command: string
  started_at: string
  expires_at: string
  status: string
  paid_by: string[]
  logs: string
}

export interface ComputeOffer {
  per_minute: number
  max_minutes: number
  images: string[]
  limits: string
}

export interface DiscoveredProvider {
  base_url: string
  source?: 'hcs' | 'configured'
  manifest?: { provider: string; model: string; category?: string; description?: string }
  error?: string
}

export type RunStep =
  | {
      step: 'start'
      agent: string
      service: string
      payer: string
      prompt: string
      budget_atomic: number
      max_output_tokens: number
    }
  | { step: 'discovered'; providers: DiscoveredProvider[] }
  | { step: 'no_provider'; service: string; unavailable?: boolean }
  | { step: 'planned'; job: JobSpec; planner: string; note?: string | null }
  | {
      step: 'quote'
      base_url: string
      provider: string
      model: string
      category?: string
      pricing: PriceModel
      input_tokens: number
      max_output_tokens: number
      amount: number
      asset: AssetInfo
      network: string
      pay_to: string
      facilitator: string
      quote_id: string
    }
  | { step: 'quote_failed'; base_url: string; message: string }
  | { step: 'over_budget'; budget_atomic: number; cheapest: number; asset: AssetInfo }
  | { step: 'authorization'; provider: string; quote_id: string; decision: PolicyDecision }
  | { step: 'authorization_failed'; provider: string; message: string }
  | { step: 'denied'; decision: PolicyDecision | null }
  | { step: 'selected'; provider: string; amount: number; asset: AssetInfo; passed_over: number; quote_id: string }
  | { step: 'payment_required'; requirements: unknown }
  | { step: 'refused'; reason: string }
  | { step: 'paying'; payer: string }
  | { step: 'payment_failed'; message: string }
  | { step: 'service_failed'; reason: string; provider?: string; trying_next?: boolean }
  | { step: 'settled'; transaction: string; network: string; payer: string; explorer: string }
  | {
      step: 'result'
      provider: string
      model: string
      completion: string
      usage: { input_tokens: number; output_tokens: number }
      charged: number
      unused_output_credit: number
      asset: AssetInfo
      quote_id: string
      resource?: ComputeResource | null
      base_url?: string
    }
  | { step: 'audited'; topic: string; sequence: number; consensus_timestamp: string }
  | { step: 'audit_pending'; topic: string | null }
  | { step: 'error'; message: string }
  | { step: 'done'; elapsed_ms: number }

export interface RunnerInfo {
  payer: string
  providers: string[]
  max_atomic: number
  max_output_tokens: number
  requires_token: boolean
  /** Model that turns compute tasks into jobs, when the runner has an HF token. */
  planner?: string | null
}

export interface ProviderEntry {
  base_url: string
  /** `hcs` when it announced itself on the topic, `configured` otherwise. */
  source?: 'hcs' | 'configured'
  manifest?: {
    category?: string
    description?: string
    compute?: ComputeOffer
    ops?: { project: string; per_action: number; actions: string[]; services: string[] }
    provider: string
    model: string
    base_url: string
    network: string
    pay_to: string
    asset: AssetInfo
    pricing: PriceModel
    facilitator: string
    receipts_topic?: string | null
  }
  error?: string
}

export interface RunRequest {
  agent: string
  service?: string
  /** Compute: an explicit job, or `extend` to add time to a resource. */
  job?: JobSpec
  /** Only shop at this provider (base URL). */
  provider?: string
  prompt?: string
  max_output_tokens?: number
  budget_atomic?: number
}

function url(path: string): string {
  return `${config.runnerUrl.replace(/\/$/, '')}${path}`
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return config.runnerToken ? { ...extra, authorization: `Bearer ${config.runnerToken}` } : extra
}

async function failure(response: Response): Promise<Error> {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text) as { error?: string }
    if (body.error) return new Error(body.error)
  } catch {
    // not JSON — fall through
  }
  if (response.status === 502 || response.status === 504 || response.status === 500) {
    return new Error("The agent runner isn't answering. Start it with `cargo run -p agent --bin agent-runner`.")
  }
  return new Error(text || `Agent runner answered ${response.status}`)
}

export async function getRunner(signal?: AbortSignal): Promise<RunnerInfo> {
  const response = await fetch(url('/v1/runner'), { headers: headers(), signal })
  if (!response.ok) throw await failure(response)
  return (await response.json()) as RunnerInfo
}

export interface ProviderResources {
  base_url: string
  provider: string
  resources: ComputeResource[] | null
}

/** Containers every discovered compute provider is running. */
export async function getResources(signal?: AbortSignal): Promise<ProviderResources[]> {
  const response = await fetch(url('/v1/resources'), { headers: headers(), signal })
  if (!response.ok) throw await failure(response)
  return ((await response.json()) as { providers: ProviderResources[] }).providers
}

/** The owner's kill switch for one container. */
export async function stopResource(baseUrl: string, id: string): Promise<void> {
  const response = await fetch(url('/v1/resources/stop'), {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json' }),
    body: JSON.stringify({ base_url: baseUrl, id }),
  })
  if (!response.ok) throw await failure(response)
}

/** Every provider the runner shops across, with its manifest when it answered. */
export async function getProviders(signal?: AbortSignal): Promise<ProviderEntry[]> {
  const response = await fetch(url('/v1/providers'), { headers: headers(), signal })
  if (!response.ok) throw await failure(response)
  return ((await response.json()) as { providers: ProviderEntry[] }).providers
}

/**
 * Starts one purchase and calls `onStep` for every step the runner reports,
 * in order. Resolves once the runner says it's done.
 */
export async function runAgent(
  request: RunRequest,
  onStep: (step: RunStep) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(url('/v1/run'), {
    method: 'POST',
    headers: headers({ 'content-type': 'application/json', accept: 'text/event-stream' }),
    body: JSON.stringify(request),
    signal,
  })
  if (!response.ok || !response.body) throw await failure(response)

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += value
    // Server-sent events are separated by a blank line; keep any partial tail.
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!data) continue
      try {
        onStep(JSON.parse(data) as RunStep)
      } catch {
        // A malformed frame is skipped rather than ending the run.
      }
    }
  }
}

/** Atomic units → a plain number of the asset (USDC has 6 decimals). */
export function fromAtomic(amount: number, asset: AssetInfo): number {
  return amount / 10 ** asset.decimals
}

/** Pulls the price, payee and scheme out of an x402 `402` body, whatever its version. */
export function readRequirements(requirements: unknown): {
  scheme?: string
  network?: string
  amount?: string
  payTo?: string
  asset?: string
  feePayer?: string
} {
  const root = (requirements ?? {}) as { accepts?: unknown[] }
  const first = (Array.isArray(root.accepts) ? root.accepts[0] : root) as Record<string, unknown> | undefined
  if (!first || typeof first !== 'object') return {}
  const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : undefined)
  return {
    scheme: str(first.scheme),
    network: str(first.network),
    amount: str(first.amount ?? first.maxAmountRequired),
    payTo: str(first.payTo),
    asset: str(first.asset),
    feePayer: str((first.extra as Record<string, unknown> | undefined)?.feePayer),
  }
}
