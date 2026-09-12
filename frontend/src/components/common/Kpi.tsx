import type { ReactNode } from 'react'
import { cx } from '../../lib/utils'

/**
 * KPI tile. The figure leads; the footnote is the sentence that makes it mean
 * something. No eyebrow labels in caps — the label sits quietly above.
 */
export function Kpi({
  label,
  value,
  footnote,
  tone = 'text-ink',
  chart,
}: {
  label: string
  value: ReactNode
  footnote?: ReactNode
  tone?: string
  chart?: ReactNode
}) {
  return (
    <div className="flex flex-col justify-between rounded-xl border border-line bg-surface p-4 shadow-[var(--shadow-raised)]">
      <p className="text-[12.5px] text-muted">{label}</p>
      <p className={cx('numeric mt-2.5 text-[30px] leading-none font-semibold', tone)}>{value}</p>
      <div className="mt-3 min-h-[18px]">
        {chart}
        {footnote && <p className="text-[12px] leading-4 text-faint">{footnote}</p>}
      </div>
    </div>
  )
}
