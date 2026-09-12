import { NavLink } from 'react-router-dom'
import { useLeash } from '../../lib/store'
import { cx } from '../../lib/utils'
import {
  IconActivity,
  IconAgents,
  IconOverview,
  IconPolicies,
  IconServices,
  IconSettings,
  IconSpending,
} from './icons'

const NAV = [
  { to: '/', label: 'Overview', Icon: IconOverview, end: true },
  { to: '/agents', label: 'Agents', Icon: IconAgents },
  { to: '/spending', label: 'Spending', Icon: IconSpending },
  { to: '/activity', label: 'Activity', Icon: IconActivity },
  { to: '/policies', label: 'Policies', Icon: IconPolicies },
  { to: '/services', label: 'Services', Icon: IconServices },
  { to: '/settings', label: 'Settings', Icon: IconSettings },
]

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { network } = useLeash()
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
      </div>
    </nav>
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
