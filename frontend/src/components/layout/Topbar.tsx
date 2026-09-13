import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../../app/toast'
import { config, etherscanUrl } from '../../lib/config'
import { explain } from '../../lib/live/wallet'
import { useLeash } from '../../lib/store'
import { cx } from '../../lib/utils'
import { Wordmark } from './Sidebar'
import { IconSearch } from './icons'

export const WALLET_ADDRESS = '0x8f3a…c921'

export function Topbar({
  onOpenCommand,
  onOpenNav,
}: {
  onOpenCommand: () => void
  onOpenNav: () => void
}) {
  const { network, setNetwork, demoMode, setDemoMode, live } = useLeash()
  const testnet = network === 'hedera-testnet'

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-canvas/80 px-4 backdrop-blur-md lg:px-6">
      <button
        type="button"
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="wash press flex h-8 w-8 items-center justify-center rounded-md border border-line text-muted lg:hidden"
      >
        <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden>
          <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      </button>

      <span className="lg:hidden">
        <Wordmark compact />
      </span>

      <button
        type="button"
        onClick={onOpenCommand}
        className="wash press group hidden h-8.5 w-full max-w-sm items-center gap-2.5 rounded-md border border-line bg-sunken px-3 text-left hover:border-line-strong sm:flex"
      >
        <IconSearch className="h-3.5 w-3.5 text-faint" />
        <span className="flex-1 truncate text-[12.5px] text-faint group-hover:text-muted">
          Search agents, transactions, policies...
        </span>
        <kbd className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-faint">
          ⌘K
        </kbd>
      </button>

      <div className="flex flex-1 items-center justify-end gap-2">
        <button
          type="button"
          onClick={onOpenCommand}
          aria-label="Search"
          className="wash press flex h-8 w-8 items-center justify-center rounded-md border border-line text-muted sm:hidden"
        >
          <IconSearch className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={() => setDemoMode(!demoMode)}
          aria-pressed={demoMode}
          className={cx(
            'wash press hidden h-8 items-center gap-2 rounded-md border px-2.5 text-[12px] md:inline-flex',
            demoMode
              ? 'border-delegated/40 bg-delegated/10 text-delegated'
              : 'border-line bg-raised text-muted hover:text-ink',
          )}
        >
          Demo Mode
          <span className={cx('h-1.5 w-1.5 rounded-full', demoMode ? 'bg-delegated' : 'bg-[#4b525d]')} />
        </button>

        {live.active ? (
          <>
            <div className="hidden h-8 items-center gap-2 rounded-md border border-line bg-raised px-2.5 text-[12px] text-ink-dim shadow-[var(--shadow-raised)] sm:inline-flex">
              <span
                className={cx(
                  'h-1.5 w-1.5 rounded-full',
                  live.errors.ens || live.errors.hcs ? 'bg-warn' : 'animate-pulse-dot bg-authority',
                )}
              />
              {config.hederaNetworkName} · {config.ensChainName}
            </div>
            <WalletButton />
          </>
        ) : (
          <>
            <Dropdown
              label={
                <>
                  <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-authority" />
                  {testnet ? 'Hedera Testnet' : 'Hedera Mainnet'}
                  <Chevron />
                </>
              }
              className="hidden sm:inline-flex"
              items={[
                { label: 'Hedera Testnet', active: testnet, onSelect: () => setNetwork('hedera-testnet') },
                { label: 'Hedera Mainnet', active: !testnet, onSelect: () => setNetwork('hedera-mainnet') },
              ]}
            />
            <div className="hidden h-8 items-center gap-2 rounded-md border border-line bg-raised px-2.5 text-[12px] text-ink-dim shadow-[var(--shadow-raised)] md:flex">
              <span className="font-mono text-[11.5px]">{WALLET_ADDRESS}</span>
              <span className="h-1.5 w-1.5 rounded-full bg-authority" aria-label="Connected" />
            </div>
          </>
        )}

        <UserMenu />
      </div>
    </header>
  )
}

/** The Sepolia wallet that signs tree changes (revoke, renew, create). */
function WalletButton() {
  const { live } = useLeash()
  const { push } = useToast()
  const [busy, setBusy] = useState(false)

  if (live.account) {
    return (
      <a
        href={etherscanUrl('address', live.account)}
        target="_blank"
        rel="noreferrer"
        title={`Signs tree changes on ${config.ensChainName}`}
        className="wash press hidden h-8 items-center gap-2 rounded-md border border-line bg-raised px-2.5 text-[12px] text-ink-dim shadow-[var(--shadow-raised)] md:inline-flex"
      >
        <span className="font-mono text-[11.5px]">
          {live.account.slice(0, 6)}…{live.account.slice(-4)}
        </span>
        <span className="h-1.5 w-1.5 rounded-full bg-authority" aria-label="Connected" />
      </a>
    )
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        if (!live.hasWallet) {
          push({
            tone: 'info',
            title: 'No browser wallet found',
            body: `Install MetaMask to revoke, renew or create agents on ${config.ensChainName}. Reading the tree needs no wallet.`,
          })
          return
        }
        setBusy(true)
        try {
          await live.connect()
        } catch (error) {
          push({ tone: 'blocked', title: 'Wallet not connected', body: explain(error) })
        } finally {
          setBusy(false)
        }
      }}
      className="wash press hidden h-8 items-center gap-2 rounded-md border border-authority/40 bg-authority/10 px-2.5 text-[12px] font-medium text-authority disabled:opacity-50 md:inline-flex"
    >
      {busy ? 'Connecting…' : 'Connect wallet'}
    </button>
  )
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 text-faint" aria-hidden>
      <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return ref
}

function Dropdown({
  label,
  items,
  className,
}: {
  label: React.ReactNode
  items: { label: string; active?: boolean; onSelect: () => void }[]
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div ref={ref} className={cx('relative', className)}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="wash press inline-flex h-8 items-center gap-2 rounded-md border border-line bg-raised px-2.5 text-[12px] text-ink-dim shadow-[var(--shadow-raised)]"
      >
        {label}
      </button>
      {open && (
        <div className="animate-enter absolute top-9.5 right-0 z-40 w-48 rounded-lg border border-line bg-raised py-1 shadow-[var(--shadow-floating)]">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                item.onSelect()
                setOpen(false)
              }}
              className="wash press flex w-full items-center justify-between px-3 py-1.5 text-left text-[12.5px] text-ink-dim hover:text-ink"
            >
              {item.label}
              {item.active && <span className="text-authority">●</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function UserMenu() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Account menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="press flex h-8 w-8 items-center justify-center rounded-md bg-[linear-gradient(135deg,#35e0ae,#7a6bff)] font-display text-[11px] font-bold text-[#06100c] hover:opacity-90"
      >
        MS
      </button>
      {open && (
        <div className="animate-enter absolute top-9.5 right-0 z-40 w-44 rounded-lg border border-line bg-raised py-1 shadow-[var(--shadow-floating)]">
          {[
            { label: 'Settings', to: '/settings' },
            { label: 'Activity', to: '/activity' },
          ].map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setOpen(false)
                navigate(item.to)
              }}
              className="wash press block w-full px-3 py-1.5 text-left text-[12.5px] text-ink-dim hover:text-ink"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
