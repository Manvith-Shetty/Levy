import { useMemo, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useLeash } from '../lib/store'
import { useUI } from '../app/ui'
import {
  dailySpend,
  deriveStatus,
  eventsForAgent,
  spentSince,
  spentToday,
  statsFor,
} from '../lib/selectors'
import type { Agent } from '../lib/types'
import {
  formatDate,
  money,
  percent,
  RESOURCES,
  startOfDay,
  STATUS_LABEL,
  timeUntil,
} from '../lib/utils'
import { Button, ButtonLink } from '../components/common/Button'
import { Card, CardHead } from '../components/common/Card'
import { StatusBadge } from '../components/common/Badge'
import { AuthorityMeter, LimitBar, MeterLegend } from '../components/common/Meter'
import { Tabs } from '../components/common/Tabs'
import { EmptyState } from '../components/common/EmptyState'
import { SpendingChart } from '../components/spending/SpendingChart'
import { ActivityFeed } from '../components/activity/ActivityFeed'
import { IconArrowLeft, IconPlus } from '../components/layout/icons'

type Tab = 'overview' | 'spending' | 'permissions' | 'children' | 'activity'

export function AgentDetail() {
  const { id = '' } = useParams()
  const { index, events } = useLeash()
  const ui = useUI()
  const [tab, setTab] = useState<Tab>('overview')

  const agent = index[id]
  const agentEvents = useMemo(
    () => (agent ? eventsForAgent(events, agent.id) : []),
    [events, agent],
  )

  if (!agent) {
    return (
      <EmptyState
        title="Agent not found"
        body="This agent doesn't exist in the current hierarchy."
        action={<ButtonLink to="/agents">Back to agents</ButtonLink>}
        className="mt-20"
      />
    )
  }

  const stats = statsFor(index, agent.id)
  const status = deriveStatus(agent, index)
  const parent = agent.parentId ? index[agent.parentId] : undefined

  const tabs = [
    { id: 'overview' as const, label: 'Overview' },
    { id: 'spending' as const, label: 'Spending' },
    { id: 'permissions' as const, label: 'Permissions' },
    { id: 'children' as const, label: 'Children', count: agent.children.length },
    { id: 'activity' as const, label: 'Activity', count: agentEvents.length },
  ]

  return (
    <>
      <Link
        to="/agents"
        className="press mb-4 inline-flex items-center gap-1.5 text-[12.5px] text-faint hover:text-ink"
      >
        <IconArrowLeft className="h-3.5 w-3.5" />
        Agents
      </Link>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-[26px] leading-tight font-semibold text-ink">{agent.name}</h1>
          <div className="mt-2">
            <StatusBadge status={status} />
          </div>
        </div>
        <Button variant="danger" disabled={status === 'revoked'} onClick={() => ui.openRevoke(agent)}>
          Revoke agent
        </Button>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card>
          <p className="text-[12.5px] text-muted">Authority</p>
          <p className="numeric mt-1.5 text-[44px] leading-none font-semibold text-ink">
            {money(agent.authority)}
          </p>
          <div className="mt-5 flex items-center gap-4">
            <AuthorityMeter
              authority={agent.authority}
              spent={stats.spent}
              reserved={stats.reserved}
              size="lg"
              muted={status === 'revoked'}
            />
            <span className="numeric shrink-0 text-[15px] font-medium text-ink">
              {percent(stats.utilization)}
            </span>
          </div>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-8 gap-y-1">
            <p className="numeric text-[15px] text-ink">
              {money(stats.spent)} <span className="text-muted">spent</span>
            </p>
            <p className="numeric text-[15px] text-authority">
              {money(stats.remaining)} <span className="text-muted">remaining</span>
            </p>
          </div>
          {stats.delegated > 0 && (
            <MeterLegend
              spent={stats.spent}
              reserved={stats.reserved}
              free={stats.available}
              className="mt-4 border-t border-hairline pt-4"
            />
          )}
        </Card>

        <Card>
          <dl className="space-y-3">
            <Meta label="Parent agent">
              {parent ? (
                <Link to={`/agents/${parent.id}`} className="underline-offset-4 hover:underline active:opacity-70">
                  {parent.name}
                </Link>
              ) : (
                'Account owner'
              )}
            </Meta>
            <Meta label="Created">{formatDate(agent.createdAt)}</Meta>
            <Meta label="Expires">{agent.expiresAt ? formatDate(agent.expiresAt) : 'Never'}</Meta>
            <Meta label="Children">{agent.children.length}</Meta>
            <Meta label="Status">{STATUS_LABEL[status]}</Meta>
          </dl>
        </Card>
      </div>

      <div className="mt-7">
        <Tabs tabs={tabs} active={tab} onChange={setTab} />
        <div className="pt-5">
          {tab === 'overview' && <OverviewTab agent={agent} />}
          {tab === 'spending' && <SpendingTab agentId={agent.id} />}
          {tab === 'permissions' && <PermissionsTab agentId={agent.id} />}
          {tab === 'children' && <ChildrenTab agentId={agent.id} />}
          {tab === 'activity' && (
            <Card padded={false}>
              <div className="px-3 py-2">
                <ActivityFeed events={agentEvents} onSelect={ui.openEvent} />
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[12.5px] text-muted">{label}</dt>
      <dd className="truncate text-[13px] text-ink">{children}</dd>
    </div>
  )
}

function Tile({ label, children, foot }: { label: string; children: ReactNode; foot?: ReactNode }) {
  return (
    <Card>
      <p className="text-[12.5px] text-muted">{label}</p>
      <div className="mt-2">{children}</div>
      {foot && <div className="mt-3">{foot}</div>}
    </Card>
  )
}

/** Spec §13: budget, utilization, expiration, parent, child count, status. */
function OverviewTab({ agent }: { agent: Agent }) {
  const { index } = useLeash()
  const stats = statsFor(index, agent.id)
  const status = deriveStatus(agent, index)
  const parent = agent.parentId ? index[agent.parentId] : undefined
  const expiry = timeUntil(agent.expiresAt)

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <Tile label="Budget">
        <p className="numeric text-[24px] leading-none font-semibold text-ink">{money(agent.authority)}</p>
      </Tile>
      <Tile
        label="Utilization"
        foot={<LimitBar used={stats.spent} limit={agent.authority} />}
      >
        <p className="numeric text-[24px] leading-none font-semibold text-ink">
          {percent(stats.utilization)}
        </p>
      </Tile>
      <Tile label="Expiration">
        <p className="numeric text-[24px] leading-none font-semibold text-ink">
          {agent.expiresAt ? formatDate(agent.expiresAt) : 'Never'}
        </p>
        {agent.expiresAt && (
          <p className={`mt-2 text-[12.5px] ${expiry.soon ? 'text-warn' : 'text-muted'}`}>{expiry.label}</p>
        )}
      </Tile>
      <Tile label="Parent">
        <p className="text-[17px] font-medium text-ink">{parent?.name ?? 'Account owner'}</p>
      </Tile>
      <Tile label="Child agents">
        <p className="numeric text-[24px] leading-none font-semibold text-ink">{agent.children.length}</p>
      </Tile>
      <Tile label="Status">
        <StatusBadge status={status} />
      </Tile>
    </div>
  )
}

function SpendingTab({ agentId }: { agentId: string }) {
  const { events } = useLeash()
  const trend = useMemo(() => dailySpend(events, 14, agentId), [events, agentId])
  const today = spentToday(events, agentId)
  const week = spentSince(events, agentId, startOfDay(new Date()) - 6 * 86_400_000)
  const month = spentSince(events, agentId, startOfDay(new Date()) - 29 * 86_400_000)

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
      <Card>
        <CardHead title="Spending" />
        <p className="numeric mt-1 text-[26px] leading-none font-semibold text-ink">{money(month)}</p>
        <div className="mt-5">
          <SpendingChart points={trend} height={220} />
        </div>
      </Card>
      <Card>
        <dl className="space-y-4">
          {(
            [
              ['Today', today],
              ['This week', week],
              ['This month', month],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4">
              <dt className="text-[13px] text-muted">{label}</dt>
              <dd className="numeric text-[17px] font-semibold text-ink">{money(value)}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  )
}

function PermissionsTab({ agentId }: { agentId: string }) {
  const { index, policies } = useLeash()
  const agent = index[agentId]
  const policy = policies.find((p) => p.id === agent?.policyId)
  if (!agent) return null
  const limits = agent.permissions.find((p) => p.allowed)?.limits

  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <Card>
        <CardHead title="Resource access" />
        <ul className="mt-3 divide-y divide-hairline">
          {RESOURCES.map((resource) => {
            const allowed = agent.permissions.find((p) => p.resource === resource.id)?.allowed ?? false
            return (
              <li key={resource.id} className="flex items-center justify-between gap-4 py-2.5">
                <span className="text-[13px] text-ink">{resource.label}</span>
                <span className={`text-[12.5px] ${allowed ? 'text-authority' : 'text-faint'}`}>
                  {allowed ? '✓ Allowed' : '✕ Denied'}
                </span>
              </li>
            )
          })}
        </ul>
      </Card>

      <Card>
        <CardHead title="Limits" />
        <dl className="mt-3 divide-y divide-hairline">
          {(
            [
              ['Maximum transaction', money(limits?.transaction ?? 0)],
              ['Daily spending', money(limits?.daily ?? 0)],
              ['Monthly spending', money(limits?.monthly ?? 0)],
              ['Allowed providers', policy?.providers.join(', ') ?? '—'],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-4 py-2.5">
              <dt className="text-[13px] text-muted">{label}</dt>
              <dd className="numeric text-[13px] text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  )
}

function ChildrenTab({ agentId }: { agentId: string }) {
  const { index } = useLeash()
  const ui = useUI()
  const agent = index[agentId]
  if (!agent) return null

  const stats = statsFor(index, agent.id)
  const children = agent.children.map((id) => index[id]).filter(Boolean)
  const canDelegate = stats.available > 0 && agent.status !== 'revoked'

  return (
    <div className="space-y-4">
      <Card>
        <CardHead
          title="Delegation"
          action={
            <Button variant="primary" size="sm" disabled={!canDelegate} onClick={() => ui.openCreate(agent.id)}>
              <IconPlus className="h-3.5 w-3.5" />
              Create child
            </Button>
          }
        />
        <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full bg-[#191c22]">
          <div className="bg-authority" style={{ width: `${(agent.spent / agent.authority) * 100}%` }} />
          <div
            className="bg-delegated/55"
            style={{
              width: `${(stats.delegated / agent.authority) * 100}%`,
              backgroundImage:
                'repeating-linear-gradient(115deg, rgba(122,107,255,0.95) 0 3px, rgba(122,107,255,0.42) 3px 6px)',
            }}
          />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Parent authority" value={money(agent.authority)} />
          <Stat label="Spent directly" value={money(agent.spent)} />
          <Stat label="Delegated" value={money(stats.delegated)} tone="text-delegated" />
          <Stat label="Available" value={money(stats.available)} tone="text-authority" />
        </dl>
      </Card>

      {children.length === 0 ? (
        <EmptyState
          title="No child agents"
          body="This agent hasn't delegated authority yet."
          action={
            canDelegate ? (
              <Button variant="primary" size="sm" onClick={() => ui.openCreate(agent.id)}>
                <IconPlus className="h-3.5 w-3.5" />
                Create child agent
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto p-4">
            <table className="w-full min-w-[480px] border-collapse">
              <thead>
                <tr className="border-b border-line text-left">
                  {['Agent', 'Budget', 'Spent', 'Status'].map((head, i) => (
                    <th
                      key={head}
                      className={`pr-4 pb-2 text-[12px] font-normal text-faint ${i === 1 || i === 2 ? 'text-right' : ''}`}
                    >
                      {head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {children.map((child) => (
                  <tr key={child.id} className="border-b border-hairline last:border-0 hover:bg-white/[0.02]">
                    <td className="py-2.5 pr-4">
                      <Link to={`/agents/${child.id}`} className="text-[13px] text-ink hover:text-authority active:opacity-70">
                        {child.name}
                      </Link>
                    </td>
                    <td className="numeric py-2.5 pr-4 text-right text-[13px] text-ink">
                      {money(child.authority)}
                    </td>
                    <td className="numeric py-2.5 pr-4 text-right text-[13px] text-ink-dim">
                      {money(statsFor(index, child.id).spent)}
                    </td>
                    <td className="py-2.5">
                      <StatusBadge status={deriveStatus(child, index)} size="sm" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}

function Stat({ label, value, tone = 'text-ink' }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-[12px] text-faint">{label}</dt>
      <dd className={`numeric mt-0.5 text-[17px] font-semibold ${tone}`}>{value}</dd>
    </div>
  )
}
