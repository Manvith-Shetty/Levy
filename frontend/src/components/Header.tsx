import { hashscanTopic } from '../api'
import { formatHbar } from '../format'
import type { ServiceManifest } from '../types'

interface Props {
  manifest: ServiceManifest | null
  error: string | null
}

export function Header({ manifest, error }: Props) {
  return (
    <header className="border-b border-slate-800 bg-slate-950/60">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-5">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-100">
            Leash <span className="text-slate-500">/ mandate control</span>
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Recursive, revocable spending mandates for autonomous agents on Hedera.
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-rose-900 bg-rose-950/60 px-3 py-2 text-sm text-rose-300">
            Can't reach the gateway — {error}
          </div>
        )}

        {manifest && (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <Stat label="Provider" value={manifest.provider} />
            <Stat label="Network" value={manifest.network} mono />
            <Stat label="Min. charge" value={formatHbar(manifest.pricing.minimum)} />
            <Stat
              label="Receipts topic"
              value={manifest.receipts_topic ?? 'disabled'}
              href={
                manifest.receipts_topic
                  ? hashscanTopic(manifest.network, manifest.receipts_topic)
                  : undefined
              }
              mono
            />
          </dl>
        )}
      </div>
    </header>
  )
}

function Stat({
  label,
  value,
  href,
  mono,
}: {
  label: string
  value: string
  href?: string
  mono?: boolean
}) {
  const valueClass = mono ? 'font-mono text-xs' : 'text-sm'
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={`${valueClass} text-emerald-400 hover:underline`}
        >
          {value}
        </a>
      ) : (
        <dd className={`${valueClass} text-slate-200`}>{value}</dd>
      )}
    </div>
  )
}
