import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { cx } from '../../lib/utils'

const CONTROL =
  'w-full rounded-md border border-line bg-sunken px-3 text-[13px] text-ink placeholder:text-faint hover:border-line-strong focus:border-authority/60 focus:shadow-[0_0_0_3px_rgb(53_224_174/0.14)] focus:outline-none'

export function Label({
  children,
  hint,
  htmlFor,
}: {
  children: ReactNode
  hint?: ReactNode
  htmlFor?: string
}) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-[12.5px] font-medium text-ink-dim">
        {children}
      </label>
      {hint && <span className="text-[12px] text-faint">{hint}</span>}
    </div>
  )
}

export function TextInput({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(CONTROL, 'h-9.5', className)} {...rest} />
}

export function MoneyInput({
  value,
  onValueChange,
  max,
  id,
  invalid,
}: {
  value: number | ''
  onValueChange: (value: number | '') => void
  max?: number
  id?: string
  invalid?: boolean
}) {
  return (
    <div
      className={cx(
        'flex h-11 items-center rounded-md border bg-sunken focus-within:border-authority/60 focus-within:shadow-[0_0_0_3px_rgb(53_224_174/0.14)]',
        invalid ? 'border-blocked/60' : 'border-line hover:border-line-strong',
      )}
    >
      <span className="numeric pl-3 text-[15px] text-faint">$</span>
      <input
        id={id}
        inputMode="decimal"
        value={value}
        max={max}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^0-9.]/g, '')
          onValueChange(raw === '' ? '' : Number(raw))
        }}
        className="numeric h-full w-full bg-transparent px-2 text-[17px] font-semibold text-ink focus:outline-none"
      />
    </div>
  )
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={cx(CONTROL, 'h-9.5 appearance-none pr-8', className)} {...rest}>
        {children}
      </select>
      <svg
        viewBox="0 0 12 12"
        className="pointer-events-none absolute top-1/2 right-3 h-3 w-3 -translate-y-1/2 text-faint"
        aria-hidden
      >
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </div>
  )
}

export function Textarea(rest: InputHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(CONTROL, 'min-h-[72px] resize-none py-2.5 leading-5')}
      {...(rest as object)}
    />
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  hint?: ReactNode
  disabled?: boolean
}) {
  return (
    <label
      className={cx(
        'press flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-authority',
        disabled && 'cursor-not-allowed opacity-45',
        checked
          ? 'border-authority/40 bg-authority/[0.06]'
          : 'border-line bg-sunken hover:border-line-strong',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden
        className={cx(
          'mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border',
          checked ? 'border-authority bg-authority text-[#04120d]' : 'border-line-strong',
        )}
      >
        {checked && (
          <svg viewBox="0 0 12 12" className="h-3 w-3">
            <path d="M2.5 6.2 4.8 8.5 9.5 3.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[12px] leading-4 text-muted">{hint}</span>}
      </span>
    </label>
  )
}

export function Radio({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: () => void
  label: ReactNode
  hint?: ReactNode
}) {
  return (
    <label
      className={cx(
        'press flex cursor-pointer items-start gap-3 rounded-md border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-authority',
        checked
          ? 'border-authority/40 bg-authority/[0.06]'
          : 'border-line bg-sunken hover:border-line-strong',
      )}
    >
      <input type="radio" checked={checked} onChange={onChange} className="sr-only" />
      <span
        aria-hidden
        className={cx(
          'mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
          checked ? 'border-authority' : 'border-line-strong',
        )}
      >
        {checked && <span className="h-2 w-2 rounded-full bg-authority" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[12px] leading-4 text-muted">{hint}</span>}
      </span>
    </label>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  label: ReactNode
  hint?: ReactNode
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-6 py-3">
      <span className="min-w-0">
        <span className="block text-[13px] text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-[12px] text-muted">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <span
        aria-hidden
        className={cx(
          'relative h-5 w-9 shrink-0 rounded-full border',
          checked ? 'border-authority/50 bg-authority/25' : 'border-line bg-sunken',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 h-3.5 w-3.5 rounded-full transition-transform duration-200',
            checked ? 'translate-x-4.5 bg-authority' : 'translate-x-0.5 bg-[#4b525d]',
          )}
        />
      </span>
    </label>
  )
}
