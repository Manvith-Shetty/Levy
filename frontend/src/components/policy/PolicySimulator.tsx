import { useMemo, useState } from 'react'
import { ApiError, authorize } from '../../lib/gateway/api'
import type { PolicyDecision } from '../../lib/gateway/types'
import { config } from '../../lib/config'
import { useLeash } from '../../lib/store'
import { Button } from '../common/Button'
import { Card, CardHead } from '../common/Card'
import { Label, MoneyInput, Select } from '../common/Field'
import { PolicyChecklist } from './PolicyChecklist'

const SERVICES = ['inference', 'compute', 'data']

/**
 * Asks the gateway's policy engine about a payment that never happens: the
 * same evaluation `/v1/infer` runs before it names a price, minus paying,
 * recording or reserving anything.
 */
export function PolicySimulator() {
  const { agents } = useLeash()
  const choices = useMemo(() => agents.filter((a) => a.parentId), [agents])
  const [picked, setPicked] = useState('')
  // Agents arrive after the first render; until one is picked, default to the deepest demo agent.
  const agent = choices.some((a) => a.id === picked)
    ? picked
    : (choices.find((a) => a.id === 'sub.agent.root')?.id ?? choices[0]?.id ?? '')
  const [service, setService] = useState('inference')
  const [amount, setAmount] = useState<number | ''>(0.000328)
  const [asset, setAsset] = useState(config.assetSymbol)
  const [decision, setDecision] = useState<PolicyDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function evaluate() {
    if (!agent || typeof amount !== 'number') return
    setBusy(true)
    setError(null)
    try {
      setDecision(
        await authorize({
          agent,
          amount: Math.round(amount * 10 ** config.assetDecimals),
          service,
          asset,
        }),
      )
    } catch (err) {
      setDecision(null)
      setError(
        err instanceof ApiError && err.status === 404
          ? 'This gateway predates the policy simulator. Restart it from crates/gateway to pick up POST /v1/authorize.'
          : err instanceof ApiError && err.status >= 500
            ? "The gateway isn't answering. Start it with `cargo run -p gateway` in crates/gateway."
            : err instanceof Error
              ? err.message
              : String(err),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHead
        title="Policy simulator"
        hint="Test a payment against an agent's policy without making it. The gateway's own policy engine answers, so the result is exactly what a real payment would get."
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_0.8fr_auto] lg:items-end">
        <div>
          <Label htmlFor="sim-agent">Agent</Label>
          <Select id="sim-agent" className="h-11" value={agent} onChange={(e) => setPicked(e.target.value)}>
            {choices.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="sim-service">Service</Label>
          <Select id="sim-service" className="h-11" value={service} onChange={(e) => setService(e.target.value)}>
            {SERVICES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="sim-amount">Amount</Label>
          <MoneyInput id="sim-amount" value={amount} onValueChange={setAmount} />
        </div>
        <div>
          <Label htmlFor="sim-asset">Asset</Label>
          <Select id="sim-asset" className="h-11" value={asset} onChange={(e) => setAsset(e.target.value)}>
            {[config.assetSymbol, 'HBAR'].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </Select>
        </div>
        <Button variant="primary" disabled={busy || !agent || typeof amount !== 'number'} onClick={evaluate} className="h-11">
          {busy ? 'Evaluating…' : 'Evaluate'}
        </Button>
      </div>
      {error && (
        <p className="copy mt-4 rounded-md border border-warn/40 bg-warn/[0.07] px-3 py-2.5 text-[12.5px] text-warn">{error}</p>
      )}
      {decision && <PolicyChecklist decision={decision} className="mt-4" />}
    </Card>
  )
}
