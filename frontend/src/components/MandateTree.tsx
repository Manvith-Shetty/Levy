import { useState } from 'react'
import { ApiError, revokeMandate } from '../api'
import { formatHbar, hbarToAtomic, timeUntil } from '../format'
import type { TrackedMandateNode } from '../types'

interface Props {
  nodes: Record<string, TrackedMandateNode>
  onRevoked: (name: string) => void
  onRemoved: (name: string) => void
}

export function MandateTree({ nodes, onRevoked, onRemoved }: Props) {
  const roots = Object.values(nodes).filter((n) => !n.parent || !nodes[n.parent])

  if (roots.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-800 p-8 text-center text-sm text-slate-500">
        No mandates seeded yet from this dashboard. Use the form to create a root.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {roots.map((root) => (
        <TreeNode
          key={root.name}
          node={root}
          nodes={nodes}
          depth={0}
          onRevoked={onRevoked}
          onRemoved={onRemoved}
        />
      ))}
    </div>
  )
}

function TreeNode({
  node,
  nodes,
  depth,
  onRevoked,
  onRemoved,
}: {
  node: TrackedMandateNode
  nodes: Record<string, TrackedMandateNode>
  depth: number
  onRevoked: (name: string) => void
  onRemoved: (name: string) => void
}) {
  const [revoking, setRevoking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const children = Object.values(nodes).filter((n) => n.parent === node.name)
  const until = timeUntil(node.expiresAt)
  const dead = node.revoked || until.expired

  const handleRevoke = async () => {
    setError(null)
    setRevoking(true)
    try {
      await revokeMandate({ name: node.name })
      onRevoked(node.name)
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err),
      )
    } finally {
      setRevoking(false)
    }
  }

  return (
    <div style={{ marginLeft: depth * 24 }}>
      <div
        className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 ${
          dead
            ? 'border-rose-900/60 bg-rose-950/20'
            : until.soon
              ? 'border-amber-900/60 bg-amber-950/10'
              : 'border-slate-800 bg-slate-900/40'
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot dead={dead} soon={until.soon} />
            <span className="truncate font-mono text-sm text-slate-100">{node.name}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500">
            <span>budget {formatHbar(hbarToAtomic(node.budgetHbar))}</span>
            <span>max/call {formatHbar(hbarToAtomic(node.maxPerCallHbar))}</span>
            <span className={dead ? 'text-rose-400' : until.soon ? 'text-amber-400' : ''}>
              {node.revoked ? 'revoked' : until.label}
            </span>
            {node.allowedServices.length > 0 && (
              <span>services: {node.allowedServices.join(', ')}</span>
            )}
          </div>
          {error && <p className="mt-1 text-xs text-rose-400">{error}</p>}
        </div>

        <div className="flex shrink-0 gap-2">
          {!dead && (
            <button
              onClick={handleRevoke}
              disabled={revoking}
              className="rounded-md border border-rose-800 px-3 py-1 text-xs font-medium text-rose-300 transition hover:bg-rose-950 disabled:opacity-50"
            >
              {revoking ? 'Revoking…' : 'Revoke'}
            </button>
          )}
          <button
            onClick={() => onRemoved(node.name)}
            title="Remove from this dashboard's local view only — does not affect the gateway"
            className="rounded-md border border-slate-700 px-3 py-1 text-xs font-medium text-slate-400 transition hover:bg-slate-800"
          >
            Untrack
          </button>
        </div>
      </div>

      {children.length > 0 && (
        <div className="mt-2 space-y-2 border-l border-slate-800 pl-4">
          {children.map((child) => (
            <TreeNode
              key={child.name}
              node={child}
              nodes={nodes}
              depth={0}
              onRevoked={onRevoked}
              onRemoved={onRemoved}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function StatusDot({ dead, soon }: { dead: boolean; soon: boolean }) {
  const color = dead ? 'bg-rose-500' : soon ? 'bg-amber-400' : 'bg-emerald-400'
  return <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} />
}
