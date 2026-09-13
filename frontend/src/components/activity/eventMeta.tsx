import type { ActivityEvent, ActivityKind } from '../../lib/types'
import type { AgentIndex } from '../../lib/selectors'
import { amountIn } from '../../lib/utils'

export const KIND_LABEL: Record<ActivityKind, string> = {
  'payment.approved': 'Payment settled',
  'payment.blocked': 'Payment denied',
  'agent.created': 'Child agent created',
  'authority.delegated': 'Authority delegated',
  'agent.revoked': 'Agent revoked',
  'agent.renewed': 'Authority renewed',
  'policy.changed': 'Policy changed',
}

export const KIND_TONE: Record<ActivityKind, { dot: string; text: string }> = {
  'payment.approved': { dot: 'bg-authority', text: 'text-authority' },
  'payment.blocked': { dot: 'bg-blocked', text: 'text-blocked' },
  'agent.created': { dot: 'bg-delegated', text: 'text-delegated' },
  'authority.delegated': { dot: 'bg-delegated', text: 'text-delegated' },
  'agent.revoked': { dot: 'bg-blocked', text: 'text-blocked' },
  'agent.renewed': { dot: 'bg-authority', text: 'text-authority' },
  'policy.changed': { dot: 'bg-warn', text: 'text-warn' },
}

/** The event's amount in its own asset. */
export function eventAmount(event: ActivityEvent): string {
  return amountIn(event.amount ?? 0, event.assetSymbol)
}

/** One plain sentence describing what happened, used in every feed. */
export function describe(event: ActivityEvent, index: AgentIndex): string {
  const agent = index[event.agentId]?.name ?? event.agentId
  const target = event.targetAgentId ? (index[event.targetAgentId]?.name ?? event.targetAgentId) : undefined
  const amount = eventAmount(event)

  switch (event.kind) {
    case 'payment.approved':
      return `${agent} paid ${amount} to ${event.service}`
    case 'payment.blocked':
      return event.blockedBy && event.blockedBy !== event.agentId
        ? `${agent} was refused ${amount} — blocked by ${event.blockedBy}`
        : `${agent} was refused ${amount} for ${event.service}`
    case 'agent.created':
      return `${agent} created ${target ?? 'a child agent'}`
    case 'authority.delegated':
      return `${agent} delegated ${amount} to ${target ?? 'a child agent'}`
    case 'agent.revoked':
      return `${agent} lost its spending authority`
    case 'agent.renewed':
      return event.reason ?? `${agent}'s authority was renewed`
    case 'policy.changed':
      return event.reason ?? `${agent} changed a policy`
  }
}

/** Terse form for the live stream: "GPU Agent paid $42.80". */
export function describeShort(event: ActivityEvent, index: AgentIndex): string {
  const agent = index[event.agentId]?.name ?? event.agentId
  switch (event.kind) {
    case 'payment.approved':
      return `${agent} paid ${eventAmount(event)}`
    case 'payment.blocked':
      return `${agent} payment denied`
    case 'agent.created':
      return `${agent} created child`
    case 'authority.delegated':
      return `${agent} delegated ${eventAmount(event)}`
    case 'agent.revoked':
      return `${agent} revoked`
    case 'agent.renewed':
      return `${agent} renewed`
    case 'policy.changed':
      return 'Policy changed'
  }
}
