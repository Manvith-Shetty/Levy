import { useMemo, useState } from 'react'
import { useLeash } from '../lib/store'
import { useUI } from '../app/ui'
import { portfolioTotals, rootAgents } from '../lib/selectors'
import { money, moneyExact, percent } from '../lib/utils'
import { PageHeader } from '../components/layout/PageHeader'
import { config } from '../lib/config'
import { Button } from '../components/common/Button'
import { Card } from '../components/common/Card'
import { Kpi } from '../components/common/Kpi'
import { AgentTree } from '../components/agents/AgentTree'
import { LiveActivity, LiveBadge } from '../components/activity/LiveActivity'
import { IconPlus } from '../components/layout/icons'
import { Skeleton, SkeletonKpis } from '../components/common/Skeleton'
import { LiveNotice } from '../components/layout/LiveNotice'
import { useBootDelay } from '../hooks/useBootDelay'

export function Overview() {
  const { agents, events, live } = useLeash()
  const ui = useUI()
  const booted = useBootDelay()
  const ready = booted && (!live.active || live.ready)
  const [selected, setSelected] = useState<string | undefined>()

  const totals = useMemo(() => portfolioTotals(agents, events), [agents, events])
  const roots = rootAgents(agents)

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Monitor your agent spending authority and infrastructure activity."
        action={
          <div className="flex flex-wrap gap-2">
            {live.active && config.runnerEnabled && (
              <Button onClick={() => ui.openRun()}>Run a paid request</Button>
            )}
            <Button variant="primary" onClick={() => ui.openCreate()}>
              <IconPlus className="h-3.5 w-3.5" />
              Create Agent
            </Button>
          </div>
        }
      />

      <LiveNotice />

      {!ready ? (
        <SkeletonKpis />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Kpi
            label="Total authority"
            value={money(totals.authority)}
            footnote={`Across ${agents.length} agents`}
          />
          <Kpi
            label="Total spent"
            value={moneyExact(totals.spent)}
            footnote={`${percent(totals.utilization)} of authority`}
          />
          <Kpi
            label="Active agents"
            value={totals.activeAgents}
            footnote={`${totals.delegatedAgents} delegated`}
          />
          <Kpi
            label="Blocked requests"
            value={totals.blocked}
            tone="text-blocked"
            footnote={`↑ ${totals.blockedThisWeek} this week`}
          />
        </div>
      )}

      <Card padded={false} className="mt-6 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 pt-5">
          <h2 className="text-[15px] font-semibold text-ink">Agent authority tree</h2>
          <Legend />
        </div>
        <div className="px-2 pt-2 pb-5">
          {!ready && (
            <div className="flex flex-col items-center gap-10 py-6">
              <Skeleton className="h-[112px] w-[192px] rounded-lg" />
              <div className="flex gap-6">
                <Skeleton className="h-[112px] w-[192px] rounded-lg" />
                <Skeleton className="h-[112px] w-[192px] rounded-lg" />
              </div>
            </div>
          )}
          {ready && roots.length === 0 && (
            <p className="copy px-3 py-12 text-center text-[13px] text-muted">
              {live.active
                ? 'No agents found under the configured top registry. Check VITE_ENS_TOP_REGISTRY and VITE_ENS_FROM_BLOCK.'
                : 'No agents yet. Create one to start delegating authority.'}
            </p>
          )}
          {ready && roots.map((root) => (
            <AgentTree
              key={root.id}
              rootId={root.id}
              selectedId={selected}
              onSelect={(agent) => {
                setSelected(agent.id)
                ui.openAgent(agent)
              }}
            />
          ))}
        </div>
      </Card>

      <Card padded={false} className="mt-4">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <h2 className="text-[13px] font-semibold tracking-normal text-ink">Live activity</h2>
          <LiveBadge />
        </div>
        <div className="px-3 py-2">
          <LiveActivity events={events} onSelect={ui.openEvent} />
        </div>
      </Card>
    </>
  )
}

function Legend() {
  const items = [
    { label: 'Spent', className: 'bg-authority' },
    { label: 'Delegated', className: 'bg-delegated/70' },
    { label: 'Free', className: 'bg-[#2b2f37]' },
  ]
  return (
    <ul className="flex items-center gap-3.5">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <span className={`inline-block h-2 w-2 rounded-sm ${item.className}`} />
          {item.label}
        </li>
      ))}
    </ul>
  )
}
