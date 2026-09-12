import { useLeash } from '../lib/store'
import type { Network, NotificationSettings } from '../lib/types'
import { PageHeader } from '../components/layout/PageHeader'
import { Card, CardHead } from '../components/common/Card'
import { Button } from '../components/common/Button'
import { Checkbox, Radio } from '../components/common/Field'
import { WALLET_ADDRESS } from '../components/layout/Topbar'
import { useToast } from '../app/toast'
import { config, etherscanUrl, hashscanUrl } from '../lib/config'
import { treeAsset } from '../lib/live/adapter'
import { explain } from '../lib/live/wallet'
import { money, timeAgo } from '../lib/utils'
import { useState } from 'react'

const NOTIFICATIONS: [keyof NotificationSettings, string][] = [
  ['nearingBudget', 'Agent nearing budget limit'],
  ['expiration', 'Agent expiration'],
  ['paymentBlocked', 'Payment blocked'],
  ['childCreated', 'New child agent created'],
]

const NETWORKS: [Network, string][] = [
  ['hedera-testnet', 'Hedera Testnet'],
  ['hedera-mainnet', 'Hedera Mainnet'],
]

export function Settings() {
  const { network, setNetwork, notifications, setNotification, live } = useLeash()
  const { push } = useToast()

  if (live.active) return <LiveSettings />

  return (
    <>
      <PageHeader title="Settings" />

      <div className="grid max-w-2xl gap-4">
        <Card>
          <CardHead title="Wallet" />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-sunken p-4">
            <div>
              <p className="font-mono text-[13px] text-ink">{WALLET_ADDRESS}</p>
              <p className="mt-1 text-[12.5px] text-muted">
                {network === 'hedera-testnet' ? 'Hedera Testnet' : 'Hedera Mainnet'}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                push({ tone: 'info', title: 'Wallet disconnect is disabled in demo mode' })
              }
            >
              Disconnect
            </Button>
          </div>
        </Card>

        <Card>
          <CardHead title="Network" />
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {NETWORKS.map(([id, label]) => (
              <Radio
                key={id}
                checked={network === id}
                onChange={() => {
                  setNetwork(id)
                  push({ tone: 'info', title: `Switched to ${label}` })
                }}
                label={label}
              />
            ))}
          </div>
        </Card>

        <Card>
          <CardHead title="Notifications" />
          <div className="mt-4 grid gap-2">
            {NOTIFICATIONS.map(([key, label]) => (
              <Checkbox
                key={key}
                checked={notifications[key]}
                onChange={(value) => setNotification(key, value)}
                label={label}
              />
            ))}
          </div>
        </Card>
      </div>
    </>
  )
}

function Fact({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-[13px]">
      <dt className="text-muted">{label}</dt>
      <dd className="truncate text-ink">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="font-mono text-[12.5px] hover:text-authority active:opacity-70">
            {value}
          </a>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}

/** Live mode: where the data comes from and which wallets are involved. */
function LiveSettings() {
  const { live, notifications, setNotification } = useLeash()
  const { push } = useToast()
  const [connecting, setConnecting] = useState(false)
  const payer = live.snapshot?.payer
  const sources: Array<{ key: keyof typeof live.errors; label: string; detail: string }> = [
    { key: 'ens', label: 'ENS tree', detail: `Sepolia RPC ${new URL(config.sepoliaRpcUrl).host}` },
    { key: 'hcs', label: 'HCS receipts and refusals', detail: `Mirror node ${new URL(config.mirrorUrl).host}` },
    { key: 'gateway', label: 'Gateway', detail: 'Manifest and in-memory records via /api — optional' },
    { key: 'payer', label: 'Shared wallet balance', detail: 'Mirror node account lookup' },
  ]

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid max-w-2xl gap-4">
        <Card>
          <CardHead title="Shared agent wallet" hint="Every demo agent pays from this one Hedera account. The ENS name is what the gateway checks and what spend is attributed to." />
          <dl className="mt-3 divide-y divide-hairline">
            <Fact label="Account" value={config.payerAccount} href={hashscanUrl('account', config.payerAccount)} />
            <Fact
              label={treeAsset.symbol}
              value={payer ? (payer.associated ? money(payer.token ?? 0) : `Not associated with ${treeAsset.id}`) : '—'}
            />
            <Fact label="HBAR (fees)" value={payer ? payer.hbar.toFixed(4) : '—'} />
          </dl>
        </Card>

        <Card>
          <CardHead title="Signing wallet" hint="Revoking, restoring and creating agents are Sepolia transactions signed in your browser wallet. Reading needs no wallet." />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-lg border border-line bg-sunken p-4">
            <p className="font-mono text-[13px] text-ink">
              {live.account ?? (live.hasWallet ? 'Not connected' : 'No browser wallet found')}
            </p>
            {live.account ? (
              <a
                href={etherscanUrl('address', live.account)}
                target="_blank"
                rel="noreferrer"
                className="text-[12.5px] text-muted hover:text-authority active:opacity-70"
              >
                View on Etherscan
              </a>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled={!live.hasWallet || connecting}
                onClick={async () => {
                  setConnecting(true)
                  try {
                    await live.connect()
                  } catch (error) {
                    push({ tone: 'blocked', title: 'Wallet not connected', body: explain(error) })
                  } finally {
                    setConnecting(false)
                  }
                }}
              >
                {connecting ? 'Connecting…' : 'Connect wallet'}
              </Button>
            )}
          </div>
        </Card>

        <Card>
          <CardHead title="Network" />
          <dl className="mt-3 divide-y divide-hairline">
            <Fact label="Payments and audit trail" value="Hedera Testnet" />
            <Fact label="Mandate tree" value="Ethereum Sepolia (ENSv2)" />
            <Fact label="Top registry" value={`${config.topRegistry.slice(0, 6)}…${config.topRegistry.slice(-4)}`} href={etherscanUrl('address', config.topRegistry)} />
            <Fact label="HCS topic" value={live.snapshot?.topicId ?? '—'} href={live.snapshot?.topicId ? hashscanUrl('topic', live.snapshot.topicId) : undefined} />
          </dl>
          <p className="mt-3 text-[12px] text-faint">Set in .env — see .env.example.</p>
        </Card>

        <Card>
          <CardHead
            title="Data sources"
            hint={live.snapshot ? `Last read ${timeAgo(new Date(live.snapshot.fetchedAt).toISOString())}. Refreshes every ${Math.round(config.pollMs / 1000)}s.` : 'Loading…'}
            action={
              <Button size="sm" disabled={live.refreshing} onClick={() => void live.refresh()}>
                {live.refreshing ? 'Refreshing…' : 'Refresh now'}
              </Button>
            }
          />
          <ul className="mt-3 divide-y divide-hairline">
            {sources.map((source) => {
              const error = live.errors[source.key]
              return (
                <li key={source.key} className="flex items-start justify-between gap-4 py-2.5">
                  <span className="min-w-0">
                    <span className="block text-[13px] text-ink">{source.label}</span>
                    <span className="block truncate text-[12px] text-faint">{error ?? source.detail}</span>
                  </span>
                  <span className={`shrink-0 text-[12.5px] ${error ? 'text-warn' : 'text-authority'}`}>
                    {error ? 'Unreachable' : live.ready ? 'OK' : '…'}
                  </span>
                </li>
              )
            })}
          </ul>
        </Card>

        <Card>
          <CardHead title="Notifications" />
          <div className="mt-4 grid gap-2">
            {NOTIFICATIONS.map(([key, label]) => (
              <Checkbox
                key={key}
                checked={notifications[key]}
                onChange={(value) => setNotification(key, value)}
                label={label}
              />
            ))}
          </div>
        </Card>
      </div>
    </>
  )
}
