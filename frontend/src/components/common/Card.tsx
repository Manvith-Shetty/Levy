import type { ReactNode } from 'react'
import { cx } from '../../lib/utils'

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  return (
    <section
      className={cx(
        'rounded-xl border border-line bg-surface shadow-[var(--shadow-raised)]',
        padded && 'p-5',
        className,
      )}
    >
      {children}
    </section>
  )
}

export function CardHead({
  title,
  hint,
  action,
  className,
}: {
  title: ReactNode
  hint?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cx('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {hint && <p className="mt-1 text-[12.5px] leading-5 text-muted">{hint}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/** Small caption used above dense figures. Sentence case, never tracked-out caps. */
export function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('text-[12px] leading-4 text-faint', className)}>{children}</p>
}

export function Figure({
  value,
  label,
  tone = 'text-ink',
  size = 'md',
}: {
  value: ReactNode
  label?: ReactNode
  tone?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
}) {
  const sizes = {
    sm: 'text-[15px]',
    md: 'text-[19px]',
    lg: 'text-[26px]',
    xl: 'text-[38px]',
  }
  return (
    <div>
      {label && <Caption className="mb-1">{label}</Caption>}
      <p className={cx('numeric font-semibold', sizes[size], tone)}>{value}</p>
    </div>
  )
}
