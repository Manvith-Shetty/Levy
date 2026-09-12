import { useEffect, type ReactNode } from 'react'
import { cx } from '../../lib/utils'

export function Modal({
  open,
  onClose,
  children,
  labelledBy,
  width = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  labelledBy?: string
  width?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-60 flex items-start justify-center overflow-y-auto p-4 sm:p-8">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="fixed inset-0 bg-[#040507]/80 backdrop-blur-[2px]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cx(
          'animate-enter relative my-auto w-full rounded-xl border border-line bg-surface shadow-[var(--shadow-floating)]',
          width,
        )}
      >
        {children}
      </div>
    </div>
  )
}

export function ModalHead({
  title,
  hint,
  onClose,
  id,
  children,
}: {
  title: ReactNode
  hint?: ReactNode
  onClose: () => void
  id?: string
  children?: ReactNode
}) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-hairline px-6 py-5">
      <div className="min-w-0">
        <h2 id={id} className="text-[17px] font-semibold text-ink">
          {title}
        </h2>
        {hint && <p className="mt-1 text-[13px] leading-5 text-muted">{hint}</p>}
        {children}
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
  )
}

export function ModalFoot({ children }: { children: ReactNode }) {
  return (
    <footer className="flex items-center justify-between gap-3 border-t border-hairline px-6 py-4">
      {children}
    </footer>
  )
}
