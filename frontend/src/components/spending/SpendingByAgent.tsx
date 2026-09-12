import { Link } from 'react-router-dom'
import type { AgentSpend } from '../../lib/selectors'
import { money, percent } from '../../lib/utils'
import { EmptyState } from '../common/EmptyState'

export function SpendingByAgent({ rows, total }: { rows: AgentSpend[]; total: number }) {
  if (rows.length === 0) {
    return <EmptyState title="No spend yet" body="Once agents start paying for services, their share appears here." />
  }

  return (
    <ul className="space-y-3">
      {rows.map(({ agent, spent, share }) => (
        <li key={agent.id}>
          <Link to={`/agents/${agent.id}`} className="group block">
            <div className="flex items-baseline justify-between gap-4">
              <span className="truncate text-[13px] text-ink-dim group-hover:text-ink">
                {agent.name}
              </span>
              <span className="numeric shrink-0 text-[13px] text-ink">{money(spent)}</span>
            </div>
            <div className="mt-1.5 flex items-center gap-3">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#191c22]">
                <div
                  className="h-full w-full origin-left rounded-full bg-[linear-gradient(90deg,#1f8f75,#35e0ae)] transition-transform duration-500 ease-[var(--ease-out-soft)]"
                  style={{ transform: `scaleX(${share})` }}
                />
              </div>
              <span className="numeric w-10 shrink-0 text-right text-[11.5px] text-faint">
                {percent(total > 0 ? spent / total : 0, 0)}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  )
}
