import { useLeash } from '../../lib/store'
import { descendants, statsFor } from '../../lib/selectors'
import type { Agent } from '../../lib/types'
import { money } from '../../lib/utils'
import { Modal, ModalFoot, ModalHead } from '../common/Modal'
import { Button } from '../common/Button'
import { config } from '../../lib/config'

export function RevokeAgentModal({
  agent,
  onClose,
  onConfirm,
  busy = false,
}: {
  agent: Agent | null
  onClose: () => void
  onConfirm: (agent: Agent) => void
  busy?: boolean
}) {
  const { index, live } = useLeash()
  if (!agent) return null

  const stats = statsFor(index, agent.id)
  const kids = descendants(index, agent.id).filter((a) => a.status !== 'revoked')

  return (
    <Modal open onClose={onClose} width="max-w-md" labelledBy="revoke-title">
      <ModalHead
        id="revoke-title"
        title={`Revoke ${agent.name}?`}
        hint="This will immediately remove the agent's spending authority."
        onClose={busy ? () => undefined : onClose}
      />

      <div className="px-6 py-5">
        <p className="text-[13px] text-ink-dim">The agent will no longer be able to:</p>
        <ul className="mt-2.5 space-y-1.5 text-[13px] text-muted">
          {['authorize payments', 'create child agents', 'access permitted services'].map(
            (line) => (
              <li key={line} className="flex gap-2.5">
                <span className="text-blocked">✕</span>
                {line}
              </li>
            ),
          )}
        </ul>

        <dl className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-line bg-sunken p-3">
            <dt className="text-[12px] text-faint">Current authority</dt>
            <dd className="numeric mt-1 text-[17px] font-semibold text-ink">
              {money(agent.authority)}
            </dd>
          </div>
          <div className="rounded-lg border border-line bg-sunken p-3">
            <dt className="text-[12px] text-faint">Current spend</dt>
            <dd className="numeric mt-1 text-[17px] font-semibold text-ink">
              {money(stats.spent)}
            </dd>
          </div>
        </dl>

        {kids.length > 0 && (
          <div className="mt-4 rounded-lg border border-blocked/35 bg-blocked/[0.07] p-3.5">
            <p className="text-[13px] font-medium text-blocked">
              {kids.length} delegated agent{kids.length > 1 ? 's' : ''} lose authority too
            </p>
            <p className="copy mt-1 text-[12.5px] text-muted">
              {kids.map((k) => k.name).join(', ')} hold authority granted by {agent.name}, so they
              are revoked with it.
            </p>
          </div>
        )}

        {live.active ? (
          <p className="copy mt-4 text-[12.5px] text-muted">
            Sends one <span className="font-mono text-[12px] text-ink-dim">unregister</span>{' '}
            transaction on {config.ensChainName} from your connected wallet. The gateway's next check walks up
            through {agent.name}, finds it gone, and refuses — no transaction per child. You can
            restore it afterwards by renewing it.
          </p>
        ) : (
          <p className="mt-4 text-[12.5px] text-faint">This action cannot be automatically undone.</p>
        )}
      </div>

      <ModalFoot>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="danger" onClick={() => onConfirm(agent)} disabled={busy}>
          {busy ? 'Confirm in your wallet…' : 'Revoke agent'}
        </Button>
      </ModalFoot>
    </Modal>
  )
}
