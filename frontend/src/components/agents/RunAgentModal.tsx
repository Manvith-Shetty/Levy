import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useToast } from '../../app/toast'
import { useUI, type RunPreset } from '../../app/ui'
import { config, hashscanUrl } from '../../lib/config'
import {
  fromAtomic,
  getRunner,
  readRequirements,
  runAgent,
  type ComputeResource,
  type RunnerInfo,
  type RunStep,
} from '../../lib/live/runner'
import { useLeash } from '../../lib/store'
import { cx, money } from '../../lib/utils'
import { Button } from '../common/Button'
import { Label, MoneyInput, Select, Textarea } from '../common/Field'
import { Modal, ModalFoot, ModalHead } from '../common/Modal'
import { PolicyChecklist } from '../policy/PolicyChecklist'

/** A sensible first task per service, replaced once the owner types their own. */
const DEFAULT_TASK: Record<string, string> = {
  inference: "Explain Hedera's hashgraph consensus in three sentences.",
  compute: 'Run a Redis cache for 10 minutes.',
}
const defaultTask = (service: string) => DEFAULT_TASK[service] ?? DEFAULT_TASK.inference

type Of<K extends RunStep['step']> = Extract<RunStep, { step: K }>

interface Run {
  start?: Of<'start'>
  discovered?: Of<'discovered'>
  noProvider?: Of<'no_provider'>
  planned?: Of<'planned'>
  quotes: Of<'quote'>[]
  failed: Of<'quote_failed'>[]
  overBudget?: Of<'over_budget'>
  authorizations: Of<'authorization'>[]
  authFailures: Of<'authorization_failed'>[]
  denied?: Of<'denied'>
  selected?: Of<'selected'>
  challenge?: Of<'payment_required'>
  refused?: Of<'refused'>
  paying?: Of<'paying'>
  paymentFailed?: Of<'payment_failed'>
  serviceFailed?: Of<'service_failed'>
  settled?: Of<'settled'>
  result?: Of<'result'>
  audited?: Of<'audited'>
  auditPending?: Of<'audit_pending'>
  error?: string
  done?: Of<'done'>
}

const EMPTY: Run = { quotes: [], failed: [], authorizations: [], authFailures: [] }

function reduce(run: Run, step: RunStep): Run {
  switch (step.step) {
    case 'quote':
      return { ...run, quotes: [...run.quotes, step] }
    case 'quote_failed':
      return { ...run, failed: [...run.failed, step] }
    case 'authorization':
      return { ...run, authorizations: [...run.authorizations, step] }
    case 'authorization_failed':
      return { ...run, authFailures: [...run.authFailures, step] }
    case 'no_provider':
      return { ...run, noProvider: step }
    case 'over_budget':
      return { ...run, overBudget: step }
    case 'payment_required':
      return { ...run, challenge: step }
    case 'payment_failed':
      return { ...run, paymentFailed: step }
    case 'service_failed':
      return { ...run, serviceFailed: step }
    case 'selected':
      // A later selection is the next approved quote, tried after a provider
      // failed (unpaid): the new attempt replaces the failed one.
      return { ...run, selected: step, serviceFailed: undefined, challenge: undefined, paying: undefined }
    case 'audit_pending':
      return { ...run, auditPending: step }
    case 'error':
      return { ...run, error: step.message }
    default:
      return { ...run, [step.step]: step }
  }
}

/** Where the run is, in the words the owner reads: one lifecycle state. */
function lifecycle(run: Run, running: boolean): { label: string; tone: 'active' | 'ok' | 'bad' } {
  if (run.error) return { label: 'Failed', tone: 'bad' }
  if (run.noProvider) return { label: run.noProvider.unavailable ? 'Provider unavailable' : 'No provider', tone: 'bad' }
  if (run.overBudget) return { label: 'Over spend cap', tone: 'bad' }
  if (run.denied || (run.refused && !run.settled)) {
    const v = run.denied?.decision?.violation
    return {
      label: v === 'insufficient_authority' || v === 'over_budget' ? 'Insufficient authority' : 'Policy denied',
      tone: 'bad',
    }
  }
  if (run.paymentFailed) return { label: 'Payment failed', tone: 'bad' }
  if (run.serviceFailed) return { label: 'Service failed', tone: 'bad' }
  if (run.settled && !run.result && !running) return { label: 'Service failed', tone: 'bad' }
  if (run.audited) return { label: 'Audited', tone: 'ok' }
  if (run.result) {
    return {
      label: running ? 'Completed · auditing' : run.auditPending ? 'Completed · audit pending' : 'Completed',
      tone: 'ok',
    }
  }
  if (run.settled) return { label: 'Settled · executing', tone: 'active' }
  if (run.paying) return { label: 'Paying', tone: 'active' }
  if (run.selected) return { label: 'Approved', tone: 'active' }
  if (run.quotes.length) return { label: run.authorizations.length ? 'Authorizing' : 'Quoted', tone: 'active' }
  return { label: 'Discovering', tone: 'active' }
}

/** Hedera tx ids come as `0.0.x@s.n` or `0.0.x-s-n`; compare them as one. */
function sameTx(a?: string, b?: string): boolean {
  if (!a || !b) return false
  const norm = (id: string) => id.replace('@', '-').replace(/\.(\d+)$/, '-$1')
  return norm(a) === norm(b)
}

export function RunAgentModal({
  open,
  onClose,
  agentId,
  preset,
}: {
  open: boolean
  onClose: () => void
  agentId?: string
  /** Pre-filled service and job, e.g. adding time to a running container. */
  preset?: RunPreset
}) {
  const { agents, events, services, live } = useLeash()
  const { push } = useToast()
  const ui = useUI()

  const choices = useMemo(() => agents.filter((a) => a.parentId), [agents])
  const fallback = choices.find((a) => a.id === 'sub.agent.root')?.id ?? choices[0]?.id ?? ''
  const categories = useMemo(() => {
    const kinds = new Set(services.map((s) => s.listing?.kind).filter((k): k is string => Boolean(k)))
    kinds.add('inference')
    return [...kinds].sort()
  }, [services])

  const [picked, setPicked] = useState(agentId ?? '')
  // Agents may arrive after the first render; fall back until one is picked.
  const agent = choices.some((a) => a.id === picked) ? picked : fallback
  const [service, setServiceRaw] = useState(preset?.service ?? 'inference')
  const [prompt, setPrompt] = useState(preset?.prompt ?? defaultTask(preset?.service ?? 'inference'))
  const extending = preset?.job?.extend
  // Switching service swaps the example task, but never what the owner typed.
  const setService = (next: string) => {
    if (prompt === defaultTask(service)) setPrompt(defaultTask(next))
    setServiceRaw(next)
  }
  const [cap, setCap] = useState<number | ''>('')
  const [runner, setRunner] = useState<RunnerInfo | null>(null)
  const [runnerError, setRunnerError] = useState<string | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [running, setRunning] = useState(false)
  const abort = useRef<AbortController | null>(null)

  const decimals = config.assetDecimals
  const maxCap = runner ? runner.max_atomic / 10 ** decimals : undefined

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    getRunner(controller.signal)
      .then((info) => {
        setRunner(info)
        setRunnerError(null)
        setCap((c) => (c === '' ? info.max_atomic / 10 ** decimals : c))
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setRunnerError(error instanceof Error ? error.message : String(error))
      })
    return () => controller.abort()
  }, [open, decimals])

  useEffect(() => () => abort.current?.abort(), [])

  const capAtomic = typeof cap === 'number' ? Math.round(cap * 10 ** decimals) : 0
  const capValid = typeof cap === 'number' && cap > 0 && (!runner || capAtomic <= runner.max_atomic)
  const canRun = Boolean(runner && agent && prompt.trim() && capValid && !running)

  async function start() {
    if (!canRun) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    let acc: Run = EMPTY
    setRun(EMPTY)
    setRunning(true)
    try {
      await runAgent(
        { agent, service, prompt: prompt.trim(), budget_atomic: capAtomic, job: preset?.job, provider: preset?.provider },
        (step) => {
          acc = reduce(acc, step)
          setRun(acc)
          // Refresh the dashboard as soon as money moved, not after the audit wait.
          if (step.step === 'result') void live.refresh(true)
        },
        controller.signal,
      )
      if (acc.result) {
        const { charged, asset, provider } = acc.result
        push({
          tone: 'success',
          title: 'Payment settled',
          body: `${agent} paid ${money(fromAtomic(charged, asset))} to ${provider}.`,
        })
      } else if (acc.denied || acc.refused) {
        push({ tone: 'blocked', title: 'Payment denied', body: `Leash stopped ${agent} before any payment.` })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        acc = { ...acc, error: error instanceof Error ? error.message : String(error) }
        setRun(acc)
      }
    } finally {
      setRunning(false)
      void live.refresh(true)
    }
  }

  const fmt = (atomic: number, d = decimals) => money(atomic / 10 ** d)
  const req = run?.challenge ? readRequirements(run.challenge.requirements) : null
  const state = run ? lifecycle(run, running) : null
  const chosenDecision =
    run?.authorizations.find((a) => a.quote_id === run.selected?.quote_id)?.decision ?? run?.denied?.decision ?? null
  const decisionFor = (quoteId: string) => run?.authorizations.find((a) => a.quote_id === quoteId)?.decision
  const matching = run?.discovered?.providers.filter((p) => (p.manifest?.category ?? 'inference') === service) ?? []
  const activityEvent = run?.settled ? events.find((e) => sameTx(e.txId, run.settled!.transaction)) : undefined

  return (
    <Modal open={open} onClose={running ? () => undefined : onClose} width="max-w-2xl" labelledBy="run-agent-title">
      <ModalHead
        id="run-agent-title"
        title={extending ? 'Add time to a container' : 'Give an agent a task'}
        hint={
          extending
            ? 'More time is a new payment, so Leash checks the agent\'s policy again before anything is paid.'
            : 'The agent finds a provider, gets quotes, and asks Leash whether it may pay. Only an approved payment settles over x402 on Hedera, from the shared agent wallet.'
        }
        onClose={running ? () => undefined : onClose}
      />

      <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
        {runnerError && (
          <p className="copy mb-4 rounded-md border border-warn/40 bg-warn/[0.07] px-3 py-2.5 text-[12.5px] text-warn">
            {runnerError}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-[1fr_150px_150px]">
          <div>
            <Label htmlFor="run-agent">Agent</Label>
            <Select id="run-agent" className="h-11" value={agent} disabled={running} onChange={(e) => setPicked(e.target.value)}>
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}
                  {a.status === 'revoked' ? ' (revoked)' : a.status === 'suspended' ? ' (parent revoked)' : ''}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="run-service">Service</Label>
            <Select id="run-service" className="h-11" value={service} disabled={running} onChange={(e) => setService(e.target.value)}>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="run-cap" hint={maxCap !== undefined ? `≤ ${money(maxCap)}` : undefined}>
              Spend cap
            </Label>
            <MoneyInput id="run-cap" value={cap} onValueChange={setCap} invalid={cap !== '' && !capValid} />
          </div>
        </div>
        <div className="mt-4">
          <Label htmlFor="run-prompt">Task</Label>
          <Textarea
            id="run-prompt"
            value={prompt}
            disabled={running}
            maxLength={2000}
            onChange={(e) => setPrompt((e.target as unknown as HTMLTextAreaElement).value)}
          />
        </div>

        {run && state && (
          <>
            <div className="mt-6 flex items-center justify-between border-t border-hairline pt-4">
              <p className="text-[12.5px] text-muted">
                <span className="font-mono text-ink">{agent}</span> · {service}
              </p>
              <span
                role="status"
                className={cx(
                  'rounded px-2 py-0.5 text-[11.5px] font-medium',
                  state.tone === 'ok' && 'bg-authority/15 text-authority',
                  state.tone === 'bad' && 'bg-blocked/15 text-blocked',
                  state.tone === 'active' && 'bg-raised text-ink-dim',
                )}
              >
                {state.label}
              </span>
            </div>

            <ol className="mt-4">
              <Stage
                n={1}
                title="Discover"
                state={
                  run.discovered
                    ? run.noProvider && !run.noProvider.unavailable
                      ? 'failed'
                      : 'done'
                    : running
                      ? 'active'
                      : 'idle'
                }
              >
                {run.discovered && (
                  <p className="text-[12.5px] text-muted">
                    {run.discovered.providers.length} provider{run.discovered.providers.length === 1 ? '' : 's'} found
                    {run.discovered.providers.some((p) => p.source === 'hcs') ? ' on the HCS registry' : ''};{' '}
                    {matching.length} sell {service}.
                  </p>
                )}
                {run.noProvider && !run.noProvider.unavailable && (
                  <p className="mt-1 text-[12.5px] text-blocked">No provider sells {service} right now. Nothing was paid.</p>
                )}
                {run.planned && (
                  <div className="mt-2 rounded-md border border-hairline bg-sunken px-3 py-2 text-[12.5px]">
                    <p className="text-muted">
                      {run.planned.planner === 'given'
                        ? 'Job'
                        : run.planned.planner === 'rules'
                          ? 'Planned from the task (keyword rules)'
                          : `Planned from the task by ${run.planned.planner}`}
                    </p>
                    <p className="mt-1 font-mono text-[12px] text-ink">
                      {run.planned.job.extend
                        ? `extend ${run.planned.job.extend} by ${run.planned.job.minutes} min`
                        : `${run.planned.job.image} · ${run.planned.job.command || 'default command'} · ${run.planned.job.minutes} min`}
                    </p>
                    {run.planned.note && <p className="mt-1 text-[11.5px] text-warn">{run.planned.note}</p>}
                  </div>
                )}
              </Stage>

              <Stage
                n={2}
                title="Quote"
                state={
                  run.overBudget || run.noProvider?.unavailable
                    ? 'failed'
                    : run.quotes.length
                      ? 'done'
                      : run.discovered && running
                        ? 'active'
                        : 'idle'
                }
              >
                {run.quotes.length > 0 && (
                  <div className="overflow-x-auto rounded-md border border-hairline">
                    <table className="w-full text-[12.5px]">
                      <thead className="text-left text-faint">
                        <tr className="border-b border-hairline">
                          <th className="px-3 py-2 font-normal">Provider</th>
                          <th className="px-3 py-2 text-right font-normal">Quote</th>
                          <th className="px-3 py-2 text-right font-normal">Leash</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...run.quotes]
                          .sort((a, b) => a.amount - b.amount)
                          .map((q) => {
                            const chosen = run.selected?.quote_id === q.quote_id
                            const decision = decisionFor(q.quote_id)
                            return (
                              <tr
                                key={q.quote_id}
                                className={cx('border-b border-hairline last:border-0', chosen && 'bg-authority/[0.06]')}
                              >
                                <td className="px-3 py-2">
                                  <span className={cx('font-medium', chosen ? 'text-authority' : 'text-ink')}>{q.provider}</span>
                                  <span className="ml-2 font-mono text-[11.5px] text-faint">{q.model}</span>
                                </td>
                                <td className="numeric px-3 py-2 text-right text-ink">{fmt(q.amount, q.asset.decimals)}</td>
                                <td className="px-3 py-2 text-right text-[12px]">
                                  {decision ? (
                                    decision.approved ? (
                                      <span className="text-authority">{chosen ? 'Approved · chosen' : 'Approved'}</span>
                                    ) : (
                                      <span className="text-blocked">Denied</span>
                                    )
                                  ) : q.amount > (run.start?.budget_atomic ?? Infinity) ? (
                                    <span className="text-faint">Over cap</span>
                                  ) : (
                                    <span className="text-faint">Not needed</span>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                      </tbody>
                    </table>
                  </div>
                )}
                {run.quotes[0] &&
                  (run.planned ? (
                    <p className="mt-1.5 text-[12px] text-faint">
                      Priced per minute: {run.quotes[0].max_output_tokens} min, prepaid. The container is removed when
                      the time runs out.
                    </p>
                  ) : (
                    <p className="mt-1.5 text-[12px] text-faint">
                      Priced per token: {run.quotes[0].input_tokens} in, up to {run.quotes[0].max_output_tokens} out.
                    </p>
                  ))}
                {run.failed.map((f) => (
                  <p key={f.base_url} className="mt-1 text-[12px] text-warn">
                    {f.base_url} didn't quote: {f.message}
                  </p>
                ))}
                {run.overBudget && (
                  <p className="mt-1 text-[12.5px] text-blocked">
                    The cheapest quote, {fmt(run.overBudget.cheapest, run.overBudget.asset.decimals)}, is over the{' '}
                    {fmt(run.overBudget.budget_atomic, run.overBudget.asset.decimals)} spend cap. Nothing was paid.
                  </p>
                )}
                {run.noProvider?.unavailable && (
                  <p className="mt-1 text-[12.5px] text-blocked">No {service} provider answered. Nothing was paid.</p>
                )}
              </Stage>

              <Stage
                n={3}
                title="Authorize"
                state={
                  run.denied
                    ? 'failed'
                    : run.selected
                      ? 'done'
                      : run.quotes.length && running && !run.overBudget
                        ? 'active'
                        : 'idle'
                }
              >
                {chosenDecision ? (
                  <PolicyChecklist decision={chosenDecision} />
                ) : (
                  run.authFailures.map((f) => (
                    <p key={f.provider} className="text-[12px] text-warn">
                      {f.provider} couldn't evaluate the policy: {f.message}
                    </p>
                  ))
                )}
                {run.denied && (
                  <p className="mt-2 text-[12.5px] text-muted">Leash denied it, so nothing was signed or paid.</p>
                )}
              </Stage>

              <Stage
                n={4}
                title="Pay"
                state={
                  run.paymentFailed || run.serviceFailed || (run.refused && !run.settled)
                    ? 'failed'
                    : run.settled
                      ? 'done'
                      : run.selected && running
                        ? 'active'
                        : 'idle'
                }
              >
                {req && (
                  <p className="copy text-[12.5px] text-muted">
                    The provider asked for{' '}
                    <span className="numeric text-ink">{req.amount ? fmt(Number(req.amount)) : ''}</span>{' '}
                    {config.assetSymbol} over x402 ({req.scheme}, {req.network}). The agent signed a transfer from the
                    shared wallet and Blocky402 settled it on Hedera{req.feePayer ? ', paying the network fee' : ''}.
                  </p>
                )}
                {run.serviceFailed && (
                  <p className="mt-1 text-[12.5px] text-muted">
                    Not settled: the provider only takes payment after the service succeeds, so nothing was paid.
                  </p>
                )}
                {run.paying && !run.settled && !run.paymentFailed && !run.serviceFailed && (
                  <p className="mt-1 text-[12.5px] text-muted">Waiting for settlement…</p>
                )}
                {run.settled && (
                  <p className="mt-1.5 text-[12.5px] text-muted">
                    Settled:{' '}
                    <a
                      href={run.settled.explorer}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-authority underline-offset-2 hover:underline focus-visible:underline active:opacity-70"
                    >
                      {run.settled.transaction}
                    </a>
                  </p>
                )}
                {run.paymentFailed && (
                  <p className="mt-1 text-[12.5px] text-blocked">
                    Payment could not be settled: {run.paymentFailed.message}
                  </p>
                )}
                {run.refused && !run.settled && (
                  <p className="mt-1 text-[12.5px] text-blocked">The provider's guard refused it: {run.refused.reason}</p>
                )}
              </Stage>

              <Stage
                n={5}
                title="Execute"
                state={
                  run.result
                    ? 'done'
                    : run.serviceFailed || (run.settled && !running)
                      ? 'failed'
                      : run.settled || (run.paying && running)
                        ? 'active'
                        : 'idle'
                }
              >
                {run.serviceFailed && (
                  <p className="text-[12.5px] text-blocked">The service failed: {run.serviceFailed.reason}.</p>
                )}
                {run.settled && !run.result && running && (
                  <p className="text-[12.5px] text-muted">Payment confirmed. Running the service…</p>
                )}
                {run.settled && !run.result && !running && (
                  <p className="text-[12.5px] text-blocked">Payment settled, but the service didn't return a result.</p>
                )}
                {run.result?.resource && (
                  <p className="text-[12.5px] text-muted">
                    {extending ? 'Time added to' : 'Started'}{' '}
                    <span className="font-mono text-ink">{run.result.resource.name}</span> on local Docker.
                  </p>
                )}
                {run.result && !run.result.resource && (
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-4">
                    <Fact k="Tokens in" v={String(run.result.usage.input_tokens)} />
                    <Fact k="Tokens out" v={String(run.result.usage.output_tokens)} />
                    <Fact k="Charged" v={fmt(run.result.charged, run.result.asset.decimals)} />
                    <Fact k="Paid, not used" v={fmt(run.result.unused_output_credit, run.result.asset.decimals)} />
                  </dl>
                )}
              </Stage>

              <Stage n={6} title="Result" state={run.result ? 'done' : 'idle'}>
                {run.result?.resource && <ResourceCard resource={run.result.resource} onOpen={onClose} />}
                {run.result && !run.result.resource && (
                  <p className="copy rounded-md border border-hairline bg-sunken px-3 py-2.5 text-[12.5px] text-ink-dim">
                    {run.result.completion}
                  </p>
                )}
              </Stage>

              <Stage
                n={7}
                title="Audit"
                last
                state={run.audited ? 'done' : run.auditPending ? 'failed' : run.result && running ? 'active' : 'idle'}
              >
                {run.result && (
                  <ul className="space-y-1 text-[12.5px]">
                    <AuditLine ok label="Payment settled" />
                    <AuditLine ok={Boolean(run.settled)} label="Hedera transaction" href={run.settled?.explorer} />
                    <AuditLine
                      ok={Boolean(run.audited)}
                      pending={!run.audited && running}
                      label={run.audited ? `HCS audit recorded, message #${run.audited.sequence}` : 'HCS audit record'}
                      href={run.audited ? hashscanUrl('topic', run.audited.topic) : undefined}
                    />
                  </ul>
                )}
                {run.auditPending && (
                  <p className="mt-1 text-[12px] text-warn">
                    The receipt hasn't reached the topic yet. It shows up in Activity once it does.
                  </p>
                )}
                {run.audited && activityEvent && (
                  <Button size="sm" variant="ghost" className="mt-1.5" onClick={() => ui.openEvent(activityEvent)}>
                    Open in activity
                  </Button>
                )}
              </Stage>
            </ol>
          </>
        )}

        {run?.error && (
          <p className="copy mt-4 rounded-md border border-blocked/40 bg-blocked/[0.07] px-3 py-2.5 text-[12.5px] text-blocked">
            {run.error}
          </p>
        )}
      </div>

      <ModalFoot>
        <Button variant="ghost" disabled={running} onClick={onClose}>
          Close
        </Button>
        <Button variant="primary" disabled={!canRun} onClick={start}>
          {running ? 'Running…' : run ? 'Run again' : 'Run task'}
        </Button>
      </ModalFoot>
    </Modal>
  )
}

/** What a compute payment bought: the running container and its deadline. */
function ResourceCard({ resource, onOpen }: { resource: ComputeResource; onOpen: () => void }) {
  const expires = new Date(resource.expires_at)
  return (
    <div className="rounded-md border border-authority/25 bg-sunken px-3 py-2.5 text-[12.5px]">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
        <Fact k="Container" v={resource.name} />
        <Fact k="Image" v={resource.image} />
        <Fact k="Removed at" v={expires.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} />
        <Fact k="Payments" v={String(resource.paid_by.length)} />
      </dl>
      <Link
        to="/services"
        onClick={onOpen}
        className="mt-2 inline-block text-authority underline-offset-2 hover:underline focus-visible:underline active:opacity-70"
      >
        Watch it in Services
      </Link>
    </div>
  )
}

type StageState = 'idle' | 'active' | 'done' | 'failed'

function Stage({
  n,
  title,
  state,
  last,
  children,
}: {
  n: number
  title: string
  state: StageState
  last?: boolean
  children?: ReactNode
}) {
  return (
    <li className="relative flex gap-3.5 pb-5 last:pb-0">
      {!last && <span aria-hidden className="absolute top-6 bottom-0 left-[11px] w-px bg-line" />}
      <span
        className={cx(
          'numeric relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[11px]',
          state === 'done' && 'border-authority/50 bg-authority/15 text-authority',
          state === 'active' && 'border-authority/60 bg-surface text-authority',
          state === 'failed' && 'border-blocked/50 bg-blocked/15 text-blocked',
          state === 'idle' && 'border-line bg-surface text-faint',
        )}
      >
        {state === 'done' ? (
          <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden>
            <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        ) : state === 'failed' ? (
          <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden>
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        ) : (
          n
        )}
        {state === 'active' && (
          <span aria-hidden className="absolute inset-0 animate-ping rounded-full border border-authority/40" />
        )}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className={cx('text-[13px] font-medium', state === 'idle' ? 'text-faint' : 'text-ink')}>{title}</p>
        {children && <div className="mt-1.5">{children}</div>}
      </div>
    </li>
  )
}

function AuditLine({ ok, pending, label, href }: { ok: boolean; pending?: boolean; label: string; href?: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={cx('w-3 text-center font-semibold', ok ? 'text-authority' : pending ? 'text-faint' : 'text-warn')}>
        {ok ? '✓' : pending ? '…' : '!'}
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-ink hover:text-authority focus-visible:underline active:opacity-70"
        >
          {label}
        </a>
      ) : (
        <span className="text-ink">{label}</span>
      )}
    </li>
  )
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-faint">{k}</dt>
      <dd className="numeric text-ink">{v}</dd>
    </div>
  )
}
