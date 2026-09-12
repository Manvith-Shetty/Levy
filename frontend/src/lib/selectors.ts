import type { ActivityEvent, Agent, AgentStatus } from './types'
import { ratio, startOfDay } from './utils'

export type AgentIndex = Record<string, Agent>

export function indexAgents(agents: Agent[]): AgentIndex {
  return Object.fromEntries(agents.map((a) => [a.id, a]))
}

export function rootAgents(agents: Agent[]): Agent[] {
  return agents.filter((a) => !a.parentId)
}

export function descendants(index: AgentIndex, id: string): Agent[] {
  const out: Agent[] = []
  const walk = (current: string) => {
    for (const childId of index[current]?.children ?? []) {
      const child = index[childId]
      if (!child) continue
      out.push(child)
      walk(childId)
    }
  }
  walk(id)
  return out
}

export function ancestors(index: AgentIndex, id: string): Agent[] {
  const out: Agent[] = []
  let current = index[id]?.parentId
  while (current) {
    const agent = index[current]
    if (!agent) break
    out.push(agent)
    current = agent.parentId
  }
  return out
}

/**
 * Everything a single agent card needs to be drawn, in one place.
 *
 * Authority splits three ways and the three always sum to `authority`:
 *
 *   spent     — settled by this agent or anything beneath it (the roll-up)
 *   reserved  — handed to children but not yet spent by them
 *   free      — neither spent nor delegated; the only part this agent can
 *               still spend directly or grant to a new child
 */
export interface AgentStats {
  /** Authority granted to live direct children. */
  delegated: number
  /** This agent's own settled spend. */
  ownSpent: number
  /** Own spend plus every descendant's — what the product calls "spent". */
  spent: number
  /** Delegated authority the children haven't spent yet. */
  reserved: number
  /** Authority minus roll-up spend: what's left anywhere in this branch. */
  remaining: number
  /** Free to spend directly or delegate. */
  available: number
  /** Roll-up spend against authority. */
  utilization: number
  childCount: number
}

const round = (n: number) => Math.round(n * 100) / 100

export function statsFor(index: AgentIndex, id: string): AgentStats {
  const agent = index[id]
  if (!agent) {
    return {
      delegated: 0,
      ownSpent: 0,
      spent: 0,
      reserved: 0,
      remaining: 0,
      available: 0,
      utilization: 0,
      childCount: 0,
    }
  }

  const liveChildren = agent.children
    .map((childId) => index[childId])
    .filter((child): child is Agent => Boolean(child) && child.status !== 'revoked')

  const delegated = liveChildren.reduce((sum, child) => sum + child.authority, 0)
  const childrenSpent = agent.children
    .map((childId) => index[childId])
    .filter((child): child is Agent => Boolean(child))
    .reduce((sum, child) => sum + rollupSpent(index, child.id), 0)
  const spent = round(agent.spent + childrenSpent)
  const available = round(Math.max(0, agent.authority - agent.spent - delegated))

  return {
    delegated,
    ownSpent: agent.spent,
    spent,
    reserved: round(Math.max(0, agent.authority - spent - available)),
    remaining: round(Math.max(0, agent.authority - spent)),
    available,
    utilization: ratio(spent, agent.authority),
    childCount: agent.children.length,
  }
}

function rollupSpent(index: AgentIndex, id: string): number {
  const agent = index[id]
  if (!agent) return 0
  return agent.spent + agent.children.reduce((sum, childId) => sum + rollupSpent(index, childId), 0)
}

/** Status is derived from spend and expiry, except when explicitly revoked. */
export function deriveStatus(agent: Agent, index: AgentIndex): AgentStatus {
  if (agent.status === 'revoked' || agent.status === 'suspended') return agent.status
  if (agent.expiresAt && new Date(agent.expiresAt).getTime() <= Date.now()) return 'expired'
  const { utilization } = statsFor(index, agent.id)
  if (utilization >= 0.8) return 'warning'
  return 'active'
}

export function eventsForAgent(events: ActivityEvent[], agentId: string): ActivityEvent[] {
  return events.filter((e) => e.agentId === agentId || e.targetAgentId === agentId)
}

export function approvedFor(events: ActivityEvent[], agentId?: string): ActivityEvent[] {
  return events.filter(
    (e) => e.kind === 'payment.approved' && (agentId ? e.agentId === agentId : true),
  )
}

export function spentSince(events: ActivityEvent[], agentId: string, since: number): number {
  return (
    Math.round(
      approvedFor(events, agentId)
        .filter((e) => new Date(e.timestamp).getTime() >= since)
        .reduce((sum, e) => sum + (e.amount ?? 0), 0) * 100,
    ) / 100
  )
}

export function spentToday(events: ActivityEvent[], agentId: string): number {
  return spentSince(events, agentId, startOfDay(new Date()))
}

export function spentThisWeek(events: ActivityEvent[], agentId?: string): number {
  const since = startOfDay(new Date()) - 6 * 86_400_000
  if (agentId) return spentSince(events, agentId, since)
  return (
    Math.round(
      approvedFor(events)
        .filter((e) => new Date(e.timestamp).getTime() >= since)
        .reduce((sum, e) => sum + (e.amount ?? 0), 0) * 100,
    ) / 100
  )
}

export interface DayPoint {
  date: string
  day: number
  total: number
}

/** Daily approved spend for the last `days` days, oldest first. */
export function dailySpend(
  events: ActivityEvent[],
  days = 14,
  agentId?: string,
): DayPoint[] {
  const today = startOfDay(new Date())
  const buckets = new Map<number, number>()
  for (let i = days - 1; i >= 0; i--) buckets.set(today - i * 86_400_000, 0)

  for (const event of approvedFor(events, agentId)) {
    const day = startOfDay(event.timestamp)
    if (!buckets.has(day)) continue
    buckets.set(day, buckets.get(day)! + (event.amount ?? 0))
  }

  return [...buckets.entries()].map(([day, total]) => ({
    day,
    date: new Date(day).toISOString(),
    total: Math.round(total * 100) / 100,
  }))
}

export interface Totals {
  authority: number
  spent: number
  utilization: number
  activeAgents: number
  delegatedAgents: number
  blocked: number
  blockedThisWeek: number
  remaining: number
  today: number
  week: number
}

export function portfolioTotals(agents: Agent[], events: ActivityEvent[]): Totals {
  const index = indexAgents(agents)
  const roots = rootAgents(agents)
  const authority = roots.reduce((sum, a) => sum + a.authority, 0)
  const spent =
    Math.round(agents.reduce((sum, a) => sum + a.spent, 0) * 100) / 100
  const live = agents.filter((a) => a.status !== 'revoked' && a.status !== 'expired')
  const weekStart = startOfDay(new Date()) - 6 * 86_400_000
  const blockedEvents = events.filter((e) => e.kind === 'payment.blocked')

  const todayStart = startOfDay(new Date())
  const today =
    Math.round(
      approvedFor(events)
        .filter((e) => new Date(e.timestamp).getTime() >= todayStart)
        .reduce((sum, e) => sum + (e.amount ?? 0), 0) * 100,
    ) / 100

  return {
    authority,
    spent,
    utilization: ratio(spent, authority),
    activeAgents: live.length,
    delegatedAgents: live.filter((a) => statsFor(index, a.id).childCount > 0).length,
    blocked: blockedEvents.length,
    blockedThisWeek: blockedEvents.filter(
      (e) => new Date(e.timestamp).getTime() >= weekStart,
    ).length,
    remaining: Math.round((authority - spent) * 100) / 100,
    today,
    week: spentThisWeek(events),
  }
}

export interface AgentSpend {
  agent: Agent
  spent: number
  share: number
}

/** Roll-up spend per agent, excluding the root (whose roll-up is the total). */
export function spendByAgent(agents: Agent[]): AgentSpend[] {
  const index = indexAgents(agents)
  const rows = agents
    .filter((a) => a.parentId)
    .map((agent) => ({ agent, spent: statsFor(index, agent.id).spent }))
    .filter((row) => row.spent > 0)
    .sort((a, b) => b.spent - a.spent)
  const max = Math.max(...rows.map((r) => r.spent), 1)
  return rows.map((row) => ({ ...row, share: row.spent / max }))
}

/** The nearest ancestor whose own authority is gone, if any — what the guard
 *  would name when refusing this agent. */
export function blockingAncestor(index: AgentIndex, id: string): Agent | undefined {
  return ancestors(index, id).find((a) => a.status === 'revoked' || a.status === 'expired')
}

export interface CeilingHop {
  agent: Agent
  /** min(budget, maxPerCall) at this node, in whole units. */
  ceiling: number
  limitedBy: 'budget' | 'max per call'
}

/**
 * The largest single payment an agent can make right now: the guard checks
 * the amount against every node's budget and max-per-call, root to leaf, so
 * the answer is the smallest of all of them.
 */
export function effectiveCeiling(index: AgentIndex, id: string): { hops: CeilingHop[]; limit?: CeilingHop } {
  const agent = index[id]
  if (!agent) return { hops: [] }
  const chain = [...ancestors(index, id).reverse(), agent]
  const hops = chain.map((a) => {
    const perCall = a.mandate?.maxPerCall ?? a.authority
    return perCall < a.authority
      ? { agent: a, ceiling: perCall, limitedBy: 'max per call' as const }
      : { agent: a, ceiling: a.authority, limitedBy: 'budget' as const }
  })
  const limit = hops.reduce<CeilingHop | undefined>(
    (min, hop) => (!min || hop.ceiling < min.ceiling ? hop : min),
    undefined,
  )
  return { hops, limit }
}
