import { useRestore } from '../../hooks/useRestore'
import { useLeash } from '../../lib/store'
import type { Agent, AgentStatus } from '../../lib/types'
import { Button } from '../common/Button'

/**
 * Revoke for a live or demo agent; Restore (renew on-chain) for a live agent
 * whose own authority is gone.
 */
export function RevokeOrRestore({
  agent,
  status,
  onRevoke,
  className,
}: {
  agent: Agent
  status: AgentStatus
  onRevoke: (agent: Agent) => void
  className?: string
}) {
  const { live } = useLeash()
  const { restore, pending } = useRestore()

  if (live.active && (status === 'revoked' || status === 'expired')) {
    return (
      <Button
        variant="primary"
        className={className}
        disabled={pending === agent.id}
        onClick={() => restore(agent)}
      >
        {pending === agent.id ? 'Confirm in your wallet…' : 'Restore authority'}
      </Button>
    )
  }

  return (
    <Button
      variant="danger"
      className={className}
      disabled={status === 'revoked'}
      onClick={() => onRevoke(agent)}
    >
      Revoke agent
    </Button>
  )
}
