import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useToast } from '../../app/toast'
import { useUI } from '../../app/ui'
import { config, hashscanUrl } from '../../lib/config'
import {
  fromAtomic,
  getRunner,
  readRequirements,
  runAgent,
  type RunnerInfo,
  type RunStep,
} from '../../lib/live/runner'
import { useLeash } from '../../lib/store'
import { cx, money } from '../../lib/utils'
import { Button } from '../common/Button'
import { Label, MoneyInput, Select, Textarea } from '../common/Field'
import { Modal, ModalFoot, ModalHead } from '../common/Modal'

const DEFAULT_PROMPT = "Explain Hedera's hashgraph consensus in three sentences."
/** How long to keep asking the mirror node for the run's HCS message. */
const AUDIT_WAIT_MS = 60_000

type Of<K extends RunStep['step']> = Extract<RunStep, { step: K }>

interface Run {
  start?: Of<'start'>
  quotes: Of<'quote'>[]
  failed: Of<'quote_failed'>[]
  overBudget?: Of<'over_budget'>
  selected?: Of<'selected'>
  challenge?: Of<'payment_required'>
  refused?: Of<'refused'>
  paying?: Of<'paying'>
  settled?: Of<'settled'>
  result?: Of<'result'>
  error?: string
  done?: Of<'done'>
}

const EMPTY: Run = { quotes: [], failed: [] }

function reduce(run: Run, step: RunStep): Run {
  switch (step.step) {
    case 'quote':
      return { ...run, quotes: [...run.quotes, step] }
    case 'quote_failed':
      return { ...run, failed: [...run.failed, step] }
    case 'over_budget':
      return { ...run, overBudget: step }
    case 'payment_required':
      return { ...run, challenge: step }
    case 'error':
      return { ...run, error: step.message }
    default:
      return { ...run, [step.step]: step }
  }
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
}: {
  open: boolean
  onClose: () => void
  agentId?: string
}) {
  const { agents, events, live } = useLeash()
  const { push } = useToast()
  const ui = useUI()

  const choices = useMemo(() => agents.filter((a) => a.parentId), [agents])
  const fallback = choices.find((a) => a.id === 'sub.agent.root')?.id ?? choices[0]?.id ?? ''
  const [agent, setAgent] = useState(agentId && agents.some((a) => a.id === agentId) ? agentId : fallback)
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [cap, setCap] = useState<number | ''>('')
  const [runner, setRunner] = useState<RunnerInfo | null>(null)
  const [runnerError, setRunnerError] = useState<string | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [running, setRunning] = useState(false)
  const [auditTimedOut, setAuditTimedOut] = useState(false)
  const abort = useRef<AbortController | null>(null)

  const assetDecimals = config.assetDecimals
  const maxCap = runner ? runner.max_atomic / 10 ** assetDecimals : undefined

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    getRunner(controller.signal)
      .then((info) => {
        setRunner(info)
        setRunnerError(null)
        setCap((c) => (c === '' ? info.max_atomic / 10 ** assetDecimals : c))
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setRunnerError(error instanceof Error ? error.message : String(error))
      })
    return () => controller.abort()
  }, [open, assetDecimals])

  useEffect(() => () => abort.current?.abort(), [])

  // The run's own HCS message: a receipt carries the settlement's tx id, a
  // refusal carries the quote id.
  const audit = useMemo(() => {
    if (!run?.selected || !(run.settled || run.refused)) return null
    const quote = run.selected.quote_id
    const entry = live.snapshot?.topic.find((t) =>
      t.kind === 'receipt'
        ? sameTx(t.body.transaction_id, run.settled?.transaction) || t.body.quote_id === quote
        : t.body.quote_id === quote,
    )
    const event = events.find((e) =>
      run.settled ? sameTx(e.txId, run.settled.transaction) : e.id === `rfsl_${quote}`,
    )
    return { entry, event }
  }, [run, live.snapshot, events])

  const waitingForAudit = Boolean(run?.done && audit && !audit.entry && !auditTimedOut)

  // Give up on the mirror node a minute after the run ends.
  const finished = Boolean(run?.done)
  useEffect(() => {
    if (!finished) return
    const timer = setTimeout(() => setAuditTimedOut(true), AUDIT_WAIT_MS)
    return () => clearTimeout(timer)
  }, [finished])

  // Nudge the mirror node until the run's message shows up (a few seconds).
  useEffect(() => {
    if (!waitingForAudit) return
    const timer = setInterval(() => void live.refresh(true), 4_000)
    return () => clearInterval(timer)
  }, [waitingForAudit, live])

  const capAtomic = typeof cap === 'number' ? Math.round(cap * 10 ** assetDecimals) : 0
  const capValid = typeof cap === 'number' && cap > 0 && (!runner || capAtomic <= runner.max_atomic)
  const canRun = Boolean(runner && agent && prompt.trim() && capValid && !running)

  async function start() {
    if (!canRun) return
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    let acc: Run = EMPTY
    setRun(EMPTY)
    setAuditTimedOut(false)
    setRunning(true)
    try {
      await runAgent(
        { agent, prompt: prompt.trim(), budget_atomic: capAtomic },
        (step) => {
          acc = reduce(acc, step)
          setRun(acc)
        },
        controller.signal,
      )
      if (acc.result) {
        const { charged, asset, provider } = acc.result
        push({ tone: 'success', title: 'Payment settled', body: `${agent} paid ${money(fromAtomic(charged, asset))} to ${provider}.` })
      } else if (acc.refused) {
        push({ tone: 'blocked', title: 'Payment refused', body: `${agent} was stopped by its mandate. Nothing was paid.` })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        acc = { ...acc, error: error instanceof Error ? error.message : String(error) }
        setRun(acc)
      }
    } finally {
      setRunning(false)
      if (acc.settled || acc.refused) void live.refresh(true)
    }
  }

  const sym = config.assetSymbol
  const fmt = (atomic: number, decimals = assetDecimals) => money(atomic / 10 ** decimals)
  const req = run?.challenge ? readRequirements(run.challenge.requirements) : null

  return (
    <Modal open={open} onClose={running ? () => undefined : onClose} width="max-w-2xl" labelledBy="run-agent-title">
      <ModalHead
        id="run-agent-title"
        title="Run a paid request"
        hint={`The agent finds providers, picks the cheapest quote, and pays over x402 on Hedera from the shared wallet${
          runner ? ` ${runner.payer}` : ''
        }. The gateway checks its ENS mandate before it names a price.`}
        onClose={running ? () => undefined : onClose}
      />

      <div className="max-h-[70vh] overflow-y-auto px-6 py-5">
        {runnerError && (
          <p className="copy mb-4 rounded-md border border-warn/40 bg-warn/[0.07] px-3 py-2.5 text-[12.5px] text-warn">
            {runnerError}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-[1fr_180px]">
          <div>
            <Label htmlFor="run-agent">Agent</Label>
            <Select id="run-agent" value={agent} disabled={running} onChange={(e) => setAgent(e.target.value)}>
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}
                  {a.status === 'revoked' ? ' (revoked)' : a.status === 'suspended' ? ' (parent revoked)' : ''}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="run-cap" hint={maxCap !== undefined ? `Up to ${money(maxCap)}` : undefined}>
              Spend cap
            </Label>
            <MoneyInput id="run-cap" value={cap} onValueChange={setCap} invalid={cap !== '' && !capValid} />
          </div>
        </div>
        <div className="mt-4">
          <Label htmlFor="run-prompt">Prompt</Label>
          <Textarea
            id="run-prompt"
            value={prompt}
            disabled={running}
            maxLength={2000}
            onChange={(e) => setPrompt((e.target as unknown as HTMLTextAreaElement).value)}
          />
        </div>

        {run && (
          <ol className="mt-6 space-y-0">
            <Step
              n={1}
              title="Discover providers"
              state={run.quotes.length || run.failed.length ? 'done' : running ? 'active' : 'idle'}
            >
              {run.quotes.length > 0 && (
                <div className="mt-2 overflow-x-auto rounded-md border border-hairline">
                  <table className="w-full text-[12.5px]">
                    <thead className="text-left text-faint">
                      <tr className="border-b border-hairline">
                        <th className="px-3 py-2 font-normal">Provider</th>
                        <th className="px-3 py-2 font-normal">Per 1k tokens in / out</th>
                        <th className="px-3 py-2 text-right font-normal">Quote</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.quotes.map((q) => {
                        const chosen = run.selected?.provider === q.provider
                        return (
                          <tr key={q.base_url} className={cx('border-b border-hairline last:border-0', chosen && 'bg-authority/[0.06]')}>
                            <td className="px-3 py-2">
                              <span className={cx('font-medium', chosen ? 'text-authority' : 'text-ink')}>{q.provider}</span>
                              <span className="ml-2 font-mono text-[11.5px] text-faint">{q.model}</span>
                            </td>
                            <td className="numeric px-3 py-2 text-muted">
                              {fmt(q.pricing.per_1k_input, q.asset.decimals)} / {fmt(q.pricing.per_1k_output, q.asset.decimals)}
                            </td>
                            <td className="numeric px-3 py-2 text-right text-ink">{fmt(q.amount, q.asset.decimals)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {run.quotes[0] && (
                <p className="mt-1.5 text-[12px] text-faint">
                  {run.quotes[0].input_tokens} input tokens, up to {run.quotes[0].max_output_tokens} output. Each provider
                  prices this prompt from its per-token rates.
                </p>
              )}
              {run.failed.map((f) => (
                <p key={f.base_url} className="mt-1 text-[12px] text-warn">
                  {f.base_url} didn't answer: {f.message}
                </p>
              ))}
            </Step>

            <Step
              n={2}
              title="Pick the cheapest quote under the cap"
              state={run.overBudget ? 'failed' : run.selected ? 'done' : run.quotes.length && running ? 'active' : 'idle'}
            >
              {run.selected && (
                <p className="text-[12.5px] text-muted">
                  Chose <span className="text-ink">{run.selected.provider}</span> at{' '}
                  <span className="numeric text-ink">{fmt(run.selected.amount, run.selected.asset.decimals)}</span>
                  {run.selected.passed_over > 0 && `, passing over ${run.selected.passed_over} dearer offer${run.selected.passed_over > 1 ? 's' : ''}`}.
                </p>
              )}
              {run.overBudget && (
                <p className="text-[12.5px] text-blocked">
                  The cheapest quote is {fmt(run.overBudget.cheapest, run.overBudget.asset.decimals)}, above the{' '}
                  {fmt(run.overBudget.budget_atomic, run.overBudget.asset.decimals)} cap. Nothing was asked of the gateway.
                </p>
              )}
            </Step>

            <Step
              n={3}
              title="Check the mandate"
              state={run.refused && !run.paying ? 'failed' : run.challenge ? 'done' : run.selected && running ? 'active' : 'idle'}
            >
              {run.challenge && req && (
                <p className="copy text-[12.5px] text-muted">
                  {agent} and every parent above it allow this, so the gateway answered{' '}
                  <span className="font-mono text-ink">402 Payment Required</span>: {req.amount ? fmt(Number(req.amount)) : ''}{' '}
                  {sym} to <span className="font-mono text-ink">{req.payTo}</span>, x402 {req.scheme} on {req.network}
                  {req.feePayer && (
                    <>
                      , network fee paid by Blocky402 (<span className="font-mono">{req.feePayer}</span>)
                    </>
                  )}
                  .
                </p>
              )}
              {run.refused && !run.paying && (
                <p className="copy text-[12.5px] text-blocked">
                  Refused before any price was named: {run.refused.reason}. Nothing was signed or paid.
                </p>
              )}
            </Step>

            <Step
              n={4}
              title="Sign and settle"
              state={run.settled || run.result ? 'done' : run.paying && (run.error || run.refused) ? 'failed' : run.paying ? 'active' : 'idle'}
            >
              {run.paying && !run.settled && !run.error && (
                <p className="text-[12.5px] text-muted">
                  Signing a {sym} transfer from <span className="font-mono text-ink">{run.paying.payer}</span>; Blocky402
                  submits it to Hedera…
                </p>
              )}
              {run.settled && (
                <p className="text-[12.5px] text-muted">
                  Settled as{' '}
                  <a
                    href={run.settled.explorer}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-authority underline-offset-2 hover:underline focus-visible:underline"
                  >
                    {run.settled.transaction}
                  </a>{' '}
                  from <span className="font-mono text-ink">{run.settled.payer}</span>.
                </p>
              )}
            </Step>

            <Step n={5} title="Get the result" state={run.result ? 'done' : run.settled && running ? 'active' : 'idle'}>
              {run.result && (
                <>
                  <p className="copy rounded-md border border-hairline bg-sunken px-3 py-2.5 text-[12.5px] text-ink-dim">
                    {run.result.completion}
                  </p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-4">
                    <Fact k="Tokens in" v={String(run.result.usage.input_tokens)} />
                    <Fact k="Tokens out" v={String(run.result.usage.output_tokens)} />
                    <Fact k="Charged" v={fmt(run.result.charged, run.result.asset.decimals)} />
                    <Fact k="Unused credit" v={fmt(run.result.unused_output_credit, run.result.asset.decimals)} />
                  </dl>
                </>
              )}
            </Step>

            <Step
              n={6}
              title="Record it on HCS"
              last
              state={audit?.entry ? 'done' : waitingForAudit ? 'active' : 'idle'}
            >
              {audit?.entry && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-muted">
                  <span>
                    {audit.entry.kind === 'receipt' ? 'Receipt' : 'Refusal'} is message{' '}
                    <span className="numeric text-ink">#{audit.entry.sequence}</span> on topic{' '}
                    <a
                      href={hashscanUrl('topic', live.snapshot?.topicId ?? config.hcsTopicId)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-authority underline-offset-2 hover:underline focus-visible:underline"
                    >
                      {live.snapshot?.topicId ?? config.hcsTopicId}
                    </a>
                    .
                  </span>
                  {audit.event && (
                    <Button size="sm" variant="ghost" onClick={() => ui.openEvent(audit.event!)}>
                      Open in activity
                    </Button>
                  )}
                </div>
              )}
              {waitingForAudit && (
                <p className="text-[12.5px] text-muted">Waiting for the mirror node to show the topic message…</p>
              )}
              {run.done && audit && !audit.entry && !waitingForAudit && (
                <p className="text-[12.5px] text-warn">
                  Not on the topic yet. Is the gateway publishing to HCS? It shows up in Activity once it lands.
                </p>
              )}
            </Step>
          </ol>
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
          {running ? 'Running…' : run ? 'Run again' : 'Pay and run'}
        </Button>
      </ModalFoot>
    </Modal>
  )
}

type StepState = 'idle' | 'active' | 'done' | 'failed'

function Step({
  n,
  title,
  state,
  last,
  children,
}: {
  n: number
  title: string
  state: StepState
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

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-faint">{k}</dt>
      <dd className="numeric text-ink">{v}</dd>
    </div>
  )
}
