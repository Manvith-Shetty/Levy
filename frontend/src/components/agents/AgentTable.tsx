import { Link, useNavigate } from 'react-router-dom'
import { useLeash } from '../../lib/store'
import { deriveStatus, statsFor } from '../../lib/selectors'
import type { Agent } from '../../lib/types'
import { cx, money, percent } from '../../lib/utils'
import { StatusBadge } from '../common/Badge'
import { AuthorityMeter } from '../common/Meter'
import { Menu } from '../common/Menu'
import { EmptyState } from '../common/EmptyState'

export function AgentTable({
  agents,
  onRevoke,
  onCreateChild,
  emptyBody = 'No agents match these filters.',
}: {
  agents: Agent[]
  onRevoke: (agent: Agent) => void
  onCreateChild: (agent: Agent) => void
  emptyBody?: string
}) {
  const { index } = useLeash()
  const navigate = useNavigate()

  if (agents.length === 0) {
    return <EmptyState title="Nothing here" body={emptyBody} />
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse">
        <thead>
          <tr className="border-b border-line text-left">
            {['Agent', 'Parent', 'Authority', 'Spent', 'Usage', 'Status', ''].map((head, i) => (
              <th
                key={head || i}
                className={cx(
                  'pb-2 pr-4 text-[12px] font-normal text-faint',
                  i > 1 && i < 5 && 'text-right',
                  i === 6 && 'w-10 pr-0',
                )}
              >
                {head}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agents.map((agent) => {
            const stats = statsFor(index, agent.id)
            const status = deriveStatus(agent, index)
            const parent = agent.parentId ? index[agent.parentId] : undefined
            const dead = status === 'revoked' || status === 'expired'

            return (
              <tr
                key={agent.id}
                className="group border-b border-hairline last:border-0 hover:bg-white/[0.02]"
              >
                <td className="py-2.5 pr-4">
                  <Link to={`/agents/${agent.id}`} className="block min-w-0">
                    <span
                      className={cx(
                        'block truncate text-[13px] font-medium',
                        dead ? 'text-muted' : 'text-ink group-hover:text-authority',
                      )}
                      style={{ paddingLeft: depthOf(index, agent) * 14 }}
                    >
                      {agent.name}
                    </span>
                  </Link>
                </td>
                <td className="py-2.5 pr-4 text-[12.5px] text-muted">
                  {parent ? (
                    <Link to={`/agents/${parent.id}`} className="hover:text-ink">
                      {parent.name}
                    </Link>
                  ) : (
                    <span className="text-faint">Account owner</span>
                  )}
                </td>
                <td className="numeric py-2.5 pr-4 text-right text-[13px] text-ink">
                  {money(agent.authority)}
                </td>
                <td className="numeric py-2.5 pr-4 text-right text-[13px] text-ink-dim">
                  {money(stats.spent)}
                </td>
                <td className="py-2.5 pr-4">
                  <div className="ml-auto flex w-[140px] items-center gap-2.5">
                    <AuthorityMeter
                      authority={agent.authority}
                      spent={stats.spent}
                      reserved={stats.reserved}
                      size="xs"
                      muted={dead}
                    />
                    <span
                      className={cx(
                        'numeric w-12 shrink-0 text-right text-[12px]',
                        stats.utilization >= 0.8 ? 'text-warn' : 'text-muted',
                      )}
                    >
                      {percent(stats.utilization)}
                    </span>
                  </div>
                </td>
                <td className="py-2.5 pr-4">
                  <StatusBadge status={status} size="sm" />
                </td>
                <td className="py-2.5">
                  <Menu
                    label={`Actions for ${agent.name}`}
                    items={[
                      { label: 'View agent', onSelect: () => navigate(`/agents/${agent.id}`) },
                      {
                        label: 'View activity',
                        onSelect: () => navigate(`/activity?agent=${agent.id}`),
                      },
                      { label: 'Edit policy', onSelect: () => navigate('/policies') },
                      {
                        label: 'Create child',
                        onSelect: () => onCreateChild(agent),
                        disabled: dead || stats.available <= 0,
                      },
                      {
                        label: 'Revoke',
                        onSelect: () => onRevoke(agent),
                        danger: true,
                        disabled: status === 'revoked',
                      },
                    ]}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function depthOf(index: Record<string, Agent>, agent: Agent): number {
  let depth = 0
  let current = agent.parentId
  while (current) {
    depth += 1
    current = index[current]?.parentId
  }
  return depth
}
