import { useLeash } from '../lib/store'
import { startOfDay } from '../lib/utils'
import { money } from '../lib/utils'
import { PageHeader } from '../components/layout/PageHeader'
import { Card } from '../components/common/Card'
import { Button } from '../components/common/Button'
import { useToast } from '../app/toast'

export function Services() {
  const { services, events } = useLeash()
  const { push } = useToast()
  const monthStart = startOfDay(new Date()) - 29 * 86_400_000

  return (
    <>
      <PageHeader
        title="Services"
        subtitle="Infrastructure services available to agents."
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {services.map((service) => {
          const payments = events.filter(
            (e) =>
              e.kind === 'payment.approved' &&
              e.service === service.name &&
              new Date(e.timestamp).getTime() >= monthStart,
          )
          const spend = Math.round(payments.reduce((sum, e) => sum + (e.amount ?? 0), 0) * 100) / 100
          const users = new Set(payments.map((e) => e.agentId))
          return (
            <Card key={service.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-[14.5px] font-semibold text-ink">{service.name}</h2>
                <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-authority">
                  <span className="h-1.5 w-1.5 rounded-full bg-authority" />
                  Connected
                </span>
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
            </Card>
          )
        })}
      </div>
    </>
  )
}
