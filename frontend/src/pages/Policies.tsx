import { useLeash } from '../lib/store'
import { money, resourceLabel } from '../lib/utils'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/common/Button'
import { Card } from '../components/common/Card'
import { Pill } from '../components/common/Badge'
import { IconPlus } from '../components/layout/icons'
import { useToast } from '../app/toast'

export function Policies() {
  const { policies, agents } = useLeash()
  const { push } = useToast()

  return (
    <>
      <PageHeader
        title="Policies"
        subtitle="Define what agents can and cannot spend on."
        action={
          <Button
            variant="primary"
            onClick={() =>
              push({
                tone: 'info',
                title: 'Policy editor is next',
                body: 'Policies are read-only in this build. Limits can still be tightened per agent when you create one.',
              })
            }
          >
            <IconPlus className="h-3.5 w-3.5" />
            Create Policy
          </Button>
        }
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {policies.map((policy) => {
          const users = agents.filter((a) => a.policyId === policy.id)
          return (
            <Card key={policy.id} className="flex flex-col">
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-[14.5px] font-semibold text-ink">{policy.name}</h2>
                <Pill tone={policy.active ? 'authority' : 'neutral'}>
                  {policy.active ? 'Active' : 'Inactive'}
                </Pill>
              </div>

              <dl className="mt-4 space-y-2 border-t border-hairline pt-4">
                <Line label="Max transaction" value={money(policy.maxTransaction)} />
                <Line label="Daily limit" value={money(policy.dailyLimit)} />
                <Line label="Monthly limit" value={money(policy.monthlyLimit)} />
              </dl>

              <div className="mt-4">
                <p className="mb-2 text-[12px] text-faint">Allowed services</p>
                <div className="flex flex-wrap gap-1.5">
                  {policy.services.map((service) => (
                    <Pill key={service}>{resourceLabel(service)}</Pill>
                  ))}
                </div>
              </div>

              <footer className="mt-auto flex items-center justify-between gap-3 border-t border-hairline pt-4 text-[12.5px]">
                <span className="text-muted">
                  {users.length === 0
                    ? 'No agents using this policy'
                    : `${users.length} agent${users.length > 1 ? 's' : ''} using this policy`}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    push({
                      tone: 'info',
                      title: 'Policy editor is next',
                      body: `${policy.name} is read-only in this build.`,
                    })
                  }
                  className="press text-muted hover:text-authority"
                >
                  Edit →
                </button>
              </footer>
            </Card>
          )
        })}
      </div>
    </>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-[12.5px] text-muted">{label}</dt>
      <dd className="numeric text-[13px] text-ink">{value}</dd>
    </div>
  )
}
