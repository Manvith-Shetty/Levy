import { Link } from 'react-router-dom'
import { useLeash } from '../../lib/store'
import { statsFor } from '../../lib/selectors'
import type { ActivityEvent } from '../../lib/types'
import { hashscanUrl } from '../../lib/config'
import { amountIn, cx, formatDateTime, money, shortHash } from '../../lib/utils'
import { Drawer, Row } from '../common/Drawer'
import { LimitBar } from '../common/Meter'
import { eventAmount, KIND_LABEL } from './eventMeta'
import { IconExternal } from '../layout/icons'

export function TransactionDrawer({
  event,
  onClose,
}: {
  event: ActivityEvent | null
  onClose: () => void
}) {
  const { index, policies, network, live } = useLeash()
  if (!event) return null

  const agent = index[event.agentId]
  const parent = agent?.parentId ? index[agent.parentId] : undefined
  const target = event.targetAgentId ? index[event.targetAgentId] : undefined
  const policy = policies.find((p) => p.id === event.policyId)
  const stats = agent ? statsFor(index, agent.id) : undefined
  const blocked = event.kind === 'payment.blocked' || event.kind === 'agent.revoked'
  const isPayment = event.kind === 'payment.approved' || event.kind === 'payment.blocked'

  const explorer =
    event.explorerUrl ??
    `https://hashscan.io/${network === 'hedera-mainnet' ? 'mainnet' : 'testnet'}/transaction/${event.txId ?? ''}`
  const eventNetwork = event.source ? event.network : network
  const networkLabel =
    eventNetwork === 'ethereum-sepolia'
      ? 'Ethereum Sepolia'
      : eventNetwork === 'hedera-mainnet'
        ? 'Hedera Mainnet'
        : 'Hedera Testnet'
  const neutral = event.kind === 'agent.created' || event.kind === 'authority.delegated' || event.kind === 'agent.renewed'

  return (
    <Drawer open onClose={onClose} title={KIND_LABEL[event.kind]}>
      <div
        className={cx(
          'rounded-lg border p-4',
          blocked ? 'border-blocked/35 bg-blocked/[0.06]' : 'border-authority/30 bg-authority/[0.05]',
        )}
      >
        <p className={cx('text-[12.5px] font-medium', blocked ? 'text-blocked' : 'text-authority')}>
          {blocked
            ? event.kind === 'agent.revoked'
              ? '✕ REVOKED'
              : '✕ BLOCKED'
            : neutral
              ? '✓ CONFIRMED ON-CHAIN'
              : '✓ APPROVED'}
        </p>
        {event.amount != null && (
          <p
            className={cx(
              'numeric mt-1.5 text-[32px] leading-none font-semibold',
              blocked ? 'text-blocked' : 'text-ink',
            )}
          >
            {eventAmount(event)}
          </p>
        )}
        {event.counted === false && event.kind === 'payment.approved' && (
          <p className="mt-2 text-[12px] text-muted">
            Settled in {event.assetSymbol}, so it isn't counted toward the tree's spend.
          </p>
        )}
        {event.reason && (
          <p className="mt-3 text-[13px] leading-5 text-ink-dim">{event.reason}.</p>
        )}
        {event.blockedBy && (
          <div className="mt-3 flex items-baseline justify-between border-t border-blocked/20 pt-3">
            <span className="text-[12.5px] text-muted">Blocked by</span>
            <span className="font-mono text-[12.5px] text-ink">{event.blockedBy}</span>
          </div>
        )}
        {event.kind === 'payment.blocked' && event.policyLimit != null && (
          <div className="mt-3 flex items-baseline justify-between border-t border-blocked/20 pt-3">
            <span className="text-[12.5px] text-muted">Maximum allowed</span>
            <span className="numeric text-[14px] font-medium text-ink">{money(event.policyLimit)}</span>
          </div>
        )}
      </div>

      <dl className="mt-5">
        <Row label="Agent">
          {agent ? (
            <Link to={`/agents/${agent.id}`} className="underline-offset-4 hover:underline">
              {agent.name}
            </Link>
          ) : (
            <span className="font-mono text-[12.5px]">{event.agentId}</span>
          )}
        </Row>
        {parent && <Row label="Parent">{parent.name}</Row>}
        {target && (
          <Row label="Delegated to">
            <Link to={`/agents/${target.id}`} className="underline-offset-4 hover:underline">
              {target.name}
            </Link>
          </Row>
        )}
        {event.service && <Row label="Service">{event.service}</Row>}
        {isPayment && (
          <Row label="Requested">
            <span className="numeric">{eventAmount(event)}</span>
          </Row>
        )}
        {event.kind === 'payment.approved' && event.policyLimit != null && (
          <Row label="Policy limit">
            <span className="numeric">{money(event.policyLimit)}</span>
          </Row>
        )}
        {policy && event.kind === 'policy.changed' && <Row label="Policy">{policy.name}</Row>}
        {stats && (
          <Row label="Remaining authority">
            <span className="numeric text-authority">{money(stats.available)}</span>
          </Row>
        )}
        {event.payer && (
          <Row label="Paid from">
            <a
              href={hashscanUrl('account', event.payer)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[12.5px] underline-offset-4 hover:underline active:opacity-70"
            >
              {event.payer}
            </a>
          </Row>
        )}
        <Row label="Timestamp">{formatDateTime(event.timestamp)}</Row>
        <Row label="Network">
          {networkLabel}
        </Row>
      </dl>

      {isPayment && event.dailyLimit != null && (
        <div className="mt-5 rounded-lg border border-line bg-sunken p-4">
          <div className="flex items-baseline justify-between">
            <p className="text-[12.5px] text-muted">Daily usage</p>
            <p className="numeric text-[12.5px] text-ink">
              {money(event.dailyUsage ?? 0)} / {money(event.dailyLimit)}
            </p>
          </div>
          <LimitBar
            used={(event.dailyUsage ?? 0) + (event.kind === 'payment.approved' ? (event.amount ?? 0) : 0)}
            limit={event.dailyLimit}
            className="mt-2.5"
          />
        </div>
      )}

      {event.mandatePath && event.mandatePath.length > 0 && (
        <div className="mt-5">
          <p className="text-[12.5px] text-muted">Authorized by</p>
          <p className="mt-0.5 text-[11.5px] text-faint">
            The chain the gateway checked, root first, as it stood when this settled.
          </p>
          <ol className="mt-2.5 space-y-1.5">
            {event.mandatePath.map((hop, i) => (
              <li
                key={hop.name}
                className="flex items-baseline justify-between gap-3 rounded-md border border-line bg-sunken px-3 py-2"
                style={{ marginLeft: i * 10 }}
              >
                <span className="truncate font-mono text-[12px] text-ink">{hop.name}</span>
                <span className="numeric shrink-0 text-[12px] text-muted">
                  {amountIn(hop.budget, event.assetSymbol)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {event.txId && (
        <div className="mt-5">
          <p className="text-[12.5px] text-muted">Transaction{event.explorerLabel ? ` on ${event.explorerLabel}` : ''}</p>
          <a
            href={explorer}
            target="_blank"
            rel="noreferrer"
            className="wash press mt-1.5 flex items-center justify-between gap-3 rounded-md border border-line bg-sunken px-3 py-2.5 hover:border-line-strong"
          >
            <span className="truncate font-mono text-[12px] text-ink-dim">
              {shortHash(event.txId, 14, 8)}
            </span>
            <IconExternal className="h-3.5 w-3.5 shrink-0 text-faint" />
          </a>
        </div>
      )}

      {event.source === 'hcs' && live.snapshot?.topicId && (
        <a
          href={hashscanUrl('topic', live.snapshot.topicId)}
          target="_blank"
          rel="noreferrer"
          className="mt-4 block text-[12px] text-muted hover:text-authority active:opacity-70"
        >
          Replayed from HCS topic {live.snapshot.topicId}
        </a>
      )}
    </Drawer>
  )
}
