import { useMemo, useState } from 'react'
import { useLeash } from '../lib/store'
import { useUI } from '../app/ui'
import { dailySpend, portfolioTotals, rootAgents, spendByAgent } from '../lib/selectors'
import type { ActivityEvent } from '../lib/types'
import { cx, formatTime, money, moneyExact, percent } from '../lib/utils'
import { PageHeader } from '../components/layout/PageHeader'
import { config } from '../lib/config'
import { Button } from '../components/common/Button'
import { Card, CardHead } from '../components/common/Card'
import { Kpi } from '../components/common/Kpi'
import { AgentTree } from '../components/agents/AgentTree'
import { LiveActivity, LiveBadge } from '../components/activity/LiveActivity'
import { eventAmount } from '../components/activity/eventMeta'
import { SpendingChart } from '../components/spending/SpendingChart'
import { SpendingByAgent } from '../components/spending/SpendingByAgent'
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
  const points = useMemo(() => dailySpend(events, 14), [events])
  const byAgent = useMemo(() => spendByAgent(agents), [agents])
  const payments = useMemo(() => events.filter((e) => e.kind === 'payment.approved'), [events])
  const decisions = useMemo(
    () => events.filter((e) => e.kind === 'payment.approved' || e.kind === 'payment.blocked'),
    [events],
  )

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="How much authority you've delegated, what your agents are buying, and what Leash stopped."
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
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          <Kpi label="Total authority" value={money(totals.authority)} footnote={`Held by ${roots.length} root${roots.length === 1 ? '' : 's'}`} />
          <Kpi label="Delegated" value={money(totals.delegated)} footnote={`${percent(totals.authority ? totals.delegated / totals.authority : 0)} handed to agents`} />
          <Kpi label="Spent" value={moneyExact(totals.spent)} footnote={`${percent(totals.utilization)} of authority`} />
          <Kpi label="Remaining" value={money(totals.remaining)} tone="text-authority" footnote="Still spendable" />
          <Kpi label="Active agents" value={totals.activeAgents} footnote={`${totals.delegatedAgents} delegating further`} />
          <Kpi
            label="Blocked requests"
            value={totals.blocked}
            tone="text-blocked"
            footnote={`${totals.blockedThisWeek} this week`}
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
              {!live.active
                ? 'No agents yet. Create one to start delegating authority.'
                : live.errors.ens
                  ? `Couldn't read the agent tree from Sepolia: ${live.errors.ens}`
                  : 'No agents found under the configured top registry. Check VITE_ENS_TOP_REGISTRY and VITE_ENS_FROM_BLOCK.'}
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

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-2">
        <Card padded={false}>
          <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
            <h2 className="text-[13px] font-semibold tracking-normal text-ink">Recent payments</h2>
            {live.active && <LiveBadge />}
          </div>
          <div className="px-3 py-2">
            {payments.length === 0 ? (
              <p className="copy px-2 py-6 text-[13px] text-muted">
                No payments yet. {live.active ? 'Run a paid request to make the first one.' : ''}
              </p>
            ) : (
              <LiveActivity events={payments} onSelect={ui.openEvent} limit={6} columns={false} />
            )}
          </div>
        </Card>
        <Card padded={false}>
          <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
            <h2 className="text-[13px] font-semibold tracking-normal text-ink">Policy decisions</h2>
            <span className="text-[11.5px] text-faint">Every payment is checked first</span>
          </div>
          <div className="px-3 py-2">
            {decisions.length === 0 ? (
              <p className="copy px-2 py-6 text-[13px] text-muted">No payment has been attempted yet.</p>
            ) : (
              <DecisionList events={decisions.slice(0, 6)} onSelect={ui.openEvent} />
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHead title="Spend over time" />
          <div className="mt-5">
            <SpendingChart points={points} height={220} />
          </div>
        </Card>
        <Card>
          <CardHead title="Spending by agent" hint="Each agent's total includes everything under it." />
          <div className="mt-5">
            <SpendingByAgent rows={byAgent} total={totals.spent} />
          </div>
        </Card>
      </div>
    </>
  )
}

/** Approved and denied payments, each with the rule that decided it. */
function DecisionList({ events, onSelect }: { events: ActivityEvent[]; onSelect: (e: ActivityEvent) => void }) {
  return (
    <ul>
      {events.map((event) => {
        const approved = event.kind === 'payment.approved'
        return (
          <li key={event.id}>
            <button
              type="button"
              onClick={() => onSelect(event)}
              className="wash press flex w-full items-start gap-3 rounded-md px-2 py-2 text-left focus-visible:outline-2 focus-visible:outline-authority/60"
            >
              <span className="numeric w-10 shrink-0 pt-px text-[12px] text-faint">{formatTime(event.timestamp)}</span>
              <span
                className={cx(
                  'shrink-0 rounded px-1.5 py-px text-[11px] font-medium',
                  approved ? 'bg-authority/12 text-authority' : 'bg-blocked/12 text-blocked',
                )}
              >
                {approved ? 'Approved' : 'Denied'}
              </span>
              <span className="min-w-0 flex-1 text-[13px]">
                <span className="text-ink">{event.agentId}</span>
                <span className="text-muted">
                  {' '}
                  · {eventAmount(event)}
                  {event.service ? ` · ${event.service}` : ''}
                </span>
                {!approved && event.reason && (
                  <span className="mt-0.5 block truncate text-[12px] text-blocked/90">
                    {event.reason}
                    {event.blockedBy && event.blockedBy !== event.agentId ? ` (${event.blockedBy})` : ''}
                  </span>
                )}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
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
