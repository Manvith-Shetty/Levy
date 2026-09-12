import { Link } from 'react-router-dom'
import { useLeash } from '../../lib/store'
import { deriveStatus, statsFor } from '../../lib/selectors'
import type { Agent } from '../../lib/types'
import { formatDate, money } from '../../lib/utils'
import { Drawer, Row } from '../common/Drawer'
import { Button, ButtonLink } from '../common/Button'
import { StatusBadge } from '../common/Badge'
import { AuthorityMeter } from '../common/Meter'

export function AgentDrawer({
  agent,
  onClose,
  onRevoke,
}: {
  agent: Agent | null
  onClose: () => void
  onRevoke: (agent: Agent) => void
}) {
  const { index } = useLeash()
  if (!agent) return null

  const live = index[agent.id] ?? agent
  const stats = statsFor(index, live.id)
  const status = deriveStatus(live, index)
  const parent = live.parentId ? index[live.parentId] : undefined
  const children = live.children.map((id) => index[id]).filter(Boolean)

  return (
    <Drawer
      open
      onClose={onClose}
      title={live.name}
      subtitle={<StatusBadge status={status} size="sm" />}
      footer={
        <div className="flex gap-2">
          <ButtonLink to={`/agents/${live.id}`} variant="secondary" className="flex-1">
            View details
          </ButtonLink>
          <Button
            variant="danger"
            className="flex-1"
            disabled={status === 'revoked'}
            onClick={() => onRevoke(live)}
          >
            Revoke agent
          </Button>
        </div>
      }
    >
      <div className="rounded-lg border border-line bg-sunken p-4">
        <p className="text-[12px] text-faint">Authority</p>
        <p className="numeric mt-1 text-[30px] leading-none font-semibold text-ink">
          {money(live.authority)}
        </p>
        <AuthorityMeter
          authority={live.authority}
          spent={stats.spent}
          reserved={stats.reserved}
          size="md"
          muted={status === 'revoked'}
          className="mt-4"
        />
        <dl className="mt-4 grid grid-cols-2 gap-3">
          <div>
            <dt className="text-[12px] text-faint">Spent</dt>
            <dd className="numeric mt-0.5 text-[17px] font-semibold text-ink">{money(stats.spent)}</dd>
          </div>
          <div>
            <dt className="text-[12px] text-faint">Remaining</dt>
            <dd className="numeric mt-0.5 text-[17px] font-semibold text-authority">
              {money(stats.remaining)}
            </dd>
          </div>
        </dl>
      </div>

      <dl className="mt-5">
        <Row label="Parent">
          {parent ? (
            <Link to={`/agents/${parent.id}`} className="text-ink underline-offset-4 hover:underline active:opacity-70">
              {parent.name}
            </Link>
          ) : (
            'Account owner'
          )}
        </Row>
        <Row label="Expires">{live.expiresAt ? formatDate(live.expiresAt) : 'Never'}</Row>
      </dl>

      <div className="mt-5">
        <p className="mb-2 text-[12.5px] text-muted">Children</p>
        {children.length === 0 ? (
          <p className="copy rounded-md border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-faint">
            This agent hasn't delegated authority yet.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {children.map((child) => (
              <li key={child.id}>
                <Link
                  to={`/agents/${child.id}`}
                  className="wash press flex items-center justify-between gap-3 rounded-md border border-line bg-sunken px-3 py-2 hover:border-line-strong"
                >
                  <span className="truncate text-[12.5px] text-ink">{child.name}</span>
                  <span className="numeric shrink-0 text-[12px] text-muted">
                    {money(child.authority)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Drawer>
  )
}
