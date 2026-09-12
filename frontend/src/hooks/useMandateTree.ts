import { useCallback, useEffect, useState } from 'react'
import type { TrackedMandateNode } from '../types'

const STORAGE_KEY = 'leash.mandate-tree.v1'

function load(): Record<string, TrackedMandateNode> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, TrackedMandateNode>) : {}
  } catch {
    return {}
  }
}

/**
 * The gateway has no `GET` for mandate state today — `POST /v1/mandate/seed`
 * and `/revoke` are write-only (see crates/gateway/src/routes.rs). So this
 * tracks, client-side, what *this dashboard* has seeded or revoked. It's an
 * accurate picture of everything done through this UI, but it can't see a
 * node seeded by someone else (e.g. via curl) on the same gateway — that's
 * the next thing to fix once a `GET /v1/mandate/tree` endpoint exists.
 */
export function useMandateTree() {
  const [nodes, setNodes] = useState<Record<string, TrackedMandateNode>>(load)

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes))
  }, [nodes])

  const upsert = useCallback((node: TrackedMandateNode) => {
    setNodes((prev) => ({ ...prev, [node.name]: node }))
  }, [])

  // Revoking a node cascades to every descendant in this local view, since
  // that's exactly what the real ancestor-walk in MandateGuard::check does
  // to the next real payment attempt under it.
  const revoke = useCallback((name: string) => {
    setNodes((prev) => {
      const next = { ...prev }
      const stack = [name]
      while (stack.length > 0) {
        const current = stack.pop()!
        if (next[current]) {
          next[current] = { ...next[current], revoked: true }
        }
        for (const candidate of Object.values(prev)) {
          if (candidate.parent === current) stack.push(candidate.name)
        }
      }
      return next
    })
  }, [])

  const remove = useCallback((name: string) => {
    setNodes((prev) => {
      const next = { ...prev }
      delete next[name]
      return next
    })
  }, [])

  return { nodes, upsert, revoke, remove }
}
