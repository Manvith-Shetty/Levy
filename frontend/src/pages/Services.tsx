import { useLeash } from '../lib/store'
import { startOfDay } from '../lib/utils'
import { money } from '../lib/utils'
import { PageHeader } from '../components/layout/PageHeader'
import { Card } from '../components/common/Card'
import { Button } from '../components/common/Button'
import { useToast } from '../app/toast'

export function Services() {
  const { services, events, live } = useLeash()
  const { push } = useToast()
  const monthStart = startOfDay(new Date()) - 29 * 86_400_000

  return (
    <>
      <PageHeader
        title="Services"
        subtitle={
          live.active
            ? 'What agents buy from, and the networks that record it.'
            : 'Infrastructure services available to agents.'
        }
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {services.map((service) => {
          const payments = events.filter(
            (e) =>
              e.kind === 'payment.approved' &&
              e.service === service.name &&
              new Date(e.timestamp).getTime() >= monthStart,
          )
          const counted = payments.filter((e) => e.counted !== false)
          const spend = Math.round(counted.reduce((sum, e) => sum + (e.amount ?? 0), 0) * 1e6) / 1e6
          const users = new Set(payments.map((e) => e.agentId))
          const sellsToAgents = service.category === 'Inference' || !live.active
          return (
            <Card key={service.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-[14.5px] font-semibold text-ink">{service.name}</h2>
                  {live.active && <p className="mt-0.5 text-[12px] text-faint">{service.category}</p>}
                </div>
                <span
                  className={`flex shrink-0 items-center gap-1.5 text-[12px] ${service.connected ? 'text-authority' : 'text-warn'}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${service.connected ? 'bg-authority' : 'bg-warn'}`} />
                  {service.connected ? 'Connected' : 'Unreachable'}
                </span>
              </div>

              {sellsToAgents && (
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
              )}

              {service.details && service.details.length > 0 && (
                <dl className="mt-4 space-y-1.5 border-t border-hairline pt-4">
                  {service.details.map((d) => (
                    <div key={d.label} className="flex items-baseline justify-between gap-4 text-[12.5px]">
                      <dt className="text-muted">{d.label}</dt>
                      <dd className="numeric truncate text-ink">
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
              )}

              {!service.details && !live.active && (
              <div className="mt-auto pt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    push({
                      tone: 'info',
                      title: `${service.name} is simulated`,
                      body: 'Connect real credentials once the gateway is wired to this console.',
                    })
                  }
                >
                  Manage
                </Button>
              </div>
              )}
              {live.active && !service.connected && service.category === 'Inference' && (
                <p className="mt-3 text-[12px] text-faint">{service.endpoint}</p>
              )}
            </Card>
          )
        })}
      </div>
    </>
  )
}
