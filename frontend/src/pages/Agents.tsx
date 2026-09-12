import { useMemo, useState } from 'react'
import { useLeash } from '../lib/store'
import { useUI } from '../app/ui'
import { deriveStatus } from '../lib/selectors'
import type { AgentStatus } from '../lib/types'
import { STATUS_LABEL } from '../lib/utils'
import type { Agent } from '../lib/types'
import { PageHeader } from '../components/layout/PageHeader'
import { Button } from '../components/common/Button'
import { Card } from '../components/common/Card'
import { AgentTable } from '../components/agents/AgentTable'
import { Select, TextInput } from '../components/common/Field'
import { IconPlus } from '../components/layout/icons'

const STATUSES: AgentStatus[] = ['active', 'warning', 'expired', 'suspended', 'revoked']

export function Agents() {
  const { agents, index } = useLeash()
  const ui = useUI()
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<'all' | AgentStatus>('all')
  const [parent, setParent] = useState<'all' | string>('all')
  const [type, setType] = useState<'all' | 'root' | 'delegating' | 'leaf'>('all')

  const parents = useMemo(
    () => agents.filter((a) => a.children.length > 0),
    [agents],
  )

  const ordered = useMemo(() => {
    // Depth-first so the table reads like the tree.
    const out: typeof agents = []
    const walk = (id: string) => {
      const agent = index[id]
      if (!agent) return
      out.push(agent)
      for (const child of agent.children) walk(child)
    }
    for (const root of agents.filter((a) => !a.parentId)) walk(root.id)
    for (const agent of agents) if (!out.includes(agent)) out.push(agent)
    return out
  }, [agents, index])

  const filtered = ordered.filter((agent) => {
    if (query && !agent.name.toLowerCase().includes(query.toLowerCase())) return false
    if (status !== 'all' && deriveStatus(agent, index) !== status) return false
    if (parent !== 'all' && agent.parentId !== parent) return false
    if (type !== 'all' && typeOf(agent) !== type) return false
    return true
  })

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Manage your agent hierarchy and spending authority."
        action={
          <Button variant="primary" onClick={() => ui.openCreate()}>
            <IconPlus className="h-3.5 w-3.5" />
            Create Agent
          </Button>
        }
      />

      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-2 border-b border-hairline p-4">
          <TextInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents..."
            className="w-full sm:w-56"
          />
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            className="w-full sm:w-40"
          >
            <option value="all">Status: All</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
            className="w-full sm:w-36"
          >
            <option value="all">Type: All</option>
            <option value="root">Root</option>
            <option value="delegating">Delegating</option>
            <option value="leaf">Leaf</option>
          </Select>
          <Select
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            className="w-full sm:w-48"
          >
            <option value="all">Parent: All</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>

        <div className="p-4">
          <AgentTable
            agents={filtered}
            onRevoke={ui.openRevoke}
            onCreateChild={(agent) => ui.openCreate(agent.id)}
            emptyBody={
              query
                ? `No agent matches “${query}”. Clear the search to see every agent.`
                : 'No agents match these filters.'
            }
          />
        </div>
      </Card>
    </>
  )
}

function typeOf(agent: Agent): 'root' | 'delegating' | 'leaf' {
  if (!agent.parentId) return 'root'
  return agent.children.length > 0 ? 'delegating' : 'leaf'
}
