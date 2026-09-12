/** HBAR has 8 decimals; every atomic amount in this system is scaled by 1e8. */
export const ATOMIC_PER_HBAR = 100_000_000

export function hbarToAtomic(hbar: number): number {
  return Math.round(hbar * ATOMIC_PER_HBAR)
}

export function atomicToHbar(atomic: number): number {
  return atomic / ATOMIC_PER_HBAR
}

export function formatHbar(atomic: number): string {
  return `${atomicToHbar(atomic).toFixed(8)} HBAR`
}

export function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return `${Math.floor(seconds)}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

export function timeUntil(iso: string): { label: string; expired: boolean; soon: boolean } {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return { label: 'expired', expired: true, soon: false }
  const seconds = ms / 1000
  const soon = seconds < 3600
  if (seconds < 3600) return { label: `${Math.floor(seconds / 60)}m left`, expired: false, soon }
  if (seconds < 86_400) return { label: `${Math.floor(seconds / 3600)}h left`, expired: false, soon }
  return { label: `${Math.floor(seconds / 86_400)}d left`, expired: false, soon }
}
