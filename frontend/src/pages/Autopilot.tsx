import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useToast } from '../app/toast'
import { Button } from '../components/common/Button'
import { Card, CardHead } from '../components/common/Card'
import { EmptyState } from '../components/common/EmptyState'
import { PageHeader } from '../components/layout/PageHeader'
import { config, hashscanUrl } from '../lib/config'
import { authorize } from '../lib/gateway/api'
import type { PolicyDecision } from '../lib/gateway/types'
import {
  causeOutage,
  getAutopilot,
  respondNow,
  setAutopilot,
  type AutopilotState,
  type Incident,
  type IncidentStep,
  type InfraHealth,
  type OpsAction,
  type ServiceHealth,
  type Stage,
} from '../lib/live/autopilot'
import { fromAtomic, type AssetInfo } from '../lib/live/runner'
import { useLeash } from '../lib/store'
import { cx, money, timeAgo } from '../lib/utils'

const POLL_MS = config.autopilotPollMs
/** The tree's asset, until the ops provider says what it's paid in. */
const TREE_ASSET: AssetInfo = { id: config.assetTokenId, symbol: config.assetSymbol, decimals: config.assetDecimals }

/** What each service of the stack is, for people rather than Docker (VITE_STACK_SERVICE_LABELS). */
const ROLE = config.serviceLabels

type LaneState = 'waiting' | 'working' | 'done' | 'blocked' | 'failed' | 'skipped'

export function Autopilot() {
  const { push } = useToast()
  const [state, setState] = useState<AutopilotState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // When this page first saw the stack down, for the outage clock before
  // an incident opens.
  const [downSince, setDownSince] = useState<number | null>(null)

  const apply = useCallback((next: AutopilotState) => {
    setState(next)
    setError(null)
    setDownSince((prev) => (next.health?.healthy ? null : next.health ? (prev ?? Date.now()) : prev))
  }, [])

  useEffect(() => {
    if (!config.runnerEnabled) return
    let cancelled = false
    const load = () => {
      if (document.hidden) return
      getAutopilot()
        .then((next) => !cancelled && apply(next))
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    }
    load()
    const poll = setInterval(load, POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 250)
    return () => {
      cancelled = true
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [apply])

  async function act(label: string, run: () => Promise<unknown>, done?: string) {
    setBusy(label)
    try {
      await run()
      if (done) push({ tone: 'success', title: done })
      apply(await getAutopilot())
    } catch (e) {
      push({ tone: 'blocked', title: 'Not done', body: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(null)
    }
  }

  if (!config.runnerEnabled) {
    return (
      <>
        <PageHeader title="Autopilot" />
        <Card>
          <EmptyState
            title="The agent runner is off"
            body="Autopilot runs inside the agent runner. Start it with `cargo run -p agent --bin agent-runner` and set VITE_RUNNER_URL."
          />
        </Card>
      </>
    )
  }

  const incident = state?.current ?? state?.history[0] ?? null
  const asset = state?.provider?.asset ?? TREE_ASSET

  return (
    <>
      <PageHeader
        title="Autopilot"
        subtitle="Three agents keep the shop running. One watches, one pays a model to find the cause, one pays for the repair. Each can only buy what its own ENS policy allows."
        action={
          state && (
            <AutopilotSwitch
              enabled={state.enabled}
              disabled={busy === 'toggle'}
              onChange={(enabled) =>
                act('toggle', () => setAutopilot(enabled), enabled ? 'Autopilot is on' : 'Autopilot is off')
              }
            />
          )
        }
      />

      {error && !state && (
        <Card>
          <EmptyState title="Can't reach the agent runner" body={error} />
        </Card>
      )}

      {state && (
        <div className="space-y-6">
          {state.paused_reason && (
            <Notice tone="warn" title="Autopilot paused itself">
              {state.paused_reason} Turn it back on once the cause is dealt with.
            </Notice>
          )}

          <StackCard
            state={state}
            now={now}
            downSince={downSince}
            busy={busy}
            onBreak={(id, label) => act(id, () => causeOutage(id), id === 'reset' ? 'Stack reset' : `${label}: done`)}
            onRespond={() => act('respond', respondNow, 'The agents are on it')}
          />

          <Permissions state={state} incident={incident} />

          {incident ? (
            <IncidentView incident={incident} state={state} asset={asset} now={now} />
          ) : (
            <Card>
              <EmptyState
                title="No incidents yet"
                body="Break something above. The watcher notices within a few seconds; with autopilot on, the other two agents take it from there."
              />
            </Card>
          )}

          {state.history.length > 0 && <History incidents={state.history} asset={asset} />}
        </div>
      )}
    </>
  )
}

function AutopilotSwitch({
  enabled,
  disabled,
  onChange,
}: {
  enabled: boolean
  disabled: boolean
  onChange: (enabled: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={disabled}
      onClick={() => onChange(!enabled)}
      className="press flex items-center gap-2.5 rounded-md border border-line bg-raised px-3 py-2 text-[13px] text-ink focus-visible:outline-2 focus-visible:outline-authority/60 disabled:opacity-50"
    >
      <span
        aria-hidden
        className={cx(
          'relative h-4.5 w-8 rounded-full',
          enabled ? 'bg-authority' : 'bg-line-strong',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-3.5 w-3.5 rounded-full bg-canvas transition-transform duration-200',
            enabled ? 'translate-x-4' : 'translate-x-0.5',
          )}
        />
      </span>
      Autopilot {enabled ? 'on' : 'off'}
    </button>
  )
}

// ─── The stack ───────────────────────────────────────────────────────────

/** VITE_SHOP_URL, else the origin the ops provider probes. */
function shopLink(probeUrl: string): string {
  if (config.shopUrl) return config.shopUrl
  try {
    return new URL(probeUrl).origin
  } catch {
    return probeUrl
  }
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`
}

function StackCard({
  state,
  now,
  downSince,
  busy,
  onBreak,
  onRespond,
}: {
  state: AutopilotState
  now: number
  downSince: number | null
  busy: string | null
  onBreak: (id: string, label: string) => void
  onRespond: () => void
}) {
  const health = state.health
  const current = state.current
  const last = state.history[0]
  const scenarios = state.provider?.scenarios
  const breakable = scenarios?.enabled ? scenarios.scenarios.filter((s) => s.id !== 'reset') : []

  if (!health) {
    return (
      <Notice tone="warn" title="No stack to watch yet">
        {state.health_error ?? 'Waiting for the first health check…'}
      </Notice>
    )
  }

  // The band: how long it's been down, who's on it, or how fast it came back.
  const since = current ? new Date(current.opened_at).getTime() : downSince
  let headline: ReactNode
  let sub: ReactNode
  let tone: 'ok' | 'down' | 'working'
  if (health.healthy && !current) {
    tone = 'ok'
    const recent = last?.status === 'resolved' && last.mttr_ms != null && now - new Date(last.closed_at ?? 0).getTime() < 5 * 60_000
    headline = recent ? `Fixed in ${seconds(last.mttr_ms!)}` : 'All healthy'
    sub = recent
      ? `No person involved. ${last.actions.map(label).join(', ')} for ${money(fromAtomic(last.spent, last.asset ?? TREE_ASSET))}.`
      : `Checked every 2 seconds. ${health.probe.url.replace(/^https?:\/\//, '')} answered ${health.probe.status} in ${health.probe.ms} ms.`
  } else {
    tone = current ? 'working' : 'down'
    headline = `Down ${clock(since ? now - since : 0)}`
    sub = current ? working(current, state) : state.enabled ? 'Confirming on a second check…' : 'Autopilot is off, so nobody is fixing it.'
  }

  return (
    <Card padded={false} className="overflow-hidden">
      <div
        className={cx(
          'flex flex-wrap items-center justify-between gap-4 border-b px-5 py-5',
          tone === 'ok' && 'border-authority/20 bg-authority/[0.04]',
          tone === 'down' && 'border-blocked/25 bg-blocked/[0.06]',
          tone === 'working' && 'border-warn/25 bg-warn/[0.05]',
        )}
        aria-live="polite"
      >
        <div className="min-w-0">
          <p
            className={cx(
              'numeric text-[38px] leading-none font-semibold tracking-tight',
              tone === 'ok' && 'text-authority',
              tone === 'down' && 'text-blocked',
              tone === 'working' && 'text-warn',
            )}
          >
            {headline}
          </p>
          <p className="mt-2 text-[13px] text-ink-dim">{sub}</p>
          {!health.healthy && health.problems.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-[12.5px] text-muted">
              {health.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
        {!health.healthy && !current && !state.enabled && (
          <Button variant="primary" disabled={busy === 'respond'} onClick={onRespond}>
            {busy === 'respond' ? 'Starting…' : 'Let the agents fix it'}
          </Button>
        )}
      </div>

      <div className="grid gap-px bg-hairline sm:grid-cols-3">
        {health.services.map((s) => (
          <ServiceTile key={s.name} service={s} />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-5 py-3.5">
        <p className="text-[12.5px] text-muted">
          <span className="font-mono text-ink-dim">{health.project}</span> on Docker ·{' '}
          <a
            href={shopLink(health.probe.url)}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-4 hover:text-ink hover:underline"
          >
            open the shop
          </a>
        </p>
        {breakable.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-faint">Break something:</span>
            {breakable.map((s) => (
              <Button
                key={s.id}
                size="sm"
                variant="danger"
                disabled={Boolean(busy) || Boolean(current) || !health.healthy}
                onClick={() => onBreak(s.id, s.label)}
              >
                {busy === s.id ? 'Breaking…' : s.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" disabled={Boolean(busy) || Boolean(current)} onClick={() => onBreak('reset', 'Reset')}>
              Reset
            </Button>
          </div>
        )}
      </div>
    </Card>
  )
}

function serviceState(s: ServiceHealth): { text: string; tone: 'ok' | 'warn' | 'down' } {
  if (s.state === 'running') {
    if (s.health === 'unhealthy') return { text: 'Unhealthy', tone: 'down' }
    if (s.health === 'starting') return { text: 'Starting', tone: 'warn' }
    return { text: 'Healthy', tone: 'ok' }
  }
  if (s.state === 'paused') return { text: 'Frozen', tone: 'down' }
  if (s.state === 'restarting') return { text: 'Restarting', tone: 'warn' }
  if (s.state === 'missing') return { text: 'Missing', tone: 'down' }
  return { text: s.state.charAt(0).toUpperCase() + s.state.slice(1), tone: 'down' }
}

function ServiceTile({ service }: { service: ServiceHealth }) {
  const { text, tone } = serviceState(service)
  return (
    <div className="bg-surface px-5 py-4">
      <p className="flex items-center gap-2 text-[14px] font-medium text-ink">
        <span
          aria-hidden
          className={cx(
            'h-2 w-2 rounded-full',
            tone === 'ok' && 'bg-authority',
            tone === 'warn' && 'bg-warn',
            tone === 'down' && 'bg-blocked animate-pulse-dot',
          )}
        />
        <span className="font-mono">{service.name}</span>
        <span className={cx('text-[12.5px] font-normal', tone === 'ok' ? 'text-muted' : tone === 'warn' ? 'text-warn' : 'text-blocked')}>
          {text}
        </span>
      </p>
      <p className="mt-1 text-[12px] text-faint">
        {ROLE[service.name] ?? 'Service'} · {service.status || service.state}
      </p>
    </div>
  )
}

/** One line on what the agents are doing right now. */
function working(incident: Incident, state: AutopilotState): string {
  const last = incident.steps[incident.steps.length - 1]
  const who = { detect: state.agents.detect, diagnose: state.agents.diagnose, fix: state.agents.fix, verify: state.agents.detect }[
    last?.stage ?? 'detect'
  ]
  switch (incident.status) {
    case 'diagnosing':
      return `${who} is ${stepVerb(last) ?? 'working out the cause'}…`
    case 'fixing':
      return `${who} is ${stepVerb(last) ?? 'repairing it'}…`
    case 'verifying':
      return `${state.agents.detect} is confirming the stack is healthy…`
    default:
      return incident.outcome ?? ''
  }
}

function stepVerb(step?: IncidentStep): string | null {
  switch (step?.step) {
    case 'briefed':
    case 'start':
    case 'discovered':
      return 'shopping for a provider'
    case 'quote':
      return 'comparing quotes'
    case 'authorization':
    case 'selected':
      return 'checking its policy'
    case 'payment_required':
    case 'paying':
      return 'paying over x402'
    case 'settled':
      return step.stage === 'fix' ? 'waiting for the repair to take' : 'reading the model’s answer'
    case 'ordering':
      return `ordering ${step.action ? label(step.action) : 'the repair'}`
    default:
      return null
  }
}

// ─── Policies ────────────────────────────────────────────────────────────

/** `null` when the policy engine couldn't be asked. */
interface Grant {
  diagnoseInference?: PolicyDecision | null
  diagnoseOps?: PolicyDecision | null
  fixOps?: PolicyDecision | null
}

function usePermissions(state: AutopilotState, refreshKey: string): Grant | null {
  const [grant, setGrant] = useState<Grant | null>(null)
  const { diagnose, fix } = state.agents
  const perAction = state.provider?.offer?.per_action ?? config.diagnosisEstimate
  useEffect(() => {
    let cancelled = false
    const check = (agent: string, service: string, amount: number) =>
      authorize({ agent, amount, service }).catch(() => null)
    Promise.all([check(diagnose, 'inference', config.diagnosisEstimate), check(diagnose, 'ops', perAction), check(fix, 'ops', perAction)]).then(
      ([diagnoseInference, diagnoseOps, fixOps]) => !cancelled && setGrant({ diagnoseInference, diagnoseOps, fixOps }),
    )
    return () => {
      cancelled = true
    }
  }, [diagnose, fix, perAction, refreshKey])
  return grant
}

function Permissions({ state, incident }: { state: AutopilotState; incident: Incident | null }) {
  const { nodes } = useLeash().live
  const grant = usePermissions(state, `${incident?.id}:${incident?.status}`)
  const fixDenied = grant?.fixOps && !grant.fixOps.approved

  // Every node from the root down to the fixer that doesn't list `ops` yet.
  const chain = state.agents.fix.split('.').map((_, i, parts) => parts.slice(i).join('.')).reverse()
  const missing = chain.filter((name) => !(nodes[name]?.records?.allowedServices ?? []).includes('ops'))

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        <AgentCard role="Watch" agent={state.agents.detect} lines={[{ text: 'Spends nothing, so it needs no spending authority', ok: true }]} />
        <AgentCard
          role="Diagnose"
          agent={state.agents.diagnose}
          lines={[
            decisionLine('Buys model inference', grant?.diagnoseInference),
            decisionLine('Buys repairs', grant?.diagnoseOps, true),
          ]}
        />
        <AgentCard role="Repair" agent={state.agents.fix} lines={[decisionLine('Buys repairs', grant?.fixOps)]} />
      </div>
      {fixDenied && (
        <Notice tone="warn" title={`${state.agents.fix} isn't allowed to buy repairs yet`}>
          <p>
            Its policy, or a parent's, doesn't list <span className="font-mono">ops</span> in{' '}
            <span className="font-mono">allowedServices</span>, so every repair it tries is refused and nothing is paid.
            The owner grants it with one record per node ({config.ensChainName}, signed by the tree's deployer):
          </p>
          <pre className="mt-2 overflow-x-auto rounded-md border border-hairline bg-sunken px-3 py-2 font-mono text-[11.5px] leading-5 text-ink-dim">
            {(missing.length ? missing : chain)
              .map((name) => {
                const current = nodes[name]?.records?.allowedServices ?? ['inference']
                const next = [...new Set([...current, 'ops'])].join(',')
                return `DEPLOYER_KEY=0x… node scripts/set-record.mjs ${name} allowedServices ${next}`
              })
              .join('\n')}
          </pre>
        </Notice>
      )}
    </div>
  )
}

/** A policy answer as one line. `mustNot` marks what the agent shouldn't be able to buy. */
function decisionLine(what: string, decision: PolicyDecision | null | undefined, mustNot = false): { text: string; ok?: boolean } {
  if (decision === undefined) return { text: `${what}: checking…` }
  if (decision === null) return { text: `${what}: couldn't ask the policy engine (is the gateway up?)` }
  if (mustNot)
    return decision.approved
      ? { text: `${what}: allowed, so it could act on its own diagnosis`, ok: false }
      : { text: `${what}: no, by design (${decision.blocked_by ?? 'policy'})`, ok: true }
  return decision.approved
    ? { text: `${what}: allowed`, ok: true }
    : { text: `${what}: not allowed (${decision.blocked_by ?? 'policy'})`, ok: false }
}

function AgentCard({ role, agent, lines }: { role: string; agent: string; lines: { text: string; ok?: boolean }[] }) {
  return (
    <div className="rounded-xl border border-line bg-surface px-4 py-3.5">
      <p className="text-[12px] text-faint">{role}</p>
      <p className="mt-0.5 font-mono text-[13.5px] text-ink">{agent}</p>
      <ul className="mt-2 space-y-1">
        {lines.map((l) => (
          <li key={l.text} className="flex items-start gap-2 text-[12.5px] text-muted">
            <span
              aria-hidden
              className={cx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', l.ok === undefined ? 'bg-idle' : l.ok ? 'bg-authority' : 'bg-blocked')}
            />
            {l.text}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ─── The incident ────────────────────────────────────────────────────────

function stepsOf(incident: Incident, stage: Stage): IncidentStep[] {
  return incident.steps.filter((s) => s.stage === stage)
}

function find(steps: IncidentStep[], step: string): IncidentStep | undefined {
  return steps.find((s) => s.step === step)
}

function label(a: OpsAction): string {
  return `${a.action} ${a.service}`
}

function laneState(incident: Incident, stage: Stage): LaneState {
  const steps = stepsOf(incident, stage)
  const has = (step: string) => steps.some((s) => s.step === step)
  switch (stage) {
    case 'detect':
      return 'done'
    case 'diagnose':
      return has('diagnosis') ? 'done' : incident.status === 'diagnosing' ? 'working' : 'failed'
    case 'fix':
      if (incident.status === 'fixing') return 'working'
      if (incident.status === 'blocked') return 'blocked'
      if (has('repaired')) return 'done'
      return incident.status === 'diagnosing' ? 'waiting' : 'failed'
    case 'verify':
      if (has('recovered')) return 'done'
      if (has('still_failing')) return 'failed'
      if (incident.status === 'verifying') return 'working'
      return incident.status === 'blocked' || incident.status === 'failed' ? 'skipped' : 'waiting'
  }
}

function IncidentView({ incident, state, asset, now }: { incident: Incident; state: AutopilotState; asset: AssetInfo; now: number }) {
  const open = !incident.closed_at
  const elapsed = open ? now - new Date(incident.opened_at).getTime() : null
  const fmt = (atomic?: number, a?: AssetInfo) => (atomic == null ? '—' : money(fromAtomic(atomic, a ?? asset)))

  return (
    <Card>
      <CardHead
        title={open ? 'Incident under way' : 'Last incident'}
        hint={
          <>
            <span className="font-mono">{incident.id}</span> · opened {timeAgo(incident.opened_at)} ·{' '}
            {incident.trigger === 'autopilot' ? 'autopilot responded on its own' : 'you asked the agents to respond'}
            {incident.spent > 0 && <> · {fmt(incident.spent, incident.asset ?? undefined)} paid</>}
          </>
        }
        action={<IncidentStatusChip status={incident.status} elapsed={elapsed} />}
      />

      <ol className="mt-5 grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
        <Lane n={1} title="Detect" agent={state.agents.detect} state={laneState(incident, 'detect')}>
          <DetectLane incident={incident} />
        </Lane>
        <Lane n={2} title="Diagnose" agent={state.agents.diagnose} state={laneState(incident, 'diagnose')}>
          <DiagnoseLane steps={stepsOf(incident, 'diagnose')} fmt={fmt} />
        </Lane>
        <Lane n={3} title="Repair" agent={state.agents.fix} state={laneState(incident, 'fix')}>
          <FixLane incident={incident} fmt={fmt} />
        </Lane>
        <Lane n={4} title="Confirm" agent={state.agents.detect} state={laneState(incident, 'verify')}>
          <VerifyLane incident={incident} />
        </Lane>
      </ol>

      <details className="group mt-5">
        <summary className="press cursor-pointer list-none text-[12.5px] text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-authority/60">
          <span className="inline-block transition-transform duration-200 group-open:rotate-90">›</span> Every step (
          {incident.steps.length})
        </summary>
        <ol className="mt-2 space-y-1 rounded-md border border-hairline bg-sunken px-3 py-2.5">
          {incident.steps.map((s, i) => (
            <li key={i} className="grid grid-cols-[4.5rem_5rem_1fr] gap-2 text-[12px] leading-5">
              <span className="numeric text-faint">+{seconds(s.at_ms)}</span>
              <span className="text-muted">{s.stage}</span>
              <span className="min-w-0 break-words text-ink-dim">{describe(s, fmt)}</span>
            </li>
          ))}
        </ol>
      </details>
    </Card>
  )
}

function IncidentStatusChip({ status, elapsed }: { status: Incident['status']; elapsed: number | null }) {
  const text = {
    diagnosing: 'Diagnosing',
    fixing: 'Repairing',
    verifying: 'Confirming',
    resolved: 'Resolved',
    blocked: 'Blocked',
    failed: 'Not resolved',
  }[status]
  const tone = status === 'resolved' ? 'text-authority border-authority/30' : status === 'blocked' || status === 'failed' ? 'text-blocked border-blocked/35' : 'text-warn border-warn/30'
  return (
    <span className={cx('inline-flex h-7 items-center gap-2 rounded-full border bg-raised px-3 text-[12.5px] font-medium', tone)}>
      {text}
      {elapsed != null && <span className="numeric text-muted">{clock(elapsed)}</span>}
    </span>
  )
}

function Lane({ n, title, agent, state, children }: { n: number; title: string; agent: string; state: LaneState; children: ReactNode }) {
  const chip = {
    waiting: ['Waiting', 'text-faint'],
    working: ['Working', 'text-warn'],
    done: ['Done', 'text-authority'],
    blocked: ['Blocked', 'text-blocked'],
    failed: ['Failed', 'text-blocked'],
    skipped: ['Skipped', 'text-faint'],
  }[state]
  return (
    <li
      className={cx(
        'min-w-0 rounded-lg border bg-raised/40 p-4',
        state === 'working' ? 'border-warn/40' : state === 'blocked' || state === 'failed' ? 'border-blocked/35' : 'border-line',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[13.5px] font-semibold text-ink">
          <span className="numeric mr-1.5 text-faint">{n}</span>
          {title}
        </p>
        <span className={cx('text-[12px] font-medium', chip[1])}>
          {state === 'working' && <span className="animate-pulse-dot mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-warn align-middle" />}
          {chip[0]}
        </span>
      </div>
      <p className="mt-0.5 font-mono text-[12px] text-muted">{agent}</p>
      <div className="mt-3 space-y-2.5 text-[12.5px] leading-5 text-ink-dim">{children}</div>
    </li>
  )
}

function DetectLane({ incident }: { incident: Incident }) {
  const detected = incident.steps.find((s) => s.step === 'detected') as IncidentStep & { confirmed_checks?: number }
  return (
    <>
      <ul className="space-y-1">
        {incident.problems.map((p) => (
          <li key={p} className="text-blocked/90">
            {p}
          </li>
        ))}
      </ul>
      <p className="text-muted">
        {incident.trigger === 'autopilot'
          ? `Confirmed on ${detected?.confirmed_checks ?? 2} checks, 2 s apart. Evidence passed on: states, healthchecks, logs.`
          : 'Evidence passed on: states, healthchecks, logs.'}
      </p>
    </>
  )
}

/** What was paid, and to whom — only once a payment has settled. Providers
 *  that failed before it (unpaid) are listed first. */
function Paid({ steps, fmt }: { steps: IncidentStep[]; fmt: (a?: number, asset?: AssetInfo) => string }) {
  const selected = [...steps].reverse().find((s) => s.step === 'selected')
  const settled = find(steps, 'settled')
  const audited = find(steps, 'audited')
  const pending = find(steps, 'audit_pending')
  const failures = steps.filter((s) => s.step === 'service_failed')
  const failedLines = failures.map((f, i) => (
    <p key={i} className="text-warn">
      {f.provider ?? 'The provider'} failed, so it wasn't charged{f.trying_next ? '; trying the next approved quote.' : '.'}
    </p>
  ))
  if (!selected) return null
  if (!settled) {
    const lastFailed = failures.length > 0 && steps.lastIndexOf(failures[failures.length - 1]) > steps.lastIndexOf(selected)
    return (
      <>
        {failedLines}
        {!lastFailed && (
          <p className="text-muted">
            Paying <span className="numeric text-ink">{fmt(selected.amount, selected.asset)}</span> to {selected.provider}…
          </p>
        )}
      </>
    )
  }
  return (
    <>
    {failedLines}
    <p className="text-muted">
      Paid <span className="numeric text-ink">{fmt(selected.amount, selected.asset)}</span> to {selected.provider}
      {settled?.transaction && (
        <>
          {' · '}
          <a href={settled.explorer ?? hashscanUrl('transaction', settled.transaction)} target="_blank" rel="noreferrer" className="underline-offset-4 hover:text-ink hover:underline">
            transaction
          </a>
        </>
      )}
      {audited?.topic && (
        <>
          {' · '}
          <a href={hashscanUrl('topic', audited.topic)} target="_blank" rel="noreferrer" className="underline-offset-4 hover:text-ink hover:underline">
            HCS #{audited.sequence}
          </a>
        </>
      )}
      {!audited && !pending && ' · receipt reaching HCS…'}
    </p>
    </>
  )
}

/** Why a purchase stopped short, if it did. */
function stopped(steps: IncidentStep[], fmt: (a?: number, asset?: AssetInfo) => string): string | null {
  for (const s of [...steps].reverse()) {
    switch (s.step) {
      case 'denied':
        return `Policy denied it: ${s.decision?.reason ?? 'not permitted'}`
      case 'over_budget':
        return `Cheapest quote ${fmt(s.cheapest, s.asset)} is over the ${fmt(s.budget_atomic, s.asset)} cap`
      case 'refused':
        return `The provider refused: ${s.reason}`
      case 'service_failed':
        return s.trying_next ? null : `No provider could serve it, so nothing was charged. Last error: ${s.reason}`
      case 'payment_failed':
      case 'error':
        return s.message ?? 'Failed'
      case 'no_provider':
        return 'No provider sells it'
      case 'settled':
      case 'result':
        return null
    }
  }
  return null
}

function DiagnoseLane({ steps, fmt }: { steps: IncidentStep[]; fmt: (a?: number, asset?: AssetInfo) => string }) {
  const diagnosis = find(steps, 'diagnosis')
  const result = find(steps, 'result')
  const quotes = steps.filter((s) => s.step === 'quote')
  const why = stopped(steps, fmt)
  return (
    <>
      {quotes.length > 0 && !diagnosis && (
        <p className="text-muted">
          {quotes.length} quote{quotes.length === 1 ? '' : 's'}: {quotes.map((q) => `${q.provider} ${fmt(q.amount, q.asset)}`).join(', ')}
        </p>
      )}
      <Paid steps={steps} fmt={fmt} />
      {why && <p className="text-blocked">{why}</p>}
      {diagnosis && (
        <>
          <blockquote className="border-l-2 border-delegated/60 pl-3 text-ink">{diagnosis.root_cause}</blockquote>
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="text-muted">Plan:</span>
            {(diagnosis.actions ?? []).map((a) => (
              <code key={label(a)} className="rounded border border-line bg-sunken px-1.5 py-0.5 font-mono text-[11.5px] text-ink">
                {label(a)}
              </code>
            ))}
          </p>
          <p className="text-muted">
            {diagnosis.by === 'runbook' ? 'Decided by the built-in runbook.' : `Diagnosed by ${result?.model ?? diagnosis.by}.`}
          </p>
          {diagnosis.note && <p className="text-warn">{diagnosis.note}</p>}
        </>
      )}
    </>
  )
}

function FixLane({ incident, fmt }: { incident: Incident; fmt: (a?: number, asset?: AssetInfo) => string }) {
  const steps = stepsOf(incident, 'fix')
  // One group per repair ordered.
  const groups: IncidentStep[][] = []
  for (const s of steps) {
    if (s.step === 'ordering' || groups.length === 0) groups.push([])
    groups[groups.length - 1].push(s)
  }
  if (groups.length === 0) return <p className="text-faint">Waits for the diagnosis.</p>
  return (
    <>
      {groups.map((g, i) => {
        const order = find(g, 'ordering')
        const auth = find(g, 'authorization')
        const repaired = find(g, 'repaired')
        const why = stopped(g, fmt)
        return (
          <div key={i} className="space-y-1.5">
            {order?.action && (
              <p>
                <code className="rounded border border-line bg-sunken px-1.5 py-0.5 font-mono text-[11.5px] text-ink">{label(order.action)}</code>
              </p>
            )}
            {auth?.decision?.approved && (
              <p className="text-authority">
                Policy approved: {auth.decision.checks.filter((c) => c.status === 'pass').length} checks passed
              </p>
            )}
            <Paid steps={g} fmt={fmt} />
            {why && <p className="text-blocked">{why}</p>}
            {repaired?.ops && (
              <>
                <p className="font-mono text-[11.5px] text-muted">$ {repaired.ops.command}</p>
                <p className={repaired.ops.health.healthy ? 'text-authority' : 'text-warn'}>
                  {repaired.ops.health.healthy ? 'The stack reports healthy.' : `Still: ${repaired.ops.health.problems.join('; ')}`}
                </p>
              </>
            )}
          </div>
        )
      })}
      {incident.status === 'blocked' && incident.outcome && <p className="text-muted">Nothing was paid for the repair.</p>}
    </>
  )
}

function VerifyLane({ incident }: { incident: Incident }) {
  const steps = stepsOf(incident, 'verify')
  const recovered = find(steps, 'recovered')
  const failing = find(steps, 'still_failing')
  if (recovered)
    return (
      <>
        <p className="numeric text-[26px] leading-none font-semibold text-authority">
          {incident.mttr_ms != null ? seconds(incident.mttr_ms) : 'Healthy'}
        </p>
        <p className="text-muted">From detection to a healthy stack, confirmed from outside.</p>
        <ProbeLine health={recovered.health} />
      </>
    )
  if (failing)
    return (
      <>
        <p className="text-blocked">Still failing: {failing.health?.problems.join('; ')}</p>
        <p className="text-muted">Autopilot paused itself so it doesn't keep paying for a repair that doesn't work.</p>
      </>
    )
  if (incident.status === 'blocked' || incident.status === 'failed') return <p className="text-muted">{incident.outcome}</p>
  return <p className="text-faint">Checks the stack once the repair is in.</p>
}

function ProbeLine({ health }: { health?: InfraHealth }) {
  if (!health) return null
  return (
    <p className="text-muted">
      {health.probe.url.replace(/^https?:\/\//, '')} answers {health.probe.status ?? 'nothing'} in {health.probe.ms} ms
    </p>
  )
}

/** One step as a sentence, for the full log. */
function describe(s: IncidentStep, fmt: (a?: number, asset?: AssetInfo) => string): string {
  const x = s as IncidentStep & Record<string, unknown>
  switch (s.step) {
    case 'detected':
      return `${s.agent} saw: ${(s.problems ?? []).join('; ')}`
    case 'briefed':
      return `Briefed ${s.agent} with states, healthchecks, logs and the repair menu`
    case 'start':
      return `${s.agent} shops for ${String(x.service)}, cap ${fmt(s.budget_atomic)}`
    case 'discovered':
      return `Found ${s.count ?? 0} providers`
    case 'quote':
      return `${s.provider} quoted ${fmt(s.amount, s.asset)}`
    case 'quote_failed':
      return `${String(x.base_url)} didn't quote: ${s.message}`
    case 'over_budget':
      return `Cheapest quote ${fmt(s.cheapest, s.asset)} is over the cap`
    case 'authorization':
      return `Policy ${s.decision?.approved ? 'approved' : 'denied'} at ${s.provider}${s.decision?.reason ? `: ${s.decision.reason}` : ''}`
    case 'authorization_failed':
      return `Couldn't ask ${s.provider}'s policy engine: ${s.message}`
    case 'denied':
      return `Denied: ${s.decision?.reason ?? 'not permitted'}`
    case 'selected':
      return `Chose ${s.provider} at ${fmt(s.amount, s.asset)}`
    case 'payment_required':
      return 'The provider answered 402 with its price'
    case 'paying':
      return `Signing the ${config.assetSymbol} transfer`
    case 'settled':
      return `Settled ${s.transaction}`
    case 'result':
      return s.stage === 'fix' ? (s.completion ?? 'Repair done') : `${s.model} answered: ${(s.completion ?? '').slice(0, 220)}`
    case 'diagnosis':
      return `Root cause: ${s.root_cause} Plan: ${(s.actions ?? []).map(label).join(', ') || 'none'}${s.by === 'runbook' ? ' (runbook)' : ''}`
    case 'ordering':
      return `${s.agent} orders ${s.action ? label(s.action) : 'a repair'}`
    case 'repaired':
      return s.ops ? `Ran ${s.ops.command}; ${s.ops.health.healthy ? 'healthy' : 'still failing'}` : 'Repaired'
    case 'refused':
    case 'service_failed':
      return `${s.step === 'refused' ? 'Refused' : 'Provider failed'}: ${s.reason}`
    case 'payment_failed':
    case 'error':
      return s.message ?? s.step
    case 'no_provider':
      return 'No provider sells it'
    case 'audited':
      return `Receipt on HCS, message #${s.sequence}`
    case 'audit_pending':
      return 'Receipt not on HCS yet'
    case 'recovered':
      return `${s.agent}: healthy again`
    case 'still_failing':
      return `${s.agent}: still failing (${s.health?.problems.join('; ')})`
    default:
      return s.step
  }
}

// ─── History ─────────────────────────────────────────────────────────────

function History({ incidents, asset }: { incidents: Incident[]; asset: AssetInfo }) {
  return (
    <Card padded={false}>
      <div className="px-5 pt-5">
        <CardHead title="Incidents" hint="The last ten, newest first. Every payment in them is on HCS with the agent's mandate chain." />
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[12.5px]">
          <thead className="text-faint">
            <tr className="border-y border-hairline">
              <th className="px-5 py-2 font-normal">When</th>
              <th className="px-3 py-2 font-normal">What broke</th>
              <th className="px-3 py-2 font-normal">Cause</th>
              <th className="px-3 py-2 font-normal">Repair</th>
              <th className="px-3 py-2 text-right font-normal">Paid</th>
              <th className="px-3 py-2 text-right font-normal">Time to fix</th>
              <th className="px-5 py-2 font-normal">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {incidents.map((i) => (
              <tr key={i.id} className="align-top text-ink-dim">
                <td className="px-5 py-2.5 whitespace-nowrap text-muted">{timeAgo(i.opened_at)}</td>
                <td className="px-3 py-2.5">{i.problems[0] ?? '—'}</td>
                <td className="max-w-[18rem] px-3 py-2.5">
                  {i.root_cause ?? '—'}
                  {i.diagnosed_by && <span className="block text-faint">{i.diagnosed_by === 'runbook' ? 'runbook' : i.diagnosed_by}</span>}
                </td>
                <td className="px-3 py-2.5 font-mono text-[11.5px]">{i.actions.map(label).join(', ') || '—'}</td>
                <td className="numeric px-3 py-2.5 text-right">{i.spent ? money(fromAtomic(i.spent, i.asset ?? asset)) : '—'}</td>
                <td className="numeric px-3 py-2.5 text-right">{i.mttr_ms != null ? seconds(i.mttr_ms) : '—'}</td>
                <td className={cx('px-5 py-2.5 whitespace-nowrap', i.status === 'resolved' ? 'text-authority' : i.status === 'blocked' || i.status === 'failed' ? 'text-blocked' : 'text-warn')}>
                  {{ resolved: 'Resolved', blocked: 'Blocked', failed: 'Not resolved', diagnosing: 'Diagnosing', fixing: 'Repairing', verifying: 'Confirming' }[i.status]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function Notice({ tone, title, children }: { tone: 'warn' | 'blocked'; title: string; children: ReactNode }) {
  return (
    <div
      className={cx(
        'rounded-xl border px-4 py-3 text-[12.5px] leading-5 text-ink-dim',
        tone === 'warn' ? 'border-warn/30 bg-warn/[0.05]' : 'border-blocked/30 bg-blocked/[0.05]',
      )}
    >
      <p className={cx('mb-1 text-[13px] font-medium', tone === 'warn' ? 'text-warn' : 'text-blocked')}>{title}</p>
      {children}
    </div>
  )
}
