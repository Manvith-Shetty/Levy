import { useState } from 'react'
import { ApiError, seedMandate } from '../api'
import { hbarToAtomic } from '../format'
import type { TrackedMandateNode } from '../types'

interface Props {
  existingNames: string[]
  onSeeded: (node: TrackedMandateNode) => void
}

const DAY = 24 * 60 * 60
const EXPIRY_PRESETS = [
  { label: '1 hour', secs: 60 * 60 },
  { label: '1 day', secs: DAY },
  { label: '30 days', secs: 30 * DAY },
  { label: '90 days', secs: 90 * DAY },
]

export function SeedForm({ existingNames, onSeeded }: Props) {
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [budget, setBudget] = useState('1')
  const [maxPerCall, setMaxPerCall] = useState('0.05')
  const [ratePerMinute, setRatePerMinute] = useState('0.05')
  const [allowedServices, setAllowedServices] = useState('inference')
  const [expiresInSecs, setExpiresInSecs] = useState(EXPIRY_PRESETS[2].secs)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const services = allowedServices
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)

      await seedMandate({
        name,
        parent: parent || null,
        budget: hbarToAtomic(Number(budget)),
        max_per_call: hbarToAtomic(Number(maxPerCall)),
        rate_per_minute: hbarToAtomic(Number(ratePerMinute)),
        allowed_services: services,
        expires_in_secs: expiresInSecs,
      })

      onSeeded({
        name,
        parent: parent || null,
        budgetHbar: Number(budget),
        maxPerCallHbar: Number(maxPerCall),
        ratePerMinuteHbar: Number(ratePerMinute),
        allowedServices: services,
        seededAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + expiresInSecs * 1000).toISOString(),
        revoked: false,
      })

      setName('')
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/50 p-5"
    >
      <h2 className="text-sm font-semibold text-slate-200">Seed a mandate node</h2>
      <p className="text-xs text-slate-500">
        Only takes effect when the gateway is running with{' '}
        <code className="rounded bg-slate-800 px-1 py-0.5">MANDATE_MODE=mock</code>.
      </p>

      <Field label="ENS subname">
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="k8s-agent.root.leash.eth"
          className={inputClass}
        />
      </Field>

      <Field label="Parent (leave blank for root)">
        <select value={parent} onChange={(e) => setParent(e.target.value)} className={inputClass}>
          <option value="">None — this is a root</option>
          {existingNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Field>

      <div className="grid grid-cols-3 gap-3">
        <Field label="Budget (HBAR)">
          <input
            type="number"
            step="any"
            min="0"
            required
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Max per call (HBAR)">
          <input
            type="number"
            step="any"
            min="0"
            value={maxPerCall}
            onChange={(e) => setMaxPerCall(e.target.value)}
            className={inputClass}
          />
        </Field>
        <Field label="Rate / min (HBAR)">
          <input
            type="number"
            step="any"
            min="0"
            value={ratePerMinute}
            onChange={(e) => setRatePerMinute(e.target.value)}
            className={inputClass}
          />
        </Field>
      </div>

      <Field label="Allowed services (comma-separated)">
        <input
          value={allowedServices}
          onChange={(e) => setAllowedServices(e.target.value)}
          className={inputClass}
        />
      </Field>

      <Field label="Expires in">
        <div className="flex flex-wrap gap-2">
          {EXPIRY_PRESETS.map((preset) => (
            <button
              key={preset.secs}
              type="button"
              onClick={() => setExpiresInSecs(preset.secs)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                expiresInSecs === preset.secs
                  ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40'
                  : 'bg-slate-800 text-slate-400 hover:bg-slate-700'
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </Field>

      {error && <p className="text-xs text-rose-400">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-50"
      >
        {submitting ? 'Seeding…' : 'Seed mandate'}
      </button>
    </form>
  )
}

const inputClass =
  'w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-emerald-500'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-400">{label}</span>
      {children}
    </label>
  )
}
