import type { ReactNode } from 'react'
import { cx } from '../../lib/utils'

export function EmptyState({
  title,
  body,
  action,
  className,
}: {
  title: string
  body: string
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-line px-6 py-12 text-center',
        className,
      )}
    >
      <p className="text-[14px] font-medium text-ink">{title}</p>
      <p className="mt-1.5 max-w-[38ch] text-[13px] leading-5 text-muted">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
