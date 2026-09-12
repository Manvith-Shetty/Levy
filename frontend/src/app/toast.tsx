import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { cx } from '../lib/utils'

export type ToastTone = 'success' | 'blocked' | 'info'

export interface Toast {
  id: string
  tone: ToastTone
  title: string
  body?: string
}

interface ToastContextValue {
  push: (toast: Omit<Toast, 'id'>) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    setToasts((prev) => [...prev.slice(-3), { ...toast, id }])
  }, [])

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const value = useMemo(() => ({ push }), [push])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed right-5 bottom-5 z-[70] flex w-[min(22rem,calc(100vw-2.5rem))] flex-col gap-2">
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

const TONE: Record<ToastTone, { mark: string; ring: string; text: string }> = {
  success: { mark: '✓', ring: 'border-authority/40', text: 'text-authority' },
  blocked: { mark: '✕', ring: 'border-blocked/45', text: 'text-blocked' },
  info: { mark: '•', ring: 'border-delegated/40', text: 'text-delegated' },
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5200)
    return () => clearTimeout(timer)
  }, [onDismiss])

  const tone = TONE[toast.tone]

  return (
    <div
      role="status"
      className={cx(
        'animate-toast-in pointer-events-auto flex gap-3 rounded-lg border bg-raised/95 p-3.5 shadow-[var(--shadow-floating)] backdrop-blur',
        tone.ring,
      )}
    >
      <span className={cx('mt-px font-display text-sm leading-5', tone.text)}>{tone.mark}</span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-5 font-medium text-ink">{toast.title}</p>
        {toast.body && <p className="mt-0.5 text-[12px] leading-5 text-muted">{toast.body}</p>}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mt-1 -mr-1 h-6 w-6 shrink-0 rounded text-faint hover:text-ink"
      >
        ×
      </button>
    </div>
  )
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside <ToastProvider>')
  return value
}
