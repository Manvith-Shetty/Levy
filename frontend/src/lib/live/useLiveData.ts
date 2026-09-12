import { useCallback, useEffect, useRef, useState } from 'react'
import { config } from '../config'
import { getManifest, getReceipts, getRefusals } from '../gateway/api'
import type { LiveSnapshot, SourceKey } from './adapter'
import { loadTree } from './ens'
import { readAccount, readTopic } from './hedera'

function message(error: unknown): string {
  if (error instanceof Error) return (error as Error & { shortMessage?: string }).shortMessage ?? error.message
  return String(error)
}

/**
 * Polls every live source in parallel. A source that fails keeps its last
 * good value and reports an error, so one flaky RPC never blanks the page.
 */
export function useLiveData(enabled: boolean) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const inFlight = useRef<Promise<void> | null>(null)
  const last = useRef<LiveSnapshot | null>(null)

  const refresh = useCallback(async () => {
    if (inFlight.current) return inFlight.current
    const run = (async () => {
      setRefreshing(true)
      const prev = last.current
      const errors: Partial<Record<SourceKey, string>> = {}

      const [ens, manifest, receipts, refusals] = await Promise.allSettled([
        loadTree(),
        config.gatewayEnabled ? getManifest() : Promise.reject(new Error('Gateway reads disabled')),
        config.gatewayEnabled ? getReceipts() : Promise.resolve([]),
        config.gatewayEnabled ? getRefusals() : Promise.resolve([]),
      ])
      if (ens.status === 'rejected') errors.ens = message(ens.reason)
      if (manifest.status === 'rejected' && config.gatewayEnabled) errors.gateway = message(manifest.reason)

      const manifestValue = manifest.status === 'fulfilled' ? manifest.value : prev?.manifest
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
        gatewayReceipts: receipts.status === 'fulfilled' ? receipts.value : (prev?.gatewayReceipts ?? []),
        gatewayRefusals: refusals.status === 'fulfilled' ? refusals.value : (prev?.gatewayRefusals ?? []),
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
    const timer = setInterval(() => void refresh(), config.pollMs)
    return () => clearInterval(timer)
  }, [enabled, refresh])

  return { snapshot, refreshing, refresh }
}
