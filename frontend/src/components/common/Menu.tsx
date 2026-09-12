import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from '../../lib/utils'

export interface MenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

export function Menu({ items, label = 'Actions' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          'wash press flex h-7 w-7 items-center justify-center rounded-md',
          open ? 'bg-raised text-ink' : 'text-faint hover:text-ink',
        )}
      >
        <svg viewBox="0 0 4 16" className="h-3.5 w-3.5" aria-hidden>
          <circle cx="2" cy="3" r="1.4" fill="currentColor" />
          <circle cx="2" cy="8" r="1.4" fill="currentColor" />
          <circle cx="2" cy="13" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="animate-enter absolute top-8 right-0 z-30 w-44 overflow-hidden rounded-lg border border-line bg-raised py-1 shadow-[var(--shadow-floating)]">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onSelect()
              }}
              className={cx(
                'press block w-full px-3 py-1.5 text-left text-[12.5px] disabled:pointer-events-none disabled:opacity-35',
                item.danger
                  ? 'wash text-blocked'
                  : 'wash text-ink-dim hover:text-ink',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function IconButton({
  label,
  onClick,
  children,
  className,
}: {
  label: string
  onClick: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cx(
        'wash press flex h-8 w-8 items-center justify-center rounded-md border border-line bg-raised text-muted hover:border-line-strong hover:text-ink',
        className,
      )}
    >
      {children}
    </button>
  )
}
