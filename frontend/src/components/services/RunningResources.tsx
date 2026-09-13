import { useEffect, useState } from 'react'
import { useToast } from '../../app/toast'
import { useUI } from '../../app/ui'
import { config } from '../../lib/config'
import { getResources, stopResource, type ComputeResource, type ProviderResources } from '../../lib/live/runner'
import { cx } from '../../lib/utils'
import { Button } from '../common/Button'
import { Card, CardHead } from '../common/Card'

const POLL_MS = config.resourcesPollMs

function timeLeft(expiresAt: string, now: number): string {
  const ms = new Date(expiresAt).getTime() - now
  if (ms <= 0) return 'ending'
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}:${String(s).padStart(2, '0')}`
}

/**
 * Containers agents have paid for, across every compute provider the runner
 * discovered: what's running, for whom, and how long its prepaid time lasts.
 */
export function RunningResources() {
  const { push } = useToast()
  const ui = useUI()
  const [providers, setProviders] = useState<ProviderResources[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [stopping, setStopping] = useState<string | null>(null)

  useEffect(() => {
    if (!config.runnerEnabled) return
    let cancelled = false
    const load = () => {
      if (document.hidden) return
      getResources()
        .then((list) => {
          if (cancelled) return
          setProviders(list)
          setError(null)
        })
        .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
    }
    load()
    const poll = setInterval(load, POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      cancelled = true
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [])

  if (!config.runnerEnabled || (providers && providers.length === 0 && !error)) return null

  const rows = (providers ?? []).flatMap((p) => (p.resources ?? []).map((r) => ({ ...r, baseUrl: p.base_url, provider: p.provider })))

  async function stop(baseUrl: string, resource: ComputeResource) {
    setStopping(resource.id)
    try {
      await stopResource(baseUrl, resource.id)
      setProviders((prev) =>
        (prev ?? []).map((p) => ({ ...p, resources: (p.resources ?? []).filter((r) => r.id !== resource.id) })),
      )
      push({ tone: 'blocked', title: 'Container stopped', body: `${resource.name} was removed. The teardown is recorded on HCS.` })
    } catch (e) {
      push({ tone: 'blocked', title: 'Not stopped', body: e instanceof Error ? e.message : String(e) })
    } finally {
      setStopping(null)
    }
  }

  return (
    <Card className="mb-8">
      <CardHead
        title="Running now"
        hint="Containers agents paid for. Each one is removed when its prepaid time ends, or as soon as its agent's authority is revoked."
      />
      {error && <p className="mt-3 text-[12.5px] text-warn">{error}</p>}
      {!error && rows.length === 0 && (
        <p className="copy mt-3 text-[13px] text-muted">
          Nothing is running. Give an agent a compute task, like "Run a Redis cache for 10 minutes".
        </p>
      )}
      {rows.length > 0 && (
        <ul className="mt-4 divide-y divide-hairline">
          {rows.map((r) => {
            const left = timeLeft(r.expires_at, now)
            return (
              <li key={r.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-[13px]">
                      <span
                        className={cx('h-1.5 w-1.5 rounded-full', r.status === 'running' ? 'bg-authority' : 'bg-idle')}
                        aria-hidden
                      />
                      <span className="font-mono text-ink">{r.name}</span>
                      <span className="text-faint">{r.status}</span>
                    </p>
                    <p className="mt-0.5 text-[12px] text-muted">
                      <span className="font-mono">{r.image}</span> · paid by <span className="text-ink-dim">{r.agent}</span> ·{' '}
                      {r.paid_by.length} payment{r.paid_by.length === 1 ? '' : 's'} · {r.provider}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="numeric mr-1 text-[15px] font-semibold text-ink" title={`Removed at ${new Date(r.expires_at).toLocaleTimeString()}`}>
                      {left}
                    </span>
                    <Button
                      size="sm"
                      disabled={r.status !== 'running'}
                      onClick={() =>
                        ui.openRun(r.agent, {
                          service: 'compute',
                          prompt: `Keep ${r.name} running for 5 more minutes.`,
                          job: { image: '', command: '', minutes: 5, extend: r.id },
                          provider: r.baseUrl,
                        })
                      }
                    >
                      Add 5 min
                    </Button>
                    <Button size="sm" variant="danger" disabled={stopping === r.id} onClick={() => stop(r.baseUrl, r)}>
                      {stopping === r.id ? 'Stopping…' : 'Stop'}
                    </Button>
                  </div>
                </div>
                {r.logs && (
                  <details className="group mt-2">
                    <summary className="press cursor-pointer list-none text-[12px] text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-authority/60">
                      <span className="inline-block transition-transform duration-200 group-open:rotate-90">›</span> Output
                    </summary>
                    <pre className="mt-1.5 max-h-40 overflow-auto rounded-md border border-hairline bg-sunken px-3 py-2 font-mono text-[11.5px] leading-5 text-ink-dim">
                      {r.logs}
                    </pre>
                  </details>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
