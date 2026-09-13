import type { PolicyCheck, PolicyDecision } from '../../lib/gateway/types'
import { config } from '../../lib/config'
import { useLeash } from '../../lib/store'
import { cx, money } from '../../lib/utils'

const VIOLATION_CHECK: Record<string, PolicyCheck['id']> = {
  unresolvable: 'active',
  expired: 'expiry',
  over_budget: 'authority',
  insufficient_authority: 'authority',
  over_per_call_limit: 'per_call',
  service_not_permitted: 'service',
  asset_not_permitted: 'asset',
}

/** Atomic units of the tree's asset → dollars. */
function usd(atomic: number | bigint | undefined): string {
  return money(Number(atomic ?? 0) / 10 ** config.assetDecimals)
}

/**
 * Leash's decision on one payment: the verdict, the reason in plain words,
 * and every check the policy engine ran, with the node that failed each.
 */
export function PolicyChecklist({ decision, className }: { decision: PolicyDecision; className?: string }) {
  const { live } = useLeash()
  const nodes = live.nodes

  const detail = (check: PolicyCheck): string | undefined => {
    if (check.status !== 'fail' || !check.node) return undefined
    const node = check.node
    const records = nodes[node]?.records
    switch (check.id) {
      case 'active':
        return `${node} isn't a registered agent.`
      case 'expiry':
        return `${node}'s authority expired or was revoked.`
      case 'authority': {
        const spent = decision.spent[node] ?? 0
        const budget = records?.budget ?? decision.path.find((h) => h.name === node)?.budget
        return spent > 0
          ? `${node} has ${usd(Number(budget ?? 0) - spent)} left of ${usd(budget)}; this needs ${usd(decision.amount)}.`
          : `${usd(decision.amount)} is more than ${node}'s whole authority of ${usd(budget)}.`
      }
      case 'per_call':
        return `${node} allows at most ${usd(records?.maxPerCall)} per request.`
      case 'service':
        return `${node}'s policy doesn't permit ${decision.service}.`
      case 'asset':
        return `${node}'s policy doesn't permit paying in ${decision.asset}.`
    }
  }

  // The engine's own verdict names the deciding rule; show that one.
  const decidingId = decision.violation ? VIOLATION_CHECK[decision.violation] : undefined
  const deciding = decision.checks.find((c) => c.id === decidingId && c.status === 'fail')
  const reason = decision.approved ? null : (deciding && detail(deciding)) ?? decision.reason

  return (
    <div className={cx('rounded-lg border bg-sunken', decision.approved ? 'border-authority/30' : 'border-blocked/35', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-3">
        <p className="text-[12.5px] text-muted">
          <span className="font-mono text-ink">{decision.agent}</span> · {decision.service} ·{' '}
          <span className="numeric text-ink">{usd(decision.amount)}</span> {decision.asset}
        </p>
        <span
          className={cx(
            'rounded px-2 py-0.5 text-[11.5px] font-semibold tracking-wide',
            decision.approved ? 'bg-authority/15 text-authority' : 'bg-blocked/15 text-blocked',
          )}
        >
          {decision.approved ? 'APPROVED' : 'DENIED'}
        </span>
      </div>
      <ul className="space-y-1.5 px-4 py-3">
        {decision.checks.map((check) => (
          <li key={check.id} className="flex gap-2.5 text-[12.5px]">
            <span
              aria-hidden
              className={cx(
                'w-3 shrink-0 text-center font-semibold',
                check.status === 'pass' && 'text-authority',
                check.status === 'fail' && 'text-blocked',
                check.status === 'skipped' && 'text-faint',
              )}
            >
              {check.status === 'pass' ? '✓' : check.status === 'fail' ? '✕' : '–'}
            </span>
            <span className="min-w-0">
              <span className={check.status === 'skipped' ? 'text-faint' : 'text-ink'}>{check.label}</span>
              <span className="sr-only">: {check.status}</span>
              {detail(check) && <span className="block text-blocked/90">{detail(check)}</span>}
            </span>
          </li>
        ))}
      </ul>
      {reason && (
        <p className="copy border-t border-hairline px-4 py-2.5 text-[12.5px] text-blocked">
          Denied: {reason}
        </p>
      )}
      {decision.ledger_error && (
        <p className="border-t border-hairline px-4 py-2 text-[11.5px] text-warn">
          Spending totals may be a few seconds stale: the mirror node didn't answer.
        </p>
      )}
    </div>
  )
}
