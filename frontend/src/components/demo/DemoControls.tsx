import { useState } from 'react'
import { useLeash } from '../../lib/store'
import type { PaymentDecision } from '../../lib/types'
import { cx, money } from '../../lib/utils'
import { Button } from '../common/Button'
import { Select } from '../common/Field'
import { useToast } from '../../app/toast'
import { PaymentResult } from './PaymentResult'

/**
 * Demo controls. Everything here goes through the same authorization path the
 * real gateway would call, so a blocked payment is blocked by the policy, not
 * by a script.
 */
export function DemoControls({
  onRequestCreate,
  onRequestRevoke,
}: {
  onRequestCreate: (parentId: string) => void
  onRequestRevoke: (agentId: string) => void
}) {
  const { agents, index, demoMode, requestPayment } = useLeash()
  const { push } = useToast()
  const [open, setOpen] = useState(false)
  const [agentId, setAgentId] = useState('gpu')
  const [decision, setDecision] = useState<PaymentDecision | null>(null)

  if (!demoMode) return null

  const agent = index[agentId] ?? agents[0]
  const firstAllowed = agent?.permissions.find((p) => p.allowed)?.resource
  const service =
    firstAllowed === 'compute' ? 'AWS Compute' : firstAllowed === 'inference' ? 'OpenAI API' : 'Storage'

  function pay(amount: number) {
    const result = requestPayment({ agentId: agent.id, amount, service })
    setDecision(result)
    push(
      result.approved
        ? {
            tone: 'success',
            title: 'Payment authorized',
            body: `${money(amount)} authorized for ${agent.name}.`,
          }
        : {
            tone: 'blocked',
            title: 'Payment blocked',
            body: "Transaction exceeded the agent's authority.",
          },
    )
  }

  const live = agents.filter((a) => a.status !== 'revoked')

  return (
    <>
      <div className="fixed bottom-5 left-[252px] z-40 hidden w-[262px] lg:block">
        {open ? (
          <div className="animate-enter overflow-hidden rounded-xl border border-delegated/30 bg-surface/95 shadow-[var(--shadow-floating)] backdrop-blur">
            <header className="flex items-center justify-between border-b border-hairline px-3.5 py-2.5">
              <span className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
                <span className="h-1.5 w-1.5 rounded-full bg-delegated" />
                Demo controls
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Hide demo controls"
                className="press text-faint hover:text-ink"
              >
                <svg viewBox="0 0 12 12" className="h-3 w-3">
                  <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </header>

            <div className="space-y-3 p-3.5">
              <div>
                <label className="mb-1.5 block text-[11.5px] text-faint" htmlFor="demo-agent">
                  Acting agent
                </label>
                <Select
                  id="demo-agent"
                  value={agent?.id}
                  onChange={(e) => setAgentId(e.target.value)}
                >
                  {live.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>

              </div>

              <div className="space-y-1.5">
                <DemoButton onClick={() => pay(42.8)}>Simulate Payment</DemoButton>
                <DemoButton onClick={() => pay(750)} tone="blocked">
                  Simulate Blocked Payment
                </DemoButton>
                <DemoButton onClick={() => onRequestCreate(agent.id)}>Create Child Agent</DemoButton>
                <DemoButton onClick={() => onRequestRevoke(agent.id)} tone="blocked">
                  Revoke Agent
                </DemoButton>
              </div>
            </div>
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
            <span className="h-1.5 w-1.5 rounded-full bg-delegated" />
            Demo controls
          </Button>
        )}
      </div>

      <PaymentResult decision={decision} onClose={() => setDecision(null)} />
    </>
  )
}

function DemoButton({
  children,
  onClick,
  tone = 'neutral',
}: {
  children: React.ReactNode
  onClick: () => void
  tone?: 'neutral' | 'blocked'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'wash press w-full rounded-md border px-3 py-2 text-left text-[12.5px]',
        tone === 'blocked'
          ? 'border-line bg-sunken text-ink-dim hover:border-blocked/45 hover:text-blocked'
          : 'border-line bg-sunken text-ink-dim hover:border-authority/45 hover:text-authority',
      )}
    >
      {children}
    </button>
  )
}
