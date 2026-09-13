import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useLeash } from '../lib/store'
import { useUI } from '../app/ui'
import type { ActivityKind } from '../lib/types'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/common/Button'
import { Card } from '../components/common/Card'
import { Select, TextInput } from '../components/common/Field'
import { ActivityFeed } from '../components/activity/ActivityFeed'
import { KIND_LABEL, describe } from '../components/activity/eventMeta'
import { IconDownload } from '../components/layout/icons'
import { useToast } from '../app/toast'
import { formatDateTime } from '../lib/utils'

const KINDS: ActivityKind[] = [
  'payment.approved',
  'payment.blocked',
  'agent.created',
  'authority.delegated',
  'agent.revoked',
  'policy.changed',
]

const WINDOWS = [
  { id: 0, label: 'Date: All time' },
  { id: 1, label: 'Today' },
  { id: 7, label: 'Last 7 days' },
  { id: 30, label: 'Last 30 days' },
]

export function Activity() {
  const { agents, events, index } = useLeash()
  const ui = useUI()
  const { push } = useToast()
  const [params, setParams] = useSearchParams()

  const [query, setQuery] = useState('')
  const [agentId, setAgentId] = useState(params.get('agent') ?? 'all')
  const [kind, setKind] = useState<'all' | ActivityKind>('all')
  const [days, setDays] = useState(0)
  const [outcome, setOutcome] = useState<'all' | 'approved' | 'blocked'>('all')

  // Deep link from the command palette: open the event drawer on arrival.
  useEffect(() => {
    const eventId = params.get('event')
    if (!eventId) return
    const event = events.find((e) => e.id === eventId)
    if (event) ui.openEvent(event)
    params.delete('event')
    setParams(params, { replace: true })
  }, [params, events, ui, setParams])

  const filtered = useMemo(() => {
    const since = days > 0 ? Date.now() - days * 86_400_000 : 0
    return events.filter((event) => {
      if (agentId !== 'all' && event.agentId !== agentId && event.targetAgentId !== agentId)
        return false
      if (kind !== 'all' && event.kind !== kind) return false
      if (outcome !== 'all') {
        const blocked = event.kind === 'payment.blocked' || event.kind === 'agent.revoked'
        if ((outcome === 'blocked') !== blocked) return false
      }
      if (since && new Date(event.timestamp).getTime() < since) return false
      if (query) {
        const haystack = `${describe(event, index)} ${event.txId ?? ''} ${event.reason ?? ''}`
        if (!haystack.toLowerCase().includes(query.toLowerCase())) return false
      }
      return true
    })
  }, [events, agentId, kind, days, query, index, outcome])

  function exportCsv() {
    const rows = [
      ['timestamp', 'event', 'agent', 'amount', 'service', 'status', 'reason', 'transaction'],
      ...filtered.map((event) => [
        formatDateTime(event.timestamp),
        KIND_LABEL[event.kind],
        index[event.agentId]?.name ?? event.agentId,
        event.amount?.toFixed(6) ?? '',
        event.service ?? '',
        event.kind === 'payment.blocked' ? 'denied' : 'ok',
        event.reason ?? '',
        event.txId ?? '',
      ]),
    ]
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `leash-activity-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
    push({ tone: 'info', title: 'Activity exported', body: `${filtered.length} events written to CSV.` })
  }

  return (
    <>
      <PageHeader
        title="Activity"
        subtitle="Every authorization, delegation and payment event."
        action={
          <Button variant="secondary" onClick={exportCsv}>
            <IconDownload className="h-3.5 w-3.5" />
            Export
          </Button>
        }
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline p-4">
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search..."
            className="w-full sm:w-60"
          />
          <Select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="w-full sm:w-44"
          >
            <option value="all">Agent: All</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </Select>
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            className="w-full sm:w-48"
          >
            <option value="all">Action: All</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
          <Select
            value={outcome}
            onChange={(e) => setOutcome(e.target.value as typeof outcome)}
            className="w-full sm:w-36"
          >
            <option value="all">Status: All</option>
            <option value="approved">Approved</option>
            <option value="blocked">Denied</option>
          </Select>
          <Select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="w-full sm:w-36"
          >
            {WINDOWS.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="px-3 py-2">
          <ActivityFeed
            events={filtered.slice(0, 120)}
            onSelect={ui.openEvent}
            emptyBody="Nothing matches these filters. Widen the date range or clear the search."
          />
        </div>
      </Card>
    </>
  )
}
