import type { ReactNode } from 'react'
import type { AgentStatus } from '../../lib/types'
import { cx, STATUS_LABEL, STATUS_TONE } from '../../lib/utils'

export function StatusBadge({
  status,
  size = 'md',
}: {
  status: AgentStatus
  size?: 'sm' | 'md'
}) {
  const tone = STATUS_TONE[status]
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border border-line bg-raised font-medium',
        tone.text,
        size === 'sm' ? 'h-5 px-2 text-[11.5px]' : 'h-6 px-2.5 text-[12px]',
      )}
    >
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
    </span>
  )
}

export function StatusDot({ status, live = false }: { status: AgentStatus; live?: boolean }) {
  const tone = STATUS_TONE[status]
  return (
    <span className="relative inline-flex h-1.5 w-1.5 shrink-0">
      <span className={cx('h-1.5 w-1.5 rounded-full', tone.dot)} />
      {live && (
        <span className={cx('animate-ring absolute inset-0 rounded-full', tone.dot)} />
      )}
    </span>
  )
}

export function Pill({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode
  tone?: 'neutral' | 'authority' | 'delegated' | 'warn' | 'blocked'
  className?: string
}) {
  const tones = {
    neutral: 'border-line bg-raised text-ink-dim',
    authority: 'border-authority/35 bg-authority/10 text-authority',
    delegated: 'border-delegated/35 bg-delegated/10 text-delegated',
    warn: 'border-warn/35 bg-warn/10 text-warn',
    blocked: 'border-blocked/35 bg-blocked/10 text-blocked',
  }
  return (
    <span
      className={cx(
        'inline-flex h-5.5 items-center rounded border px-1.5 text-[11.5px] font-medium',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx('font-mono text-[12px] tracking-tight text-ink-dim', className)}>
      {children}
    </span>
  )
}
