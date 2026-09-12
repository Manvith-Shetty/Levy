import type {
  ActivityEvent,
  Agent,
  Policy,
  ResourceKind,
  Service,
} from '../lib/types'

/** Seeded PRNG so a reload gives the same demo, not a different one. */
function rng(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DAY = 86_400_000

const NOW = Date.now()

function daysAgo(n: number, hour = 10, minute = 0): string {
  const d = new Date(NOW - n * DAY)
  d.setHours(hour, minute, 0, 0)
  return d.toISOString()
}

function minutesAgo(n: number): string {
  return new Date(NOW - n * 60_000).toISOString()
}

function daysAhead(n: number): string {
  const d = new Date(NOW + n * DAY)
  d.setHours(23, 59, 0, 0)
  return d.toISOString()
}

function txId(random: () => number): string {
  const hex = () => Math.floor(random() * 16).toString(16)
  return `0x${Array.from({ length: 40 }, hex).join('')}`
}

export const POLICIES: Policy[] = [
  {
    id: 'pol_root',
    name: 'Root Authority',
    description: 'Ceiling for the account owner. Applies to the top of the tree only.',
    active: true,
    maxTransaction: 2_000,
    dailyLimit: 5_000,
    monthlyLimit: 20_000,
    services: ['compute', 'storage', 'database', 'inference', 'networking', 'secrets'],
    providers: ['AWS', 'GCP', 'OpenAI', 'Hedera'],
  },
  {
    id: 'pol_compute',
    name: 'Production Compute',
    description: 'Training and serving workloads on reserved GPU and CPU fleets.',
    active: true,
    maxTransaction: 500,
    dailyLimit: 2_000,
    monthlyLimit: 8_000,
    services: ['compute', 'storage', 'inference'],
    providers: ['AWS', 'GCP'],
  },
  {
    id: 'pol_data',
    name: 'Data Pipeline',
    description: 'Batch extraction and warehouse loads. No inference, no secrets.',
    active: true,
    maxTransaction: 250,
    dailyLimit: 1_000,
    monthlyLimit: 4_000,
    services: ['storage', 'database', 'compute'],
    providers: ['AWS', 'GCP'],
  },
  {
    id: 'pol_observability',
    name: 'Observability',
    description: 'Metrics, traces and log retention. Low ceilings, always on.',
    active: true,
    maxTransaction: 100,
    dailyLimit: 400,
    monthlyLimit: 1_500,
    services: ['networking', 'storage'],
    providers: ['GCP'],
  },
  {
    id: 'pol_sandbox',
    name: 'Sandbox',
    description: 'Throwaway agents for evaluation runs. Expires with the agent.',
    active: false,
    maxTransaction: 50,
    dailyLimit: 150,
    monthlyLimit: 500,
    services: ['inference'],
    providers: ['OpenAI'],
  },
]

export const SERVICES: Service[] = [
  { id: 'svc_aws', name: 'AWS Compute', category: 'Compute', connected: true, resource: 'compute', endpoint: 'us-east-1' },
  { id: 'svc_gcp', name: 'Google Cloud', category: 'Compute', connected: true, resource: 'compute', endpoint: 'us-central1' },
  { id: 'svc_hedera', name: 'Hedera', category: 'Settlement', connected: true, resource: 'networking', endpoint: 'testnet' },
  { id: 'svc_openai', name: 'OpenAI API', category: 'Inference', connected: true, resource: 'inference', endpoint: 'api.openai.com' },
  { id: 'svc_storage', name: 'Storage', category: 'Storage', connected: true, resource: 'storage', endpoint: 's3://leash-prod' },
]

/** Which service each agent actually buys from, used to keep the log coherent. */
const AGENT_SERVICES: Record<string, string[]> = {
  root: ['Storage'],
  compute: ['AWS Compute', 'Storage'],
  gpu: ['AWS Compute', 'OpenAI API'],
  cpu: ['AWS Compute', 'Google Cloud'],
  data: ['Google Cloud', 'Storage'],
  etl: ['Google Cloud', 'Storage'],
  analytics: ['Google Cloud', 'OpenAI API'],
  monitoring: ['Google Cloud', 'Storage'],
}

function permissions(
  allowed: ResourceKind[],
  limits: { transaction: number; daily: number; monthly: number },
): Agent['permissions'] {
  const all: ResourceKind[] = ['compute', 'storage', 'database', 'inference', 'networking', 'secrets']
  return all.map((resource) => ({
    resource,
    allowed: allowed.includes(resource),
    limits: allowed.includes(resource) ? limits : undefined,
  }))
}

interface Seed {
  id: string
  name: string
  description: string
  parentId?: string
  authority: number
  spent: number
  createdDaysAgo: number
  expiresInDays?: number
  policyId: string
  resources: ResourceKind[]
  account: string
}

/** The demo hierarchy. Child authority always fits inside the parent's. */
const SEEDS: Seed[] = [
  {
    id: 'root',
    name: 'Infrastructure Manager',
    description: 'Root authority for the platform account. Delegates to every domain owner.',
    authority: 10_000,
    spent: 0,
    createdDaysAgo: 34,
    policyId: 'pol_root',
    resources: ['compute', 'storage', 'database', 'inference', 'networking', 'secrets'],
    account: '0.0.4821901',
  },
  {
    id: 'compute',
    name: 'Compute Agent',
    description: 'Owns the training and serving fleet. Delegates per workload class.',
    parentId: 'root',
    authority: 4_000,
    spent: 260,
    createdDaysAgo: 30,
    expiresInDays: 12,
    policyId: 'pol_compute',
    resources: ['compute', 'storage', 'inference'],
    account: '0.0.4821944',
  },
  {
    id: 'gpu',
    name: 'GPU Agent',
    description: 'Runs GPU workloads for model training and batch inference.',
    parentId: 'compute',
    authority: 2_000,
    spent: 1_240,
    createdDaysAgo: 21,
    expiresInDays: 12,
    policyId: 'pol_compute',
    resources: ['compute', 'inference', 'storage'],
    account: '0.0.4822013',
  },
  {
    id: 'cpu',
    name: 'CPU Agent',
    description: 'General purpose compute for schedulers and job runners.',
    parentId: 'compute',
    authority: 1_000,
    spent: 320,
    createdDaysAgo: 21,
    expiresInDays: 12,
    policyId: 'pol_compute',
    resources: ['compute', 'storage'],
    account: '0.0.4822014',
  },
  {
    id: 'data',
    name: 'Data Agent',
    description: 'Owns ingestion and the warehouse. Delegates to pipeline agents.',
    parentId: 'root',
    authority: 3_000,
    spent: 128.4,
    createdDaysAgo: 30,
    expiresInDays: 26,
    policyId: 'pol_data',
    resources: ['storage', 'database', 'compute'],
    account: '0.0.4821951',
  },
  {
    id: 'etl',
    name: 'ETL Agent',
    description: 'Nightly extraction and load jobs across partner sources.',
    parentId: 'data',
    authority: 1_000,
    spent: 840,
    createdDaysAgo: 18,
    expiresInDays: 26,
    policyId: 'pol_data',
    resources: ['storage', 'database', 'compute'],
    account: '0.0.4822102',
  },
  {
    id: 'analytics',
    name: 'Analytics Agent',
    description: 'Builds reporting models and answers ad-hoc warehouse queries.',
    parentId: 'data',
    authority: 800,
    spent: 112.4,
    createdDaysAgo: 18,
    expiresInDays: 26,
    policyId: 'pol_data',
    resources: ['database', 'inference'],
    account: '0.0.4822103',
  },
  {
    id: 'monitoring',
    name: 'Monitoring Agent',
    description: 'Keeps metrics, traces and log retention running for every service.',
    parentId: 'root',
    authority: 1_500,
    spent: 180,
    createdDaysAgo: 30,
    expiresInDays: 4,
    policyId: 'pol_observability',
    resources: ['networking', 'storage'],
    account: '0.0.4821958',
  },
]

function buildAgents(): Agent[] {
  const byId = new Map<string, Agent>()

  for (const seed of SEEDS) {
    const policy = POLICIES.find((p) => p.id === seed.policyId)!
    byId.set(seed.id, {
      id: seed.id,
      name: seed.name,
      description: seed.description,
      parentId: seed.parentId,
      children: [],
      authority: seed.authority,
      spent: seed.spent,
      status: 'active',
      createdAt: daysAgo(seed.createdDaysAgo, 9, 14),
      expiresAt: seed.expiresInDays == null ? undefined : daysAhead(seed.expiresInDays),
      onExpiry: 'revoke',
      permissions: permissions(seed.resources, {
        transaction: policy.maxTransaction,
        daily: policy.dailyLimit,
        monthly: policy.monthlyLimit,
      }),
      policyId: seed.policyId,
      account: seed.account,
    })
  }

  for (const agent of byId.values()) {
    if (agent.parentId) byId.get(agent.parentId)!.children.push(agent.id)
  }

  // ETL has burned 84% of its own ceiling — the agent the demo points at.
  byId.get('etl')!.status = 'warning'

  return [...byId.values()]
}

/** Approved payments that add up, per agent, to exactly that agent's spend. */
function buildPayments(agents: Agent[]): ActivityEvent[] {
  const random = rng(0x1eaa5)
  const events: ActivityEvent[] = []

  for (const agent of agents) {
    if (agent.spent <= 0) continue
    const services = AGENT_SERVICES[agent.id] ?? ['AWS Compute']
    const policy = POLICIES.find((p) => p.id === agent.policyId)!
    const count = 8 + Math.floor(random() * 8)

    // Random weights normalised to the agent's exact total, so the log and the
    // meters can never disagree.
    const weights = Array.from({ length: count }, () => 0.4 + random() * 1.6)
    const total = weights.reduce((a, b) => a + b, 0)
    const days = Array.from({ length: count }, () => random() * 13.6).sort((a, b) => b - a)

    let allocated = 0
    weights.forEach((weight, i) => {
      const last = i === count - 1
      const raw = last
        ? agent.spent - allocated
        : Math.round(((agent.spent * weight) / total) * 100) / 100
      const amount = Math.max(0.01, Math.round(raw * 100) / 100)
      allocated += amount
      const day = days[i]
      const ts = new Date(NOW - day * DAY)
      events.push({
        id: `evt_pay_${agent.id}_${i}`,
        kind: 'payment.approved',
        agentId: agent.id,
        amount,
        service: services[i % services.length],
        policyId: agent.policyId,
        policyLimit: policy.maxTransaction,
        dailyLimit: policy.dailyLimit,
        dailyUsage: Math.round(amount * (1 + random() * 3) * 100) / 100,
        timestamp: ts.toISOString(),
        txId: txId(random),
        network: 'hedera-testnet',
      })
    })
  }

  return events
}

/** 23 refusals, each with the ceiling that actually stopped it. */
function buildBlocked(): ActivityEvent[] {
  const random = rng(0x5ea51)
  const shapes: Array<{
    agentId: string
    amount: number
    service: string
    reason: string
    limitKey: 'transaction' | 'daily' | 'authority' | 'resource'
  }> = [
    { agentId: 'etl', amount: 180, service: 'Google Cloud', reason: 'Daily spending limit exceeded', limitKey: 'daily' },
    { agentId: 'gpu', amount: 750, service: 'AWS Compute', reason: 'Transaction exceeds maximum transaction limit', limitKey: 'transaction' },
    { agentId: 'analytics', amount: 310, service: 'OpenAI API', reason: 'Transaction exceeds maximum transaction limit', limitKey: 'transaction' },
    { agentId: 'monitoring', amount: 140, service: 'Google Cloud', reason: 'Transaction exceeds maximum transaction limit', limitKey: 'transaction' },
    { agentId: 'etl', amount: 420, service: 'Storage', reason: 'Transaction exceeds maximum transaction limit', limitKey: 'transaction' },
    { agentId: 'cpu', amount: 95, service: 'Secrets Manager', reason: 'Service not permitted', limitKey: 'resource' },
    { agentId: 'gpu', amount: 620, service: 'AWS Compute', reason: 'Transaction exceeds maximum transaction limit', limitKey: 'transaction' },
    { agentId: 'analytics', amount: 260, service: 'Storage', reason: 'Transaction exceeds maximum transaction limit', limitKey: 'transaction' },
    { agentId: 'etl', amount: 205, service: 'Google Cloud', reason: 'Daily spending limit exceeded', limitKey: 'daily' },
    { agentId: 'monitoring', amount: 260, service: 'Storage', reason: 'Transaction exceeds maximum transaction limit', limitKey: 'transaction' },
    { agentId: 'cpu', amount: 88, service: 'Storage', reason: 'Service not permitted', limitKey: 'resource' },
  ]

  const events: ActivityEvent[] = []
  for (let i = 0; i < 23; i++) {
    const shape = shapes[i % shapes.length]
    const policy = POLICIES.find(
      (p) => p.id === SEEDS.find((s) => s.id === shape.agentId)!.policyId,
    )!
    const jitter = i < shapes.length ? 1 : 0.82 + random() * 0.5
    const amount = Math.round(shape.amount * jitter * 100) / 100
    const limit =
      shape.limitKey === 'transaction'
        ? policy.maxTransaction
        : shape.limitKey === 'daily'
          ? policy.dailyLimit
          : undefined
    events.push({
      id: `evt_block_${i}`,
      kind: 'payment.blocked',
      agentId: shape.agentId,
      amount,
      service: shape.service,
      reason: shape.reason,
      policyId: policy.id,
      policyLimit: limit,
      dailyLimit: policy.dailyLimit,
      dailyUsage:
        shape.limitKey === 'daily'
          ? policy.dailyLimit - Math.round(random() * 40)
          : Math.round(random() * policy.dailyLimit * 0.4),
      timestamp: new Date(NOW - (i === 0 ? 14 * 60_000 : random() * 13 * DAY)).toISOString(),
      network: 'hedera-testnet',
    })
  }
  return events
}

/** Delegation and creation events, so the tree has a history behind it. */
function buildLifecycle(agents: Agent[]): ActivityEvent[] {
  const random = rng(0xbeef1)
  const events: ActivityEvent[] = []

  for (const agent of agents) {
    if (!agent.parentId) continue
    const created = new Date(agent.createdAt).toISOString()
    events.push({
      id: `evt_create_${agent.id}`,
      kind: 'agent.created',
      agentId: agent.parentId,
      targetAgentId: agent.id,
      timestamp: created,
      network: 'hedera-testnet',
    })
    events.push({
      id: `evt_delegate_${agent.id}`,
      kind: 'authority.delegated',
      agentId: agent.parentId,
      targetAgentId: agent.id,
      amount: agent.authority,
      timestamp: new Date(new Date(created).getTime() + 45_000).toISOString(),
      txId: txId(random),
      network: 'hedera-testnet',
    })
  }

  events.push({
    id: 'evt_policy_1',
    kind: 'policy.changed',
    agentId: 'root',
    policyId: 'pol_compute',
    reason: 'Maximum transaction lowered to $500',
    timestamp: daysAgo(6, 16, 22),
    network: 'hedera-testnet',
  })

  return events
}

/** A handful of events in the last hour, so the live panel opens with a pulse. */
function buildRecent(): ActivityEvent[] {
  const random = rng(0xfade)
  return [
    {
      id: 'evt_recent_1',
      kind: 'payment.approved',
      agentId: 'gpu',
      amount: 42.8,
      service: 'AWS Compute',
      policyId: 'pol_compute',
      policyLimit: 500,
      dailyLimit: 2_000,
      dailyUsage: 220,
      timestamp: minutesAgo(2),
      txId: txId(random),
      network: 'hedera-testnet',
    },
    {
      id: 'evt_recent_2',
      kind: 'agent.created',
      agentId: 'compute',
      targetAgentId: 'gpu',
      timestamp: minutesAgo(8),
      network: 'hedera-testnet',
    },
    {
      id: 'evt_recent_3',
      kind: 'payment.approved',
      agentId: 'data',
      amount: 18.2,
      service: 'Storage',
      policyId: 'pol_data',
      policyLimit: 250,
      dailyLimit: 1_000,
      dailyUsage: 96,
      timestamp: minutesAgo(31),
      txId: txId(random),
      network: 'hedera-testnet',
    },
  ]
}

export interface InitialState {
  agents: Agent[]
  events: ActivityEvent[]
  policies: Policy[]
  services: Service[]
}

export function buildInitialState(): InitialState {
  const agents = buildAgents()
  const payments = buildPayments(agents)

  // The three scripted recent events are already inside each agent's spend
  // total, so drop an equivalent generated payment to keep the sums exact.
  const recent = buildRecent()
  for (const pinned of recent) {
    if (pinned.kind !== 'payment.approved') continue
    const idx = payments.findIndex((p) => p.agentId === pinned.agentId)
    if (idx >= 0) {
      const replaced = payments.splice(idx, 1)[0]
      const delta = replaced.amount! - pinned.amount!
      if (delta !== 0) {
        const sibling = payments.find((p) => p.agentId === pinned.agentId)
        if (sibling) sibling.amount = Math.round((sibling.amount! + delta) * 100) / 100
        else pinned.amount = replaced.amount
      }
    }
  }

  const events = [...payments, ...buildBlocked(), ...buildLifecycle(agents), ...recent].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  )

  return { agents, events, policies: POLICIES, services: SERVICES }
}
