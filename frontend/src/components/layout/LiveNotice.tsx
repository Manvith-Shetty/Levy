import { useLeash } from '../../lib/store'

const SOURCE_LABEL = {
  ens: 'ENS tree (Sepolia)',
  hcs: 'HCS topic (Hedera mirror node)',
  gateway: 'Gateway',
  payer: 'Shared wallet balance',
} as const

/**
 * Anything the live data can't be trusted for right now: a source that
 * didn't answer, or a configuration that will make payments fail. The
 * gateway being offline is normal (HCS carries the same records), so it's
 * only mentioned when HCS is down too.
 */
export function LiveNotice() {
  const { live } = useLeash()
  if (!live.active || !live.ready) return null

  const errors = Object.entries(live.errors).filter(
    ([key]) => key !== 'gateway' || live.errors.hcs,
  ) as Array<[keyof typeof SOURCE_LABEL, string]>
  if (errors.length === 0 && live.warnings.length === 0) return null

  return (
    <div className="mb-6 space-y-2">
      {errors.map(([key, error]) => (
        <p
          key={key}
          className="rounded-lg border border-warn/30 bg-warn/[0.06] px-4 py-3 text-[13px] text-warn"
        >
          <span className="font-medium">{SOURCE_LABEL[key]} didn't answer.</span>{' '}
          <span className="text-ink-dim">Showing the last data it returned. {error}</span>
        </p>
      ))}
      {live.warnings.map((warning) => (
        <p
          key={warning}
          className="copy rounded-lg border border-warn/30 bg-warn/[0.06] px-4 py-3 text-[13px] text-ink-dim"
        >
          <span className="font-medium text-warn">Heads up — </span>
          {warning}
        </p>
      ))}
    </div>
  )
}
