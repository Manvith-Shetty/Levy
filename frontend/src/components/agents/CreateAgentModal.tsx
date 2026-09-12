import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLeash } from '../../lib/store'
import { statsFor } from '../../lib/selectors'
import type { AgentDraft, ResourceKind } from '../../lib/types'
import { cx, money, RESOURCES, ratio, resourceLabel } from '../../lib/utils'
import { Modal, ModalFoot, ModalHead } from '../common/Modal'
import { Button } from '../common/Button'
import { Checkbox, DecimalInput, Label, MoneyInput, Radio, Select, TextInput, Textarea } from '../common/Field'
import { useToast } from '../../app/toast'

const STEPS = ['Identity', 'Authority', 'Permissions', 'Expiration'] as const
type Step = 0 | 1 | 2 | 3

const INSTANCE_TYPES = ['g4dn.xlarge', 'g5.xlarge', 'p4d.24xlarge', 'c7g.large']

function defaultDraft(parentId: string): AgentDraft {
  const in30 = new Date(Date.now() + 30 * 86_400_000)
  return {
    name: '',
    description: '',
    parentId,
    authority: 0,
    resources: ['compute'],
    limits: {},
    provider: 'AWS',
    instanceTypes: ['g4dn.xlarge'],
    maxHourlyCost: 2.5,
    expires: true,
    expiresDate: in30.toISOString().slice(0, 10),
    expiresTime: '23:59',
    onExpiry: 'revoke',
  }
}

export function CreateAgentModal({
  open,
  onClose,
  parentId,
}: {
  open: boolean
  onClose: () => void
  parentId?: string
}) {
  const { agents, index, createAgent, policies } = useLeash()
  const { push } = useToast()
  const navigate = useNavigate()

  const fallbackParent = parentId ?? agents.find((a) => !a.parentId)?.id ?? agents[0]?.id ?? ''
  const [draft, setDraft] = useState<AgentDraft>(() => defaultDraft(fallbackParent))
  const [step, setStep] = useState<Step>(0)
  const [error, setError] = useState<string | null>(null)
  const [budgetInput, setBudgetInput] = useState<number | ''>('')

  const parent = index[draft.parentId]
  const parentStats = parent ? statsFor(index, parent.id) : undefined
  const available = parentStats?.available ?? 0
  const overBudget = typeof budgetInput === 'number' && budgetInput > available

  const eligibleParents = useMemo(
    () => agents.filter((a) => a.status !== 'revoked' && statsFor(index, a.id).available > 0),
    [agents, index],
  )

  const parentPolicy = policies.find((p) => p.id === parent?.policyId)

  function patch(next: Partial<AgentDraft>) {
    setDraft((prev) => ({ ...prev, ...next }))
    setError(null)
  }

  function reset() {
    setDraft(defaultDraft(fallbackParent))
    setBudgetInput('')
    setStep(0)
    setError(null)
  }

  function close() {
    reset()
    onClose()
  }

  const stepValid = (() => {
    if (step === 0) return draft.name.trim().length > 1 && Boolean(parent)
    if (step === 1) return typeof budgetInput === 'number' && budgetInput > 0 && !overBudget
    if (step === 2) return draft.resources.length > 0
    return true
  })()

  function next() {
    if (!stepValid) {
      if (step === 1 && overBudget) {
        setError(
          `${parent?.name} has ${money(available)} left to delegate. Lower the budget to continue.`,
        )
      }
      return
    }
    if (step === 1) patch({ authority: Number(budgetInput) })
    setStep((s) => Math.min(3, s + 1) as Step)
  }

  function submit() {
    const result = createAgent({ ...draft, authority: Number(budgetInput) })
    if (!result.ok || !result.agent) {
      setError(result.error ?? 'Could not create the agent.')
      push({ tone: 'blocked', title: 'Agent not created', body: result.error })
      return
    }
    push({
      tone: 'success',
      title: 'Agent created',
      body: `${result.agent.name} was successfully created.`,
    })
    const id = result.agent.id
    close()
    navigate(`/agents/${id}`)
  }

  if (!open) return null

  return (
    <Modal open onClose={close} width="max-w-2xl" labelledBy="create-title">
      <ModalHead
        id="create-title"
        title="Create Agent"
        onClose={close}
      >
        <ol className="mt-4 flex items-center gap-1.5">
          {STEPS.map((label, i) => (
            <li key={label} className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={i > step}
                onClick={() => setStep(i as Step)}
                className={cx(
                  'text-[12.5px] disabled:cursor-default',
                  i === step ? 'text-ink' : i < step ? 'text-authority' : 'text-faint',
                )}
              >
                {label}
              </button>
              {i < STEPS.length - 1 && (
                <span
                  aria-hidden
                  className={cx('h-px w-6', i < step ? 'bg-authority/50' : 'bg-line')}
                />
              )}
            </li>
          ))}
        </ol>
      </ModalHead>

      <div className="max-h-[min(60vh,34rem)] overflow-y-auto px-6 py-5">
        {step === 0 && (
          <div className="space-y-4">
            <div>
              <Label htmlFor="agent-name">Agent name</Label>
              <TextInput
                id="agent-name"
                autoFocus
                value={draft.name}
                placeholder="GPU Compute Agent"
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
            <div>
              <Label htmlFor="agent-desc" hint="Optional">
                Description
              </Label>
              <Textarea
                id="agent-desc"
                value={draft.description}
                placeholder="Runs GPU workloads for ML jobs"
                onChange={(e) => patch({ description: (e.target as HTMLTextAreaElement).value })}
              />
            </div>
            <div>
              <Label htmlFor="agent-parent">Parent agent</Label>
              <Select
                id="agent-parent"
                value={draft.parentId}
                onChange={(e) => patch({ parentId: e.target.value })}
              >
                {eligibleParents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {money(statsFor(index, a.id).available)} free
                  </option>
                ))}
              </Select>
            </div>
          </div>
        )}

        {step === 1 && parent && parentStats && (
          <div className="space-y-5">
            <div>
              <h3 className="text-[15px] font-semibold text-ink">Define authority</h3>
              <p className="copy mt-0.5 text-[13px] text-muted">
                How much authority should this agent receive?
              </p>
            </div>
            <div>
              <Label htmlFor="agent-budget">Maximum budget</Label>
              <MoneyInput
                id="agent-budget"
                value={budgetInput}
                onValueChange={setBudgetInput}
                max={available}
                invalid={overBudget}
              />
            </div>

            <ParentConstraint
              parentName={parent.name}
              authority={parent.authority}
              spent={parent.spent}
              delegated={parentStats.delegated}
              available={available}
              requested={typeof budgetInput === 'number' ? budgetInput : 0}
            />
          </div>
        )}

        {step === 2 && (
          <div className="space-y-5">
            <div>
              <h3 className="mb-2.5 text-[15px] font-semibold text-ink">Allowed services</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {RESOURCES.map((resource) => {
                  const parentAllows =
                    parent?.permissions.find((p) => p.resource === resource.id)?.allowed ?? false
                  return (
                    <Checkbox
                      key={resource.id}
                      checked={draft.resources.includes(resource.id)}
                      disabled={!parentAllows}
                      label={resource.label}
                      hint={parentAllows ? undefined : `Not permitted for ${parent?.name}`}
                      onChange={(checked) =>
                        patch({
                          resources: checked
                            ? [...draft.resources, resource.id]
                            : draft.resources.filter((r) => r !== resource.id),
                        })
                      }
                    />
                  )
                })}
              </div>
            </div>

            <div className="rounded-lg border border-line bg-sunken p-4">
              <p className="text-[13px] font-medium text-ink">Spending limits</p>
              <div className="mt-3.5 grid gap-3 sm:grid-cols-3">
                {(
                  [
                    ['transaction', 'Per payment', parentPolicy?.maxTransaction],
                    ['daily', 'Per day', parentPolicy?.dailyLimit],
                    ['monthly', 'Per month', parentPolicy?.monthlyLimit],
                  ] as const
                ).map(([key, label, ceiling]) => (
                  <div key={key}>
                    <Label hint={ceiling ? `≤ ${money(ceiling)}` : undefined}>{label}</Label>
                    <DecimalInput
                      value={draft.limits[key] ?? ''}
                      placeholder={ceiling ? String(ceiling) : '—'}
                      onValueChange={(next) => {
                        const value = next === '' ? undefined : Math.min(next, ceiling ?? Infinity)
                        patch({ limits: { ...draft.limits, [key]: value } })
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>

            {draft.resources.includes('compute') && (
              <div className="rounded-lg border border-line bg-sunken p-4">
                <p className="text-[13px] font-medium text-ink">Compute</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>Provider</Label>
                    <Select
                      value={draft.provider}
                      onChange={(e) => patch({ provider: e.target.value })}
                    >
                      {(parentPolicy?.providers ?? ['AWS', 'GCP']).map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </Select>
                  </div>
                  <div>
                    <Label hint="per instance">Maximum hourly cost</Label>
                    <DecimalInput
                      value={draft.maxHourlyCost}
                      onValueChange={(next) => patch({ maxHourlyCost: next === '' ? 0 : next })}
                    />
                  </div>
                </div>
                <p className="mt-3.5 mb-2 text-[12.5px] text-muted">Allowed instance types</p>
                <div className="flex flex-wrap gap-1.5">
                  {INSTANCE_TYPES.map((type) => {
                    const on = draft.instanceTypes.includes(type)
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() =>
                          patch({
                            instanceTypes: on
                              ? draft.instanceTypes.filter((t) => t !== type)
                              : [...draft.instanceTypes, type],
                          })
                        }
                        className={cx(
                          'press rounded border px-2 py-1 font-mono text-[11.5px]',
                          on
                            ? 'border-authority/45 bg-authority/10 text-authority'
                            : 'border-line bg-raised text-muted hover:border-line-strong hover:text-ink',
                        )}
                      >
                        {type}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 3 && parent && (
          <div className="space-y-5">
            <h3 className="text-[15px] font-semibold text-ink">Authority expiration</h3>
            <div className="grid gap-2 sm:grid-cols-2">
              <Radio
                checked={!draft.expires}
                onChange={() => patch({ expires: false })}
                label="Never"
              />
              <Radio
                checked={draft.expires}
                onChange={() => patch({ expires: true })}
                label="Set expiration"
              />
            </div>

            {draft.expires && (
              <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
                <div>
                  <Label htmlFor="expiry-date">Date</Label>
                  <TextInput
                    id="expiry-date"
                    type="date"
                    value={draft.expiresDate}
                    onChange={(e) => patch({ expiresDate: e.target.value })}
                  />
                </div>
                <div>
                  <Label htmlFor="expiry-time">Time</Label>
                  <TextInput
                    id="expiry-time"
                    type="time"
                    value={draft.expiresTime}
                    onChange={(e) => patch({ expiresTime: e.target.value })}
                  />
                </div>
              </div>
            )}

            {draft.expires && (
              <div>
                <p className="mb-2 text-[12.5px] font-medium text-ink-dim">After expiration</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Radio
                    checked={draft.onExpiry === 'revoke'}
                    onChange={() => patch({ onExpiry: 'revoke' })}
                    label="Automatically revoke"
                  />
                  <Radio
                    checked={draft.onExpiry === 'freeze'}
                    onChange={() => patch({ onExpiry: 'freeze' })}
                    label="Freeze spending"
                  />
                </div>
              </div>
            )}

            <Summary
              draft={{ ...draft, authority: Number(budgetInput) }}
              parentName={parent.name}
              available={available}
            />
          </div>
        )}

        {error && (
          <p className="mt-4 rounded-md border border-blocked/40 bg-blocked/[0.07] px-3 py-2.5 text-[12.5px] text-blocked">
            {error}
          </p>
        )}
      </div>

      <ModalFoot>
        <Button variant="ghost" onClick={step === 0 ? close : () => setStep((s) => (s - 1) as Step)}>
          {step === 0 ? 'Cancel' : 'Back'}
        </Button>
        {step < 3 ? (
          <Button variant="primary" onClick={next} disabled={!stepValid}>
            Continue
          </Button>
        ) : (
          <Button variant="primary" onClick={submit}>
            Create Agent
          </Button>
        )}
      </ModalFoot>
    </Modal>
  )
}

/**
 * The screen that explains the whole product: the parent's ceiling, what it has
 * already committed, and the slice this new agent would take out of what's left.
 */
function ParentConstraint({
  parentName,
  authority,
  spent,
  delegated,
  available,
  requested,
}: {
  parentName: string
  authority: number
  spent: number
  delegated: number
  available: number
  requested: number
}) {
  const over = requested > available
  const pct = (value: number) => `${ratio(value, authority) * 100}%`
  const requestedPct = `${Math.min(ratio(requested, authority), ratio(available, authority)) * 100}%`

  return (
    <div className="rounded-lg border border-line bg-sunken p-4">
      <div className="flex items-baseline justify-between">
        <p className="text-[13px] font-medium text-ink">{parentName}</p>
        <p className="numeric text-[13px] text-muted">{money(authority)} authority</p>
      </div>

      <div className="mt-3 flex h-4 w-full overflow-hidden rounded bg-[#191c22]">
        <div className="bg-authority" style={{ width: pct(spent) }} title="Spent" />
        <div
          className="bg-delegated/55"
          style={{
            width: pct(delegated),
            backgroundImage:
              'repeating-linear-gradient(115deg, rgba(122,107,255,0.95) 0 3px, rgba(122,107,255,0.42) 3px 6px)',
          }}
          title="Already delegated"
        />
        <div
          className={cx(
            '',
            over ? 'bg-blocked/70' : 'bg-authority/35',
          )}
          style={{ width: requestedPct }}
          title="This agent"
        />
      </div>

      <dl className="mt-3.5 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-[repeat(auto-fit,minmax(104px,1fr))]">
        <Stat label="Parent authority" value={money(authority)} />
        <Stat label="Already delegated" value={money(delegated)} />
        {spent > 0 && <Stat label="Spent directly" value={money(spent)} />}
        <Stat label="Available to delegate" value={money(available)} tone="text-authority" />
        <Stat
          label="Remaining after"
          value={money(Math.max(0, available - requested))}
          tone={over ? 'text-blocked' : 'text-ink'}
        />
      </dl>

      {over ? (
        <div className="mt-3.5 rounded-md border border-blocked/40 bg-blocked/[0.07] px-3 py-2.5">
          <p className="text-[13px] font-medium text-blocked">✕ Cannot create agent</p>
          <dl className="numeric mt-1.5 grid gap-0.5 text-[12.5px]">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Requested authority</dt>
              <dd className="text-ink">{money(requested)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Available parent authority</dt>
              <dd className="text-ink">{money(available)}</dd>
            </div>
          </dl>
        </div>
      ) : (
        <p className="mt-3.5 flex gap-2 rounded-md border border-warn/30 bg-warn/[0.06] px-3 py-2.5 text-[12.5px] text-warn">
          <span aria-hidden>⚠</span>
          You cannot give this agent more than {money(available)}.
        </p>
      )}
    </div>
  )
}

function Stat({ label, value, tone = 'text-ink' }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="text-[11.5px] text-faint">{label}</dt>
      <dd className={cx('numeric mt-0.5 text-[14px] font-medium', tone)}>{value}</dd>
    </div>
  )
}

function Summary({
  draft,
  parentName,
  available,
}: {
  draft: AgentDraft
  parentName: string
  available: number
}) {
  const withinParent = draft.authority > 0 && draft.authority <= available
  const validExpiry =
    !draft.expires || new Date(`${draft.expiresDate}T${draft.expiresTime}`).getTime() > Date.now()
  const hasPolicy = draft.resources.length > 0

  const rows: [string, string][] = [
    ['Parent', parentName],
    ['Budget', money(draft.authority || 0)],
    ['Services', draft.resources.map((r: ResourceKind) => resourceLabel(r)).join(', ') || '—'],
    [
      'Expires',
      draft.expires
        ? `${new Date(`${draft.expiresDate}T${draft.expiresTime}`).toLocaleDateString()} · ${draft.expiresTime}`
        : 'Never',
    ],
  ]

  const checks: [boolean, string][] = [
    [withinParent, `Within ${parentName}'s remaining authority`],
    [hasPolicy, 'At least one service permitted'],
    [validExpiry, 'Expiration is in the future'],
  ]

  return (
    <div className="rounded-lg border border-line bg-sunken p-4">
      <p className="text-[13px] font-medium text-ink">{draft.name || 'New agent'}</p>
      <dl className="mt-3 space-y-1.5">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-4">
            <dt className="text-[12.5px] text-muted">{label}</dt>
            <dd className="numeric truncate text-[12.5px] text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <ul className="mt-3.5 space-y-1 border-t border-hairline pt-3.5">
        {checks.map(([ok, label]) => (
          <li
            key={label}
            className={cx('flex gap-2 text-[12.5px]', ok ? 'text-authority' : 'text-blocked')}
          >
            <span aria-hidden>{ok ? '✓' : '✕'}</span>
            {label}
          </li>
        ))}
      </ul>
    </div>
  )
}
