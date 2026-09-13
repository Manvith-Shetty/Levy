import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLeash } from '../../lib/store'
import { amountIn, cx, money, shortHash, timeAgo } from '../../lib/utils'
import { KIND_LABEL } from '../activity/eventMeta'
import { IconSearch } from './icons'

interface Entry {
  id: string
  group: string
  label: string
  detail?: string
  run: () => void
}

export function CommandMenu({
  open,
  onClose,
  onCreateAgent,
  onRunAgent,
}: {
  open: boolean
  onClose: () => void
  onCreateAgent: () => void
  /** Only in live mode, where there's a real agent runner to call. */
  onRunAgent?: () => void
}) {
  const navigate = useNavigate()
  const { agents, events, policies } = useLeash()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const entries = useMemo<Entry[]>(() => {
    const go = (to: string) => () => {
      onClose()
      navigate(to)
    }

    const list: Entry[] = [
      {
        id: 'act-create',
        group: 'Actions',
        label: 'Create Agent',
        run: () => {
          onClose()
          onCreateAgent()
        },
      },
      { id: 'act-activity', group: 'Actions', label: 'View Activity', run: go('/activity') },
    ]
    if (onRunAgent) {
      list.splice(1, 0, {
        id: 'act-run',
        group: 'Actions',
        label: 'Run a paid request',
        run: () => {
          onClose()
          onRunAgent()
        },
      })
    }

    for (const agent of agents) {
      list.push({
        id: `agent-${agent.id}`,
        group: 'Agents',
        label: agent.name,
        detail: `${money(agent.authority)} authority · ${money(agent.spent)} spent`,
        run: go(`/agents/${agent.id}`),
      })
    }

    for (const policy of policies) {
      list.push({
        id: `policy-${policy.id}`,
        group: 'Policies',
        label: policy.name,
        detail: `Max ${money(policy.maxTransaction)} per payment`,
        run: go('/policies'),
      })
    }

    for (const event of events.filter((e) => e.txId).slice(0, 40)) {
      const agent = agents.find((a) => a.id === event.agentId)
      list.push({
        id: `tx-${event.id}`,
        group: 'Transactions',
        label: shortHash(event.txId!, 10, 6),
        detail: `${agent?.name ?? event.agentId} · ${event.amount ? amountIn(event.amount, event.assetSymbol) : KIND_LABEL[event.kind]} · ${timeAgo(event.timestamp)}`,
        run: go(`/activity?event=${event.id}`),
      })
    }

    const order = ['Agents', 'Transactions', 'Policies', 'Actions']
    return list.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group))
  }, [agents, events, policies, navigate, onClose, onCreateAgent, onRunAgent])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? entries.filter(
          (e) =>
            e.label.toLowerCase().includes(q) || (e.detail?.toLowerCase().includes(q) ?? false),
        )
      : [
          ...entries.filter((e) => e.group === 'Agents').slice(0, 4),
          ...entries.filter((e) => e.group === 'Transactions').slice(0, 3),
          ...entries.filter((e) => e.group === 'Policies').slice(0, 3),
          ...entries.filter((e) => e.group === 'Actions'),
        ]
    return filtered.slice(0, 24)
  }, [entries, query])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose()
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCursor((c) => Math.min(results.length - 1, c + 1))
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCursor((c) => Math.max(0, c - 1))
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        results[cursor]?.run()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, results, cursor, onClose])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-70 flex items-start justify-center p-4 pt-[12vh]">
      <button type="button" aria-label="Close search" onClick={onClose} className="fixed inset-0 bg-[#040507]/80 backdrop-blur-[2px]" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        className="animate-enter relative w-full max-w-xl overflow-hidden rounded-xl border border-line bg-surface shadow-[var(--shadow-floating)]"
      >
        <div className="flex items-center gap-3 border-b border-hairline px-4">
          <IconSearch className="h-4 w-4 shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(0)
            }}
            placeholder="Search agents, transactions, policies..."
            className="h-13 w-full bg-transparent text-[14px] text-ink placeholder:text-faint focus:outline-none"
          />
          <kbd className="rounded border border-line bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-faint">esc</kbd>
        </div>

        <div className="max-h-[52vh] overflow-y-auto py-2">
          {results.length === 0 && (
            <p className="px-4 py-8 text-center text-[13px] text-muted">
              Nothing matches “{query}”. Try an agent name or a transaction hash.
            </p>
          )}
          {results.map((entry, i) => {
            const header = i === 0 || results[i - 1].group !== entry.group ? entry.group : null
            return (
              <div key={entry.id}>
                {header && (
                  <p className="px-4 pt-3 pb-1 text-[11.5px] text-faint">{header}</p>
                )}
                <button
                  type="button"
                  onMouseEnter={() => setCursor(i)}
                  onClick={entry.run}
                  className={cx(
                    'press flex w-full items-center justify-between gap-4 px-4 py-2 text-left',
                    i === cursor ? 'bg-raised' : '',
                  )}
                >
                  <span className="truncate text-[13px] text-ink">{entry.label}</span>
                  {entry.detail && (
                    <span className="shrink-0 truncate text-[12px] text-muted">{entry.detail}</span>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
