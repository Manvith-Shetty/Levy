import { NavLink } from 'react-router-dom'
import { hashscanUrl } from '../../lib/config'
import { treeAsset } from '../../lib/live/adapter'
import { useLeash } from '../../lib/store'
import { cx, money } from '../../lib/utils'
import {
  IconActivity,
  IconAgents,
  IconAutopilot,
  IconOverview,
  IconPolicies,
  IconServices,
  IconSettings,
} from './icons'

const NAV = [
  { to: '/', label: 'Overview', Icon: IconOverview, end: true },
  { to: '/agents', label: 'Agents', Icon: IconAgents },
  { to: '/services', label: 'Services', Icon: IconServices },
  { to: '/autopilot', label: 'Autopilot', Icon: IconAutopilot },
  { to: '/policies', label: 'Policies', Icon: IconPolicies },
  { to: '/activity', label: 'Activity', Icon: IconActivity },
  { to: '/settings', label: 'Settings', Icon: IconSettings },
]

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { network, live } = useLeash()
  const testnet = network === 'hedera-testnet'

  return (
    <nav className="flex h-full w-[232px] shrink-0 flex-col border-r border-line bg-[#0a0b0e]">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <Wordmark />
      </div>

      <ul className="flex-1 space-y-0.5 px-3 pt-2">
        {NAV.map(({ to, label, Icon, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              onClick={onNavigate}
              className={({ isActive }) =>
                cx(
                  'wash press group relative flex h-8.5 items-center gap-2.5 rounded-md px-2.5 text-[13px]',
                  isActive
                    ? 'bg-raised text-ink shadow-[var(--shadow-raised)]'
                    : 'text-muted hover:text-ink-dim',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <span
                    aria-hidden
                    className={cx(
                      'absolute top-1.5 -left-3 h-5.5 w-0.5 rounded-r-full',
                      isActive ? 'bg-authority' : 'bg-transparent',
                    )}
                  />
                  <Icon className={cx('h-4 w-4', isActive ? 'text-authority' : 'text-faint')} />
                  {label}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="space-y-4 border-t border-hairline px-5 py-4">
        {live.active ? <LiveFooter /> : (
          <>
            <div>
              <p className="text-[11.5px] text-faint">Network</p>
              <p className="mt-1 text-[13px] text-ink">
                {testnet ? 'Hedera Testnet' : 'Hedera Mainnet'}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-authority">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="animate-pulse-dot h-1.5 w-1.5 rounded-full bg-authority" />
                </span>
                Connected
              </p>
            </div>
            <div>
              <p className="text-[11.5px] text-faint">Wallet</p>
              <p className="numeric mt-1 text-[13px] text-ink">0.00 HBAR</p>
            </div>
          </>
        )}
      </div>
    </nav>
  )
}

function SourceLine({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <p className="mt-1 flex items-center gap-1.5 text-[12.5px] text-ink" title={detail}>
      <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', ok ? 'bg-authority' : 'bg-warn')} />
      {label}
      {!ok && <span className="text-[11.5px] text-warn">unreachable</span>}
    </p>
  )
}

/** Live mode: which networks are answering, and the one wallet agents pay from. */
function LiveFooter() {
  const { live } = useLeash()
  const payer = live.snapshot?.payer
  return (
    <>
      <div>
        <p className="text-[11.5px] text-faint">Network</p>
        <SourceLine label="Hedera Testnet" ok={!live.errors.hcs} detail={live.errors.hcs} />
        <SourceLine label="ENS · Sepolia" ok={!live.errors.ens} detail={live.errors.ens} />
      </div>
      <div>
        <p className="text-[11.5px] text-faint">Shared agent wallet</p>
        {payer ? (
          <>
            <a
              href={hashscanUrl('account', payer.id)}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block font-mono text-[12px] text-ink hover:text-authority active:opacity-70"
            >
              {payer.id}
            </a>
            <p className="numeric mt-0.5 text-[12.5px] text-ink-dim">
              {payer.associated ? `${money(payer.token ?? 0)} ${treeAsset.symbol}` : `No ${treeAsset.symbol} yet`}
              <span className="text-faint"> · {payer.hbar.toFixed(2)} HBAR</span>
            </p>
          </>
        ) : (
          <p className="mt-1 text-[12.5px] text-faint">{live.ready ? 'Unavailable' : 'Loading…'}</p>
        )}
      </div>
    </>
  )
}

/** The mark: the Leash logo badge — every place the brand appears. */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <img
        src="/leash-logo-512.png"
        alt=""
        className="h-6.5 w-6.5 shrink-0 rounded-[7px] object-cover ring-1 ring-line"
      />
      {!compact && (
        <span className="font-display text-[15px] font-semibold tracking-[-0.02em] text-ink">
          Leash
        </span>
      )}
    </span>
  )
}
