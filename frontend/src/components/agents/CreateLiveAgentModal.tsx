import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../../app/toast'
import { treeAsset, toAtomic } from '../../lib/live/adapter'
import { explain, toLabel, type CreateStep } from '../../lib/live/wallet'
import { useLeash } from '../../lib/store'
import { cx, formatDate, money, ratio } from '../../lib/utils'
import { Button } from '../common/Button'
import { Checkbox, Label, MoneyInput, Select, TextInput } from '../common/Field'
import { Modal, ModalFoot, ModalHead } from '../common/Modal'

const STEPS = ['Identity', 'Authority', 'Permissions', 'Expiration'] as const
type Step = 0 | 1 | 2 | 3

/** Services the gateway can sell today; the record is free text on-chain. */
const SERVICES = ['inference', 'compute', 'storage']

/**
 * Mints a real child mandate on ENSv2 Sepolia. The MandateRegistrar enforces
 * the rules on-chain — budget ≤ parent's budget, expiry ≤ parent's expiry —
 * and this wizard mirrors them so the transaction doesn't fail on submit.
 */
export function CreateLiveAgentModal({
  open,
  onClose,
  parentId,
}: {
  open: boolean
  onClose: () => void
  parentId?: string
}) {
  const { agents, index, live } = useLeash()
  const { push } = useToast()
  const navigate = useNavigate()

  const parents = useMemo(() => agents.filter((a) => a.mandate?.canParent), [agents])
  const initialParent =
    (parentId && index[parentId]?.mandate?.canParent ? parentId : undefined) ?? parents[0]?.id ?? ''

  const [step, setStep] = useState<Step>(0)
  const [parentName, setParentName] = useState(initialParent)
  const [name, setName] = useState('')
  const [budget, setBudget] = useState<number | ''>('')
  const [maxPerCall, setMaxPerCall] = useState<number | ''>('')
  const [rate, setRate] = useState<number | ''>('')
  const [services, setServices] = useState<string[]>(['inference'])
  const [expiryDate, setExpiryDate] = useState('')
  const [progress, setProgress] = useState<CreateStep | null>(null)
  const [error, setError] = useState<string | null>(null)

  const parent = index[parentName]
  const node = parent ? live.nodes[parent.id] : undefined
  const label = toLabel(name)
  const fullName = label && parent ? `${label}.${parent.name}` : ''
  const taken = Boolean(fullName && index[fullName])
  const ceiling = parent?.authority ?? 0
  const over = typeof budget === 'number' && budget > ceiling
  const parentExpiry = parent?.expiresAt ? new Date(parent.expiresAt) : undefined
  const defaultExpiry = parentExpiry ? parentExpiry.toISOString().slice(0, 10) : ''
  const expiry = expiryDate || defaultExpiry
  // End of the chosen day, clamped to the parent's exact expiry.
  const expiryMs = expiry
    ? Math.min(new Date(`${expiry}T23:59:00`).getTime(), parentExpiry?.getTime() ?? Infinity)
    : NaN
  const expiryValid = Number.isFinite(expiryMs) && expiryMs > Date.now()
  const perCall = maxPerCall === '' ? (typeof budget === 'number' ? budget : 0) : maxPerCall

  const stepValid =
    step === 0
      ? Boolean(parent && label.length >= 2 && !taken)
      : step === 1
        ? typeof budget === 'number' && budget > 0 && !over
        : step === 2
          ? services.length > 0 && perCall > 0 && perCall <= (typeof budget === 'number' ? budget : 0)
          : expiryValid

  if (!open) return null

  if (parents.length === 0) {
    return (
      <Modal open onClose={onClose} width="max-w-md" labelledBy="create-live-title">
        <ModalHead id="create-live-title" title="Create Agent" onClose={onClose} />
        <p className="copy px-6 py-6 text-[13px] text-muted">
          No agent in the live tree can mint children right now. A parent needs a subregistry and a
          binding in the MandateRegistrar — see contracts/DEPLOY.md.
        </p>
        <ModalFoot>
          <span />
          <Button onClick={onClose}>Close</Button>
        </ModalFoot>
      </Modal>
    )
  }

  async function submit() {
    if (!parent || !node?.subregistry || !node.resolver || typeof budget !== 'number') return
    setError(null)
    let reached: CreateStep | null = null
    try {
      if (!live.account) await live.connect()
      await live.create(
        {
          parent: {
            name: node.name,
            label: node.label,
            registry: node.registry,
            subregistry: node.subregistry,
            resolver: node.resolver,
          },
          label,
          budget: toAtomic(budget),
          maxPerCall: toAtomic(perCall),
          ratePerMinute: toAtomic(rate === '' ? budget : rate),
          allowedServices: services,
          expiry: BigInt(Math.floor(expiryMs / 1000)),
        },
        (next) => {
          reached = next
          setProgress(next)
        },
      )
      push({ tone: 'success', title: 'Agent created', body: `${fullName} was minted on Sepolia.` })
      onClose()
      navigate(`/agents/${fullName}`)
    } catch (err) {
      const minted = reached === 'records'
      setError(
        minted
          ? `${fullName} was minted, but its records weren't written: ${explain(err, parent.account)} The gateway refuses it until they are.`
          : explain(err, parent.account),
      )
    } finally {
      setProgress(null)
    }
  }

  const busy = progress !== null

  return (
    <Modal open onClose={busy ? () => undefined : onClose} width="max-w-2xl" labelledBy="create-live-title">
      <ModalHead id="create-live-title" title="Create Agent" onClose={busy ? () => undefined : onClose}>
        <ol className="mt-4 flex items-center gap-1.5">
          {STEPS.map((stepLabel, i) => (
            <li key={stepLabel} className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={i > step || busy}
                onClick={() => setStep(i as Step)}
                className={cx(
                  'press text-[12.5px] disabled:cursor-default',
                  i === step ? 'text-ink' : i < step ? 'text-authority' : 'text-faint',
                )}
              >
                {stepLabel}
              </button>
              {i < STEPS.length - 1 && (
                <span aria-hidden className={cx('h-px w-6', i < step ? 'bg-authority/50' : 'bg-line')} />
              )}
            </li>
          ))}
        </ol>
      </ModalHead>

      <div className="max-h-[min(60vh,34rem)] overflow-y-auto px-6 py-5">
        {step === 0 && (
          <div className="space-y-4">
            <div>
              <Label htmlFor="live-parent">Parent agent</Label>
              <Select id="live-parent" value={parentName} onChange={(e) => setParentName(e.target.value)}>
                {parents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — up to {money(a.authority)} per child
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="live-label" hint="Lowercase letters, digits, hyphens">
                Agent label
              </Label>
              <TextInput
                id="live-label"
                autoFocus
                value={name}
                placeholder="gpu"
                onChange={(e) => setName(e.target.value)}
              />
              {label && (
                <p className={cx('mt-1.5 font-mono text-[12px]', taken ? 'text-blocked' : 'text-muted')}>
                  {fullName}
                  {taken && ' already exists'}
                </p>
              )}
            </div>
          </div>
        )}

        {step === 1 && parent && (
          <div className="space-y-5">
            <div>
              <h3 className="text-[15px] font-semibold text-ink">Define authority</h3>
              <p className="copy mt-0.5 text-[13px] text-muted">
                How much authority should {fullName} receive? Written as its{' '}
                <span className="font-mono text-[12px]">budget</span> record, in {treeAsset.symbol}.
              </p>
            </div>
            <div>
              <Label htmlFor="live-budget">Maximum budget</Label>
              <MoneyInput id="live-budget" value={budget} onValueChange={setBudget} invalid={over} />
            </div>

            <div className="rounded-lg border border-line bg-sunken p-4">
              <div className="flex items-baseline justify-between">
                <p className="text-[13px] font-medium text-ink">{parent.name}</p>
                <p className="numeric text-[13px] text-muted">{money(parent.authority)} budget</p>
              </div>
              <div className="mt-3 flex h-3 w-full overflow-hidden rounded bg-[#191c22]">
                <div
                  className={over ? 'bg-blocked/70' : 'bg-authority/60'}
                  style={{ width: `${Math.min(1, ratio(typeof budget === 'number' ? budget : 0, ceiling)) * 100}%` }}
                />
              </div>
              {over ? (
                <div className="mt-3.5 rounded-md border border-blocked/40 bg-blocked/[0.07] px-3 py-2.5">
                  <p className="text-[13px] font-medium text-blocked">✕ Cannot create agent</p>
                  <dl className="numeric mt-1.5 grid gap-0.5 text-[12.5px]">
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted">Requested authority</dt>
                      <dd className="text-ink">{money(budget as number)}</dd>
                    </div>
                    <div className="flex justify-between gap-4">
                      <dt className="text-muted">{parent.name}'s budget</dt>
                      <dd className="text-ink">{money(ceiling)}</dd>
                    </div>
                  </dl>
                </div>
              ) : (
                <p className="copy mt-3.5 flex gap-2 rounded-md border border-warn/30 bg-warn/[0.06] px-3 py-2.5 text-[12.5px] text-warn">
                  <span aria-hidden>⚠</span>
                  The MandateRegistrar rejects any child whose budget is above {money(ceiling)} — checked
                  on-chain against {parent.name}'s live record.
                </p>
              )}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div>
              <h3 className="mb-2.5 text-[15px] font-semibold text-ink">Allowed services</h3>
              <div className="grid gap-2 sm:grid-cols-3">
                {SERVICES.map((service) => (
                  <Checkbox
                    key={service}
                    checked={services.includes(service)}
                    label={service}
                    onChange={(checked) =>
                      setServices(checked ? [...services, service] : services.filter((s) => s !== service))
                    }
                  />
                ))}
              </div>
              <p className="mt-2 text-[12px] text-faint">
                Written to <span className="font-mono">allowedServices</span>. The gateway doesn't enforce
                this record yet.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="live-per-call" hint={`≤ budget`}>
                  Max per call
                </Label>
                <MoneyInput id="live-per-call" value={maxPerCall} onValueChange={setMaxPerCall} />
                <p className="mt-1.5 text-[12px] text-faint">Enforced on every payment. Defaults to the budget.</p>
              </div>
              <div>
                <Label htmlFor="live-rate">Rate per minute</Label>
                <MoneyInput id="live-rate" value={rate} onValueChange={setRate} />
                <p className="mt-1.5 text-[12px] text-faint">Recorded, not enforced yet. Defaults to the budget.</p>
              </div>
            </div>
          </div>
        )}

        {step === 3 && parent && (
          <div className="space-y-5">
            <h3 className="text-[15px] font-semibold text-ink">Authority expiration</h3>
            <div>
              <Label htmlFor="live-expiry" hint={parentExpiry ? `No later than ${formatDate(parentExpiry.toISOString())}` : undefined}>
                Expires
              </Label>
              <TextInput
                id="live-expiry"
                type="date"
                value={expiry}
                max={defaultExpiry || undefined}
                onChange={(e) => setExpiryDate(e.target.value)}
              />
              <p className="mt-1.5 text-[12px] text-faint">
                A child can't outlive its parent, so there's no "never" here. At expiry the name lapses
                and the gateway refuses it.
              </p>
            </div>

            <div className="rounded-lg border border-line bg-sunken p-4">
              <p className="font-mono text-[13px] text-ink">{fullName}</p>
              <dl className="mt-3 space-y-1.5 text-[12.5px]">
                {(
                  [
                    ['Parent', parent.name],
                    ['Budget', money(typeof budget === 'number' ? budget : 0)],
                    ['Max per call', money(perCall)],
                    ['Services', services.join(', ')],
                    ['Expires', Number.isFinite(expiryMs) ? formatDate(new Date(expiryMs).toISOString()) : '—'],
                    ['Owner', live.account ? `${live.account.slice(0, 6)}…${live.account.slice(-4)}` : 'Your connected wallet'],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="flex items-baseline justify-between gap-4">
                    <dt className="text-muted">{k}</dt>
                    <dd className="numeric truncate text-ink">{v}</dd>
                  </div>
                ))}
              </dl>
              <ol className="mt-3.5 space-y-1 border-t border-hairline pt-3.5 text-[12.5px]">
                {(
                  [
                    ['mint', 'MandateRegistrar.registerChild — mints the name, checks budget and expiry'],
                    ['records', 'Resolver multicall — writes the four text records'],
                  ] as const
                ).map(([key, text], i) => (
                  <li
                    key={key}
                    className={cx(
                      'flex gap-2',
                      progress === key ? 'text-authority' : 'text-muted',
                    )}
                  >
                    <span className="numeric w-4 shrink-0">{i + 1}.</span>
                    {text}
                    {progress === key && <span className="shrink-0">— confirm in your wallet…</span>}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}

        {error && (
          <p className="copy mt-4 rounded-md border border-blocked/40 bg-blocked/[0.07] px-3 py-2.5 text-[12.5px] text-blocked">
            {error}
          </p>
        )}
      </div>

      <ModalFoot>
        <Button variant="ghost" disabled={busy} onClick={step === 0 ? onClose : () => setStep((s) => (s - 1) as Step)}>
          {step === 0 ? 'Cancel' : 'Back'}
        </Button>
        {step < 3 ? (
          <Button variant="primary" disabled={!stepValid} onClick={() => setStep((s) => (s + 1) as Step)}>
            Continue
          </Button>
        ) : (
          <Button variant="primary" disabled={!stepValid || busy} onClick={submit}>
            {busy ? 'Waiting for wallet…' : 'Sign 2 transactions'}
          </Button>
        )}
      </ModalFoot>
    </Modal>
  )
}
