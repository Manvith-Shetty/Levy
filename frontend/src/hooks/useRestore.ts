import { useState } from 'react'
import { useToast } from '../app/toast'
import { explain } from '../lib/live/wallet'
import { useLeash } from '../lib/store'
import type { Agent } from '../lib/types'
import { config } from '../lib/config'

/** Renews a revoked or lapsed live agent from the connected wallet. */
export function useRestore() {
  const { live } = useLeash()
  const { push } = useToast()
  const [pending, setPending] = useState<string | null>(null)

  async function restore(agent: Agent) {
    setPending(agent.id)
    try {
      if (!live.account) await live.connect()
      await live.renew(agent.id)
      push({
        tone: 'success',
        title: 'Authority restored',
        body: `${agent.name} was renewed on ${config.ensChainName} and can authorize payments again.`,
      })
    } catch (error) {
      push({ tone: 'blocked', title: 'Restore not sent', body: explain(error, agent.account) })
    } finally {
      setPending(null)
    }
  }

  return { restore, pending }
}
