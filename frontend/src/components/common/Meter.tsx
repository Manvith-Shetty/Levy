import { cx, money, ratio } from '../../lib/utils'

type Size = 'xs' | 'sm' | 'md' | 'lg'

const HEIGHT: Record<Size, string> = {
  xs: 'h-1',
  sm: 'h-1.5',
  md: 'h-2.5',
  lg: 'h-4',
}

/**
 * The authority meter — the one visual idea repeated everywhere in Leash.
 *
 *   ▓▓▓▓▓▓ spent, by this agent or anything beneath it
 *   ▒▒▒▒▒▒ delegated to children and not yet spent by them
 *   ░░░░░░ free to spend or delegate
 *
 * Reading left to right it says: what's gone, what's committed, what's left.
 */
export function AuthorityMeter({
  authority,
  spent,
  reserved = 0,
  size = 'md',
  muted = false,
  className,
}: {
  authority: number
  spent: number
  reserved?: number
  size?: Size
  /** Revoked or expired agents lose their colour but keep their shape. */
  muted?: boolean
  className?: string
}) {
  const spentPct = ratio(spent, authority) * 100
  const delegatedPct = Math.max(0, Math.min(100 - spentPct, ratio(reserved, authority) * 100))
  const utilization = ratio(spent, authority)

  const spentTone = muted
    ? 'bg-idle/60'
    : utilization >= 0.8
      ? 'bg-warn'
      : 'bg-authority'

  return (
    <div
      className={cx(
        'flex w-full overflow-hidden rounded-full bg-[#191c22]',
        HEIGHT[size],
        className,
      )}
    >
      <div className={spentTone} style={{ width: `${spentPct}%` }} />
      <div
        className={muted ? 'bg-idle/25' : 'bg-delegated/55'}
        style={{
          width: `${delegatedPct}%`,
          backgroundImage: muted
            ? undefined
            : 'repeating-linear-gradient(115deg, rgba(122,107,255,0.95) 0 3px, rgba(122,107,255,0.42) 3px 6px)',
        }}
      />
    </div>
  )
}

export function MeterLegend({
  spent,
  reserved,
  free,
  className,
}: {
  spent: number
  reserved: number
  free: number
  className?: string
}) {
  const items = [
    { label: 'Spent', value: spent, swatch: 'bg-authority' },
    { label: 'Delegated, unspent', value: reserved, swatch: 'bg-delegated/70' },
    { label: 'Free', value: free, swatch: 'bg-[#2b2f37]' },
  ]
  return (
    <dl className={cx('flex flex-wrap gap-x-6 gap-y-2', className)}>
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-2">
          <span className={cx('inline-block h-2 w-2 shrink-0 translate-y-px rounded-sm', item.swatch)} />
          <dt className="text-[12px] text-muted">{item.label}</dt>
          <dd className="numeric text-[13px] font-medium text-ink">{money(item.value)}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A plain single-value bar for limits and quotas. */
export function LimitBar({
  used,
  limit,
  tone,
  className,
}: {
  used: number
  limit: number
  tone?: 'authority' | 'warn' | 'blocked'
  className?: string
}) {
  const pct = ratio(used, limit) * 100
  const auto = pct >= 90 ? 'blocked' : pct >= 70 ? 'warn' : 'authority'
  const resolved = tone ?? auto
  const colors = {
    authority: 'bg-authority',
    warn: 'bg-warn',
    blocked: 'bg-blocked',
  }
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-[#191c22]', className)}>
      <div
        className={cx(
          'h-full w-full origin-left rounded-full transition-transform duration-500 ease-[var(--ease-out-soft)]',
          colors[resolved],
        )}
        style={{ transform: `scaleX(${pct / 100})` }}
      />
    </div>
  )
}
