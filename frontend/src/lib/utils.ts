import type { AgentStatus, ResourceKind } from './types'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

const usdWhole = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

/** Sub-cent amounts are the norm for metered payments; keep their digits. */
const usdSmall = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
})

/**
 * Dollars (the dashboard's asset is USDC). Whole numbers drop the cents,
 * amounts under a dollar keep up to six decimals so a $0.000526 payment
 * doesn't render as $0.00.
 */
export function money(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Number.isInteger(value)) return usdWhole.format(value)
  if (Math.abs(value) < 1) return usdSmall.format(value)
  return usd.format(value)
}

export function moneyExact(value: number): string {
  return Math.abs(value) < 1 && value !== 0 ? usdSmall.format(value) : usd.format(value)
}

/** An amount in some other asset (e.g. an HBAR receipt), as `0.000526 HBAR`. */
export function amountIn(value: number, symbol?: string): string {
  if (!symbol || symbol === 'USDC' || symbol === 'USD') return money(value)
  const digits = Math.abs(value) < 1 ? 8 : 4
  return `${Number(value.toFixed(digits)).toString()} ${symbol}`
}

export function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`
}

export function ratio(part: number, whole: number): number {
  if (whole <= 0) return 0
  return Math.min(1, Math.max(0, part / whole))
}

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})

const dayFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

const timeFmt = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function formatDate(iso?: string): string {
  if (!iso) return '—'
  return dateFmt.format(new Date(iso))
}

export function formatDay(iso: string): string {
  return dayFmt.format(new Date(iso))
}

export function formatTime(iso: string): string {
  return timeFmt.format(new Date(iso))
}

export function formatDateTime(iso: string): string {
  return `${dateFmt.format(new Date(iso))} · ${timeFmt.format(new Date(iso))}`
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 45) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} hr ago`
  const days = Math.floor(seconds / 86_400)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

export interface Expiry {
  label: string
  expired: boolean
  soon: boolean
  days: number
}

export function timeUntil(iso?: string): Expiry {
  if (!iso) return { label: 'No expiry', expired: false, soon: false, days: Infinity }
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return { label: 'Expired', expired: true, soon: false, days: 0 }
  const days = ms / 86_400_000
  const soon = days < 7
  if (days < 1) return { label: `Expires in ${Math.max(1, Math.floor(days * 24))}h`, expired: false, soon: true, days }
  return {
    label: `Expires in ${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`,
    expired: false,
    soon,
    days,
  }
}

export function shortHash(hash: string, lead = 6, tail = 4): string {
  if (hash.length <= lead + tail + 2) return hash
  return `${hash.slice(0, lead)}…${hash.slice(-tail)}`
}

export const STATUS_LABEL: Record<AgentStatus, string> = {
  active: 'Active',
  warning: 'Warning',
  expired: 'Expired',
  suspended: 'Suspended',
  revoked: 'Revoked',
}

/** Status colours live here so the tree, tables, badges and drawers agree. */
export const STATUS_TONE: Record<AgentStatus, { text: string; dot: string; ring: string }> = {
  active: { text: 'text-authority', dot: 'bg-authority', ring: 'bg-authority/15' },
  warning: { text: 'text-warn', dot: 'bg-warn', ring: 'bg-warn/15' },
  expired: { text: 'text-idle', dot: 'bg-idle', ring: 'bg-idle/15' },
  suspended: { text: 'text-idle', dot: 'bg-idle', ring: 'bg-idle/15' },
  revoked: { text: 'text-blocked', dot: 'bg-blocked', ring: 'bg-blocked/15' },
}

export const RESOURCES: { id: ResourceKind; label: string; blurb: string }[] = [
  { id: 'compute', label: 'Compute', blurb: 'Instances, containers, GPU jobs' },
  { id: 'storage', label: 'Storage', blurb: 'Object storage and volumes' },
  { id: 'database', label: 'Database', blurb: 'Managed database clusters' },
  { id: 'inference', label: 'Inference', blurb: 'Hosted model endpoints' },
  { id: 'networking', label: 'Networking', blurb: 'Egress, load balancers, DNS' },
  { id: 'secrets', label: 'Secrets', blurb: 'Key vaults and credentials' },
]

export function resourceLabel(id: ResourceKind): string {
  return RESOURCES.find((r) => r.id === id)?.label ?? id
}

/** Deterministic-enough id for locally created records. */
export function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`
}

export function makeTxId(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  return `0x${Array.from({ length: 40 }, hex).join('')}`
}

export function startOfDay(d: Date | string): number {
  const date = new Date(d)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
