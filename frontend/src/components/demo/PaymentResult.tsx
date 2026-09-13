import { useLeash } from '../../lib/store'
import type { PaymentDecision } from '../../lib/types'
import { cx, money, shortHash } from '../../lib/utils'
import { Modal, ModalFoot } from '../common/Modal'
import { Button } from '../common/Button'
import { config } from '../../lib/config'

/**
 * The authorization read-out (spec §23). It answers "why?": the request, the
 * ceiling it was measured against, then the verdict.
 */
export function PaymentResult({
  decision,
  onClose,
}: {
  decision: PaymentDecision | null
  onClose: () => void
}) {
  const { index, policies } = useLeash()
  if (!decision) return null

  const event = decision.event
  const agent = index[event.agentId]
  const policy = policies.find((p) => p.id === event.policyId)
  const approved = decision.approved
  const limitLabel = decision.limitLabel ?? 'Maximum transaction'
  const limitValue = decision.limitValue ?? event.policyLimit

  return (
    <Modal open onClose={onClose} width="max-w-md" labelledBy="payment-result-title">
      <div className="px-6 pt-6 pb-6">
        <p className="text-[12px] font-medium tracking-[0.06em] text-faint">PAYMENT REQUEST</p>
        <h2 id="payment-result-title" className="mt-1.5 text-[18px] font-semibold text-ink">
          {agent?.name ?? 'Unknown agent'}
        </h2>
        <p className="text-[13px] text-muted">{event.service}</p>

        <dl className="mt-5 space-y-3">
          <div className="flex items-baseline justify-between gap-4">
            <dt className="text-[13px] text-muted">Requested</dt>
            <dd className={cx('numeric text-[26px] leading-none font-semibold', approved ? 'text-ink' : 'text-blocked')}>
              {money(event.amount ?? 0)}
            </dd>
          </div>
          {limitValue != null && (
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-[13px] text-muted">{limitLabel}</dt>
              <dd className="numeric text-[17px] font-medium text-ink">{money(limitValue)}</dd>
            </div>
          )}
        </dl>

        <div
          className={cx(
            'animate-enter mt-5 rounded-lg border p-4',
            approved
              ? 'border-authority/35 bg-authority/[0.06]'
              : 'border-blocked/40 bg-blocked/[0.07]',
          )}
        >
          <p className={cx('text-[14px] font-semibold', approved ? 'text-authority' : 'text-blocked')}>
            {approved ? '✓ PAYMENT AUTHORIZED' : '✕ PAYMENT BLOCKED'}
          </p>
          {!approved && (
            <>
              <p className="mt-3 text-[12px] text-faint">Reason</p>
              <p className="copy text-[13px] text-ink-dim">{decision.reason}.</p>
            </>
          )}
          {policy && (
            <p className="mt-3 text-[12.5px] text-muted">
              Policy: <span className="text-ink-dim">{policy.name} Policy</span>
            </p>
          )}
          {approved && event.txId && (
            <p className="mt-1 font-mono text-[11.5px] text-faint">{shortHash(event.txId, 10, 6)}</p>
          )}
        </div>
      </div>

      <ModalFoot>
        <span className="text-[12px] text-faint">{config.hederaNetworkName}</span>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFoot>
    </Modal>
  )
}
