import type { ActivityEvent, ActivityKind } from '../../lib/types'
import type { AgentIndex } from '../../lib/selectors'
import { money } from '../../lib/utils'

export const KIND_LABEL: Record<ActivityKind, string> = {
  'payment.approved': 'Payment authorized',
  'payment.blocked': 'Payment blocked',
  'agent.created': 'Child agent created',
  'authority.delegated': 'Authority delegated',
  'agent.revoked': 'Agent revoked',
  'policy.changed': 'Policy changed',
}

export const KIND_TONE: Record<ActivityKind, { dot: string; text: string }> = {
  'payment.approved': { dot: 'bg-authority', text: 'text-authority' },
  'payment.blocked': { dot: 'bg-blocked', text: 'text-blocked' },
  'agent.created': { dot: 'bg-delegated', text: 'text-delegated' },
  'authority.delegated': { dot: 'bg-delegated', text: 'text-delegated' },
  'agent.revoked': { dot: 'bg-blocked', text: 'text-blocked' },
  'policy.changed': { dot: 'bg-warn', text: 'text-warn' },
}

/** One plain sentence describing what happened, used in every feed. */
export function describe(event: ActivityEvent, index: AgentIndex): string {
  const agent = index[event.agentId]?.name ?? 'Unknown agent'
  const target = event.targetAgentId ? index[event.targetAgentId]?.name : undefined

  switch (event.kind) {
    case 'payment.approved':
      return `${agent} paid ${money(event.amount ?? 0)} to ${event.service}`
    case 'payment.blocked':
      return `${agent} was refused ${money(event.amount ?? 0)} for ${event.service}`
    case 'agent.created':
      return `${agent} created ${target ?? 'a child agent'}`
    case 'authority.delegated':
      return `${agent} delegated ${money(event.amount ?? 0)} to ${target ?? 'a child agent'}`
    case 'agent.revoked':
      return `${agent} lost its spending authority`
    case 'policy.changed':
      return event.reason ?? `${agent} changed a policy`
  }
}

/** Terse form for the live stream: "GPU Agent paid $42.80". */
export function describeShort(event: ActivityEvent, index: AgentIndex): string {
  const agent = index[event.agentId]?.name ?? 'Unknown agent'
  switch (event.kind) {
    case 'payment.approved':
      return `${agent} paid ${money(event.amount ?? 0)}`
    case 'payment.blocked':
      return `${agent} payment blocked`
    case 'agent.created':
      return `${agent} created child`
    case 'authority.delegated':
      return `${agent} delegated ${money(event.amount ?? 0)}`
    case 'agent.revoked':
      return `${agent} revoked`
    case 'policy.changed':
      return 'Policy changed'
  }
}
