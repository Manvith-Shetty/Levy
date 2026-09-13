/**
 * The agent runner's autopilot: three agents keeping a Docker Compose stack
 * alive. One watches (free), one buys a diagnosis from a model, one buys the
 * repair — each within its own ENS policy. See crates/agent/src/bin/agent_runner/autopilot.rs.
 */

import { config } from '../config'
import type { PolicyDecision } from '../gateway/types'
import type { AssetInfo } from './runner'

export interface ServiceHealth {
  name: string
  /** `running`, `exited`, `paused`, `restarting`, `missing`. */
  state: string
  /** Docker healthcheck: `healthy`, `unhealthy`, `starting`, or empty. */
  health: string
  status: string
  logs?: string
}

export interface InfraHealth {
  project: string
  healthy: boolean
  services: ServiceHealth[]
  probe: { url: string; status: number | null; ms: number; error?: string }
  problems: string[]
  checked_at: string
}

export interface OpsAction {
  action: string
  service: string
}

export interface OpsOffer {
  project: string
  per_action: number
  actions: string[]
  services: string[]
  topology?: string
}

export interface OpsResult {
  action: string
  service: string
  command: string
  output: string
  health: InfraHealth
}

export type Stage = 'detect' | 'diagnose' | 'fix' | 'verify'

/** One step of one agent. The payment steps are the runner's usual ones. */
export interface IncidentStep {
  stage: Stage
  step: string
  at_ms: number
  agent?: string
  problems?: string[]
  prompt?: string
  provider?: string
  model?: string
  amount?: number
  asset?: AssetInfo
  cheapest?: number
  budget_atomic?: number
  decision?: PolicyDecision | null
  reason?: string
  message?: string
  transaction?: string
  explorer?: string
  completion?: string
  root_cause?: string
  actions?: OpsAction[]
  action?: OpsAction
  by?: string
  note?: string | null
  ops?: OpsResult | null
  health?: InfraHealth
  topic?: string | null
  sequence?: number
  count?: number
  trying_next?: boolean
}

export type IncidentStatus = 'diagnosing' | 'fixing' | 'verifying' | 'resolved' | 'blocked' | 'failed'

export interface Incident {
  id: string
  trigger: 'autopilot' | 'manual'
  opened_at: string
  closed_at: string | null
  status: IncidentStatus
  problems: string[]
  root_cause: string | null
  diagnosed_by: string | null
  actions: OpsAction[]
  outcome: string | null
  spent: number
  asset: AssetInfo | null
  mttr_ms: number | null
  steps: IncidentStep[]
}

export interface AutopilotState {
  enabled: boolean
  paused_reason: string | null
  agents: { detect: string; diagnose: string; fix: string }
  provider: {
    base_url: string
    provider: string
    offer: OpsOffer | null
    asset: AssetInfo
    scenarios: { enabled: boolean; scenarios: { id: string; label: string }[] } | null
  } | null
  health: InfraHealth | null
  health_error: string | null
  current: Incident | null
  history: Incident[]
  max_atomic: number
}

function url(path: string): string {
  return `${config.runnerUrl.replace(/\/$/, '')}${path}`
}

function headers(): Record<string, string> {
  const base = { 'content-type': 'application/json' }
  return config.runnerToken ? { ...base, authorization: `Bearer ${config.runnerToken}` } : base
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url(path), { ...init, headers: headers() })
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    // not JSON
  }
  if (!response.ok) {
    const message = (body as { error?: string } | null)?.error
    if (message) throw new Error(message)
    if (response.status >= 500) {
      throw new Error("The agent runner isn't answering. Start it with `cargo run -p agent --bin agent-runner`.")
    }
    throw new Error(text || `Agent runner answered ${response.status}`)
  }
  return body as T
}

export const getAutopilot = (signal?: AbortSignal) => send<AutopilotState>('/v1/autopilot', { signal })

export const setAutopilot = (enabled: boolean) =>
  send<{ enabled: boolean }>('/v1/autopilot', { method: 'POST', body: JSON.stringify({ enabled }) })

/** Respond to the outage now, once, even with autopilot off. */
export const respondNow = () => send<{ incident: string }>('/v1/autopilot/respond', { method: 'POST', body: '{}' })

/** Break the stack on purpose (or `reset` it). */
export const causeOutage = (scenario: string) =>
  send<{ ran: string }>('/v1/autopilot/chaos', { method: 'POST', body: JSON.stringify({ scenario }) })
