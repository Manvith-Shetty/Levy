import { Link } from 'react-router-dom'
import { useLeash } from '../lib/store'
import { useUI } from '../app/ui'
import type { Service } from '../lib/types'
import { cx, money, startOfDay, timeAgo } from '../lib/utils'
import { config } from '../lib/config'
import { PageHeader } from '../components/layout/PageHeader'
import { Card } from '../components/common/Card'
import { Button } from '../components/common/Button'
import { EmptyState } from '../components/common/EmptyState'
import { useToast } from '../app/toast'

export function Services() {
  const { services, live } = useLeash()

  if (!live.active) return <DemoServices />

  const groups = new Map<string, Service[]>()
  for (const service of services) {
    const key = service.category
    groups.set(key, [...(groups.get(key) ?? []), service])
  }

  return (
    <>
      <PageHeader
        title="Services"
        subtitle="Paid services your agents can discover and buy per call, with no API key or subscription. Each one is checked against the agent's policy before it's paid."
      />

      {services.length === 0 && (
        <Card>
          <EmptyState
            title="No services discovered yet"
            body="Providers register by announcing themselves on the HCS topic when they start. Start a gateway, or the agent runner, and they appear here."
          />
        </Card>
      )}

      <div className="space-y-8">
        {[...groups.entries()]
          .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
          .map(([category, list]) => (
          <section key={category}>
            <h2 className="mb-3 flex items-baseline gap-2 text-[15px] font-semibold text-ink">
              {category}
              <span className="text-[12.5px] font-normal text-faint">
                {list.length} provider{list.length === 1 ? '' : 's'}
              </span>
            </h2>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((service) => (
                <ServiceCard key={service.id} service={service} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  )
}

/** What agents buy most comes first. */
function rank(category: string): number {
  const order = ['Inference', 'Data', 'Compute']
  const i = order.indexOf(category)
  return i === -1 ? order.length : i
}

function ServiceCard({ service }: { service: Service }) {
  const { events } = useLeash()
  const ui = useUI()
  const listing = service.listing!
  const monthStart = startOfDay(new Date()) - 29 * 86_400_000
  const purchases = events.filter(
    (e) => e.kind === 'payment.approved' && e.service === service.name && new Date(e.timestamp).getTime() >= monthStart,
  )
  const denied = events.filter((e) => e.kind === 'payment.blocked' && e.service === service.name)
  const spend = Math.round(purchases.filter((e) => e.counted !== false).reduce((s, e) => s + (e.amount ?? 0), 0) * 1e6) / 1e6

  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14.5px] font-semibold text-ink">{service.name}</h3>
          <p className="mt-0.5 font-mono text-[12px] text-faint">{listing.model}</p>
        </div>
        <span
          className={cx(
            'flex shrink-0 items-center gap-1.5 text-[12px]',
            service.connected ? 'text-authority' : 'text-warn',
          )}
        >
          <span className={cx('h-1.5 w-1.5 rounded-full', service.connected ? 'bg-authority' : 'bg-warn')} />
          {service.connected ? 'Available' : 'Unreachable'}
        </span>
      </div>

      {listing.description && <p className="copy mt-2 text-[13px] text-ink-dim">{listing.description}</p>}

      <ul className="mt-3 space-y-0.5">
        {listing.pricing.map((line) => (
          <li key={line} className="numeric text-[12.5px] text-ink">
            {line}
          </li>
        ))}
      </ul>

      <ul className="mt-3 flex flex-wrap gap-1.5">
        {['x402', listing.asset, listing.network].map((tag) => (
          <li key={tag} className="rounded border border-line px-1.5 py-px text-[11px] text-muted">
            {tag}
          </li>
        ))}
        {listing.registeredVia === 'hcs' && (
          <li
            className="rounded border border-authority/30 px-1.5 py-px text-[11px] text-authority"
            title={listing.announcedAt ? `Announced ${timeAgo(listing.announcedAt)}` : undefined}
          >
            Registered on HCS
          </li>
        )}
      </ul>

      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-hairline pt-4">
        <div>
          <dt className="text-[11.5px] text-faint">Purchases</dt>
          <dd className="numeric mt-1 text-[17px] font-semibold text-ink">{purchases.length}</dd>
        </div>
        <div>
          <dt className="text-[11.5px] text-faint">Spend, 30 days</dt>
          <dd className="numeric mt-1 text-[17px] font-semibold text-ink">{money(spend)}</dd>
        </div>
        <div>
          <dt className="text-[11.5px] text-faint">Denied</dt>
          <dd className={cx('numeric mt-1 text-[17px] font-semibold', denied.length ? 'text-blocked' : 'text-ink')}>
            {denied.length}
          </dd>
        </div>
      </dl>

      <div className="mt-4 border-t border-hairline pt-4">
        <p className="text-[11.5px] text-faint">Agents allowed to buy this</p>
        {listing.authorizedAgents.length > 0 ? (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {listing.authorizedAgents.map((name) => (
              <li key={name}>
                <Link
                  to={`/agents/${name}`}
                  className="press inline-block rounded bg-raised px-1.5 py-0.5 font-mono text-[11.5px] text-ink-dim hover:text-ink focus-visible:outline-2 focus-visible:outline-authority/60"
                >
                  {name}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-[12.5px] text-muted">
            No agent's policy allows {listing.kind}. Leash refuses every attempt before payment.
          </p>
        )}
      </div>

      <details className="group mt-4 border-t border-hairline pt-3">
        <summary className="press cursor-pointer list-none text-[12px] text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-authority/60">
          <span className="inline-block transition-transform duration-200 group-open:rotate-90">›</span> Technical details
        </summary>
        <dl className="mt-2 space-y-1.5">
          {(service.details ?? []).map((d) => (
            <div key={d.label} className="flex items-baseline justify-between gap-4 text-[12px]">
              <dt className="text-faint">{d.label}</dt>
              <dd className="numeric truncate text-ink-dim">
                {d.href ? (
                  <a href={d.href} target="_blank" rel="noreferrer" className="hover:text-authority active:opacity-70">
                    {d.value}
                  </a>
                ) : (
                  d.value
                )}
              </dd>
            </div>
          ))}
        </dl>
      </details>

      {config.runnerEnabled && listing.authorizedAgents.length > 0 && service.connected && (
        <div className="mt-auto pt-4">
          <Button size="sm" onClick={() => ui.openRun(listing.authorizedAgents.at(-1))}>
            Buy with an agent
          </Button>
        </div>
      )}
    </Card>
  )
}

/** Demo mode's simulated catalogue. */
function DemoServices() {
  const { services, events } = useLeash()
  const { push } = useToast()
  const monthStart = startOfDay(new Date()) - 29 * 86_400_000
  return (
    <>
      <PageHeader title="Services" subtitle="Simulated services for the demo. Nothing here is paid for real." />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {services.map((service) => {
          const payments = events.filter(
            (e) =>
              e.kind === 'payment.approved' &&
              e.service === service.name &&
              new Date(e.timestamp).getTime() >= monthStart,
          )
          const spend = Math.round(payments.reduce((sum, e) => sum + (e.amount ?? 0), 0) * 1e6) / 1e6
          const users = new Set(payments.map((e) => e.agentId))
          return (
            <Card key={service.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-[14.5px] font-semibold text-ink">{service.name}</h2>
                <span className="text-[12px] text-faint">{service.category}</span>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 border-t border-hairline pt-4">
                <div>
                  <dt className="text-[11.5px] text-faint">Agents using service</dt>
                  <dd className="numeric mt-1 text-[19px] font-semibold text-ink">{users.size}</dd>
                </div>
                <div>
                  <dt className="text-[11.5px] text-faint">Spend this month</dt>
                  <dd className="numeric mt-1 text-[19px] font-semibold text-ink">{money(spend)}</dd>
                </div>
              </dl>
              <div className="mt-auto pt-4">
                <Button
                  size="sm"
                  onClick={() =>
                    push({ tone: 'info', title: `${service.name} is simulated`, body: 'Switch off Demo Mode to see real providers.' })
                  }
                >
                  Manage
                </Button>
              </div>
            </Card>
          )
        })}
      </div>
    </>
  )
}
