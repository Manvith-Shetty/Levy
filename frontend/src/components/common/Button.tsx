import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { cx } from '../../lib/utils'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

// Hover is an overlay whose opacity animates (`wash`), press is a spring
// scale (`press`). No colour property is ever transitioned.
const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-authority text-[#04120d] font-semibold border border-transparent shadow-[var(--shadow-glow-authority)] after:bg-white/20!',
  secondary: 'bg-raised text-ink border border-line hover:border-line-strong shadow-[var(--shadow-raised)]',
  ghost: 'bg-transparent text-ink-dim border border-transparent hover:text-ink',
  danger: 'bg-blocked/10 text-blocked border border-blocked/40 hover:border-blocked/60 after:bg-blocked/12!',
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[12.5px] gap-1.5 rounded-md',
  md: 'h-9.5 px-4 text-[13px] gap-2 rounded-md',
}

const BASE =
  'wash press inline-flex items-center justify-center whitespace-nowrap disabled:pointer-events-none disabled:opacity-40'

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button className={cx(BASE, VARIANTS[variant], SIZES[size], className)} {...rest}>
      {children}
    </button>
  )
}

export function ButtonLink({
  to,
  variant = 'secondary',
  size = 'md',
  className,
  children,
}: {
  to: string
  variant?: Variant
  size?: Size
  className?: string
  children: ReactNode
}) {
  return (
    <Link to={to} className={cx(BASE, VARIANTS[variant], SIZES[size], className)}>
      {children}
    </Link>
  )
}
