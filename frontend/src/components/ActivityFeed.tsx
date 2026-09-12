import { getReceipts, hashscanTx } from '../api'
import { formatHbar, timeAgo } from '../format'
import { usePolling } from '../hooks/usePolling'

export function ActivityFeed() {
  const { data: receipts, error } = usePolling(getReceipts, 3000)

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50">
      <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-200">Settlement activity</h2>
        <span className="flex items-center gap-1.5 text-xs text-slate-500">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          live
        </span>
      </div>

      {error && (
        <p className="px-5 py-4 text-sm text-rose-400">Couldn't load receipts — {error}</p>
      )}

      {receipts && receipts.length === 0 && (
        <p className="px-5 py-8 text-center text-sm text-slate-500">
          No settlements yet. Run the agent to pay for a request.
        </p>
      )}

      {receipts && receipts.length > 0 && (
        <ul className="divide-y divide-slate-800">
          {[...receipts].reverse().map((receipt) => (
            <li key={receipt.transaction_id} className="px-5 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-sm text-slate-100">{receipt.payer}</span>
                  <span className="text-xs text-slate-500">paid</span>
                  <span className="text-sm font-medium text-emerald-400">
                    {formatHbar(receipt.amount)}
                  </span>
                </div>
                <span className="text-xs text-slate-500">{timeAgo(receipt.settled_at)}</span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                <span>{receipt.provider}</span>
                <span>
                  {receipt.usage.input_tokens} in / {receipt.usage.output_tokens} out tok
                </span>
                {receipt.mandate_path.length > 0 && (
                  <span>
                    mandate:{' '}
                    <span className="font-mono">
                      {receipt.mandate_path.map((h) => h.name).join(' → ')}
                    </span>
                  </span>
                )}
                <a
                  href={hashscanTx(receipt.network, receipt.transaction_id)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-emerald-400 hover:underline"
                >
                  {receipt.transaction_id}
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
