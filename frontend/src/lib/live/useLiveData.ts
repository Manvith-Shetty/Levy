import { useCallback, useEffect, useRef, useState } from 'react'
import { config } from '../config'
import { getManifest, getReceipts, getRefusals } from '../gateway/api'
import type { Receipt, Refusal, ServiceManifest } from '../gateway/types'
import type { LiveSnapshot, SourceKey } from './adapter'
import { loadTree } from './ens'
import { readAccount, readTopic } from './hedera'

function message(error: unknown): string {
  if (error instanceof Error) return (error as Error & { shortMessage?: string }).shortMessage ?? error.message
  return String(error)
}

/** Longest wait between retries of a gateway that isn't answering. */
const GATEWAY_BACKOFF_CAP_MS = 5 * 60_000

interface GatewayRound {
  manifest: ServiceManifest
  receipts?: Receipt[]
  refusals?: Refusal[]
}

/**
 * The gateway is optional — HCS carries the same receipts and refusals — so
 * it's probed with one request (the manifest) and only asked for the rest
 * when it answers.
 */
async function readGateway(): Promise<GatewayRound> {
  const manifest = await getManifest()
  const [receipts, refusals] = await Promise.allSettled([getReceipts(), getRefusals()])
  return {
    manifest,
    receipts: receipts.status === 'fulfilled' ? receipts.value : undefined,
    refusals: refusals.status === 'fulfilled' ? refusals.value : undefined,
  }
}

/**
 * Polls every live source in parallel. A source that fails keeps its last
 * good value and reports an error, so one flaky RPC never blanks the page.
 *
 * A gateway that doesn't answer is retried with exponential backoff instead
 * of every poll, and nothing polls while the tab is hidden.
 */
export function useLiveData(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const inFlight = useRef<Promise<void> | null>(null)
  const last = useRef<LiveSnapshot | null>(null)
  const gateway = useRef({ failures: 0, retryAt: 0, error: undefined as string | undefined })

  /** `force` retries the gateway even while it's backing off. */
  const refresh = useCallback(async (force = false) => {
    if (inFlight.current) return inFlight.current
    const run = (async () => {
      setRefreshing(true)
      const prev = last.current
      const errors: Partial<Record<SourceKey, string>> = {}

      const g = gateway.current
      const askGateway = config.gatewayEnabled && (force || Date.now() >= g.retryAt)

      const [ens, gw] = await Promise.allSettled([
        loadTree(),
        askGateway ? readGateway() : Promise.resolve(null),
      ])
      if (ens.status === 'rejected') errors.ens = message(ens.reason)

      let round: GatewayRound | null = null
      if (gw.status === 'fulfilled' && gw.value) {
        round = gw.value
        g.failures = 0
        g.retryAt = 0
        g.error = undefined
      } else if (gw.status === 'rejected') {
        g.failures += 1
        const wait = Math.min(config.pollMs * 2 ** g.failures, GATEWAY_BACKOFF_CAP_MS)
        g.retryAt = Date.now() + wait
        g.error = `${message(gw.reason)} — retrying in ${Math.round(wait / 1000)}s`
      }
      // Still backing off: keep reporting why, so Settings stays honest.
      if (config.gatewayEnabled && g.error) errors.gateway = g.error

      const manifestValue = round?.manifest ?? prev?.manifest
      const topicId = config.hcsTopicId || manifestValue?.receipts_topic || undefined

      const [topic, payer] = await Promise.allSettled([
        topicId ? readTopic(topicId) : Promise.resolve([]),
        config.payerAccount ? readAccount(config.payerAccount) : Promise.reject(new Error('No payer account configured')),
      ])
      if (topic.status === 'rejected') errors.hcs = message(topic.reason)
      if (payer.status === 'rejected') errors.payer = message(payer.reason)

      const next: LiveSnapshot = {
        ens: ens.status === 'fulfilled' ? ens.value : prev?.ens,
        manifest: manifestValue,
        gatewayReceipts: round?.receipts ?? prev?.gatewayReceipts ?? [],
        gatewayRefusals: round?.refusals ?? prev?.gatewayRefusals ?? [],
        topic: topic.status === 'fulfilled' ? topic.value : (prev?.topic ?? []),
        topicId,
        payer: payer.status === 'fulfilled' ? payer.value : prev?.payer,
        errors,
        fetchedAt: Date.now(),
      }
      last.current = next
      setSnapshot(next)
      setRefreshing(false)
    })()
    inFlight.current = run
    try {
      await run
    } finally {
      inFlight.current = null
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    const timer = setInterval(() => {
      if (!document.hidden) void refresh()
    }, config.pollMs)
    // Catch up as soon as the tab is visible again, instead of waiting a tick.
    const onVisible = () => {
      if (!document.hidden) void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, refresh])

  return { snapshot, refreshing, refresh }
}
