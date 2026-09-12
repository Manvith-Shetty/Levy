import { useEffect, type ReactNode } from 'react'

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50">
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 bg-[#040507]/70"
      />
      <aside
        role="dialog"
        aria-modal="true"
        className="animate-slide-in absolute top-0 right-0 flex h-full w-[min(26rem,100vw)] flex-col border-l border-line bg-surface shadow-[var(--shadow-floating)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-ink">{title}</h2>
            {subtitle && <div className="mt-1.5">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="wash press -mt-1 -mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-faint hover:text-ink"
          >
            <svg viewBox="0 0 14 14" className="h-3.5 w-3.5">
              <path d="M2 2l10 10M12 2L2 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <footer className="border-t border-hairline px-5 py-4">{footer}</footer>}
      </aside>
    </div>
  )
}

/** Label/value row used throughout the drawers. */
export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-hairline py-2.5 last:border-0">
      <dt className="text-[12.5px] text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-[13px] text-ink">{children}</dd>
    </div>
  )
}
