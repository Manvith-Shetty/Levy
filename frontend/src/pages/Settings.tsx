import { useLeash } from '../lib/store'
import type { Network, NotificationSettings } from '../lib/types'
import { PageHeader } from '../components/layout/PageHeader'
import { Card, CardHead } from '../components/common/Card'
import { Button } from '../components/common/Button'
import { Checkbox, Radio } from '../components/common/Field'
import { WALLET_ADDRESS } from '../components/layout/Topbar'
import { useToast } from '../app/toast'

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
  const { network, setNetwork, notifications, setNotification } = useLeash()
  const { push } = useToast()

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
