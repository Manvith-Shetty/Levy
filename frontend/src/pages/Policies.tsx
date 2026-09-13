import { Link } from 'react-router-dom'
import { useLeash } from '../lib/store'
import type { Policy } from '../lib/types'
import { money, resourceLabel } from '../lib/utils'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/common/Button'
import { Card } from '../components/common/Card'
import { Pill } from '../components/common/Badge'
import { IconPlus } from '../components/layout/icons'
import { useToast } from '../app/toast'
import { etherscanUrl } from '../lib/config'
import { PolicySimulator } from '../components/policy/PolicySimulator'

export function Policies() {
  const { policies, agents, live } = useLeash()
  const { push } = useToast()

  if (live.active) {
    return (
      <>
        <PageHeader
          title="Policies"
          subtitle="Each agent's rules live in its ENS text records, read live from Sepolia. Leash's policy engine checks every one, up the whole chain, before any payment."
        />
        <PolicySimulator />
        <h2 className="mt-8 mb-3 text-[15px] font-semibold text-ink">Agent policies</h2>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {policies.map((policy) => (
            <LivePolicyCard key={policy.id} policy={policy} />
          ))}
        </div>
        <p className="copy mt-4 max-w-[72ch] text-[12.5px] text-faint">
          Enforced on every payment, at every node up the chain: remaining authority (the node's{' '}
          <span className="font-mono">budget</span> minus everything its subtree has spent, replayed from HCS), the
          per-request limit (<span className="font-mono">maxPerCall</span>), the service category (
          <span className="font-mono">allowedServices</span>), the payment asset, and expiry or revocation.{' '}
          <span className="font-mono">ratePerMinute</span> is recorded but not enforced yet.
        </p>
      </>
    )
  }

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

function LivePolicyCard({ policy }: { policy: Policy }) {
  const records = policy.live!
  return (
    <Card className="flex flex-col">
      <div className="flex items-start justify-between gap-3">
        <Link
          to={`/agents/${policy.name}`}
          className="font-mono text-[14px] font-medium text-ink hover:text-authority active:opacity-70"
        >
          {policy.name}
        </Link>
        <Pill tone={policy.active ? 'authority' : 'neutral'}>{policy.active ? 'Active' : 'Inactive'}</Pill>
      </div>

      <dl className="mt-4 space-y-2 border-t border-hairline pt-4">
        <Line label="budget" value={money(records.budget)} mono />
        <Line label="maxPerCall" value={money(records.maxPerCall)} mono />
        <Line label="ratePerMinute" value={money(records.ratePerMinute)} mono muted />
      </dl>

      <div className="mt-4">
        <p className="mb-2 font-mono text-[12px] text-faint">allowedServices</p>
        <div className="flex flex-wrap gap-1.5">
          {records.allowedServices.length === 0 ? (
            <span className="text-[12.5px] text-faint">None set</span>
          ) : (
            records.allowedServices.map((service) => <Pill key={service}>{service}</Pill>)
          )}
        </div>
      </div>

      {records.resolver && (
        <footer className="mt-auto border-t border-hairline pt-4 text-[12.5px]">
          <a
            href={etherscanUrl('address', records.resolver)}
            target="_blank"
            rel="noreferrer"
            className="press text-muted hover:text-authority"
          >
            Resolver {records.resolver.slice(0, 6)}…{records.resolver.slice(-4)} →
          </a>
        </footer>
      )}
    </Card>
  )
}

function Line({ label, value, mono, muted }: { label: string; value: string; mono?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={`text-[12.5px] ${mono ? 'font-mono' : ''} ${muted ? 'text-faint' : 'text-muted'}`}>{label}</dt>
      <dd className="numeric text-[13px] text-ink">{value}</dd>
    </div>
  )
}
