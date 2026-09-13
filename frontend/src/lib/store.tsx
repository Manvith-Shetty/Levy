import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { buildInitialState, SERVICES } from '../data/mockData'
import { config } from './config'
import { adapt, type LiveModel, type LiveSnapshot, type SourceKey } from './live/adapter'
import type { EnsNode } from './live/ens'
import { useLiveData } from './live/useLiveData'
import * as wallet from './live/wallet'
import { indexAgents, spentToday, statsFor } from './selectors'
import type {
  ActivityEvent,
  Agent,
  AgentDraft,
  Network,
  NotificationSettings,
  PaymentDecision,
  Policy,
  ResourceKind,
  Service,
} from './types'
import { makeId, makeTxId, money } from './utils'

interface LeashState {
  agents: Agent[]
  events: ActivityEvent[]
  policies: Policy[]
  services: Service[]
  network: Network
  demoMode: boolean
  notifications: NotificationSettings
}

export interface CreateResult {
  ok: boolean
  error?: string
  agent?: Agent
}

interface LeashActions {
  createAgent: (draft: AgentDraft) => CreateResult
  revokeAgent: (id: string) => void
  requestPayment: (input: { agentId: string; amount: number; service: string }) => PaymentDecision
  setNetwork: (network: Network) => void
  setDemoMode: (on: boolean) => void
  setNotification: (key: keyof NotificationSettings, value: boolean) => void
  reset: () => void
}

/** Everything about the live deployment the UI needs beyond the shared model. */
export interface LiveContext {
  /** True when the dashboard is showing live data rather than the demo. */
  active: boolean
  /** True once the first snapshot has arrived. */
  ready: boolean
  refreshing: boolean
  errors: Partial<Record<SourceKey, string>>
  warnings: string[]
  snapshot: LiveSnapshot | null
  nodes: Record<string, EnsNode>
  /** Re-reads every source now; `force` also retries a backed-off gateway. */
  refresh: (force?: boolean) => Promise<void>
  /** Browser wallet used to sign tree changes on Sepolia. */
  account?: string
  hasWallet: boolean
  connect: () => Promise<string>
  revoke: (agentId: string) => Promise<string>
  renew: (agentId: string) => Promise<string>
  create: (spec: wallet.ChildSpec, onStep: (step: wallet.CreateStep) => void) => Promise<string[]>
}

type LeashContextValue = LeashState & LeashActions & {
  index: Record<string, Agent>
  agentById: (id: string) => Agent | undefined
  policyFor: (agent?: Agent) => Policy | undefined
  live: LiveContext
}

const LeashContext = createContext<LeashContextValue | null>(null)

function initialState(): LeashState {
  const seed = buildInitialState()
  return {
    agents: seed.agents,
    events: seed.events,
    policies: seed.policies,
    services: seed.services,
    network: 'hedera-testnet',
    demoMode: config.defaultMode === 'demo',
    notifications: {
      nearingBudget: true,
      expiration: true,
      paymentBlocked: true,
      childCreated: true,
    },
  }
}

/** Which resource a service purchase counts against. */
function resourceForService(name: string): ResourceKind {
  const match = SERVICES.find((s) => s.name.toLowerCase() === name.toLowerCase())
  if (match) return match.resource
  const lowered = name.toLowerCase()
  if (lowered.includes('secret')) return 'secrets'
  if (lowered.includes('storage') || lowered.includes('s3')) return 'storage'
  if (lowered.includes('warehouse') || lowered.includes('db')) return 'database'
  if (lowered.includes('openai') || lowered.includes('infer')) return 'inference'
  if (lowered.includes('network') || lowered.includes('hedera')) return 'networking'
  return 'compute'
}

export function LeashProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LeashState>(initialState)

  // Actions need to read the current state to decide (and return) an outcome
  // before they write. The mirror is updated inside the updater, never during
  // render, so it can't drift from what React last committed.
  const ref = useRef(state)
  const commit = useCallback((update: (prev: LeashState) => LeashState) => {
    setState((prev) => {
      const next = update(prev)
      ref.current = next
      return next
    })
  }, [])

  // Live mode: the same model, built from Sepolia + Hedera instead of mock data.
  const liveData = useLiveData(!state.demoMode)
  const model: LiveModel | null = useMemo(
    () => (liveData.snapshot ? adapt(liveData.snapshot) : null),
    [liveData.snapshot],
  )
  const view = useMemo(
    () =>
      state.demoMode
        ? state
        : {
            ...state,
            agents: model?.agents ?? [],
            events: model?.events ?? [],
            policies: model?.policies ?? [],
            services: model?.services ?? [],
          },
    [state, model],
  )

  const index = useMemo(() => indexAgents(view.agents), [view.agents])

  const policyFor = useCallback(
    (agent?: Agent) => view.policies.find((p) => p.id === agent?.policyId),
    [view.policies],
  )

  // Browser wallet (Sepolia) for revoke / renew / create in live mode.
  const [account, setAccount] = useState<string | undefined>()
  useEffect(() => {
    if (state.demoMode || !wallet.hasInjectedWallet()) return
    void wallet.currentAccount().then(setAccount).catch(() => undefined)
    const onAccounts = (accounts: unknown) => {
      const [next] = (accounts as string[]) ?? []
      setAccount(next)
    }
    window.ethereum?.on?.('accountsChanged', onAccounts)
    return () => window.ethereum?.removeListener?.('accountsChanged', onAccounts)
  }, [state.demoMode])

  const nodeFor = useCallback(
    (agentId: string) => {
      const node = model?.nodes[agentId]
      if (!node) throw new Error(`${agentId} is not in the live tree.`)
      return node
    },
    [model],
  )

  const live = useMemo<LiveContext>(
    () => ({
      active: !state.demoMode,
      ready: Boolean(liveData.snapshot),
      refreshing: liveData.refreshing,
      errors: liveData.snapshot?.errors ?? {},
      warnings: model?.warnings ?? [],
      snapshot: liveData.snapshot,
      nodes: model?.nodes ?? {},
      refresh: liveData.refresh,
      account,
      hasWallet: wallet.hasInjectedWallet(),
      connect: async () => {
        const next = await wallet.connect()
        setAccount(next)
        return next
      },
      revoke: async (agentId) => {
        const hash = await wallet.revoke(nodeFor(agentId))
        await liveData.refresh()
        return hash
      },
      renew: async (agentId) => {
        const node = nodeFor(agentId)
        const parent = node.parent ? model?.nodes[node.parent] : undefined
        // Restore to the parent's expiry (a child can't usefully outlive it),
        // or 90 days out at the root — the same window the deploy used.
        const seconds = parent?.expiresAt
          ? Math.floor(parent.expiresAt / 1000)
          : Math.floor(Date.now() / 1000) + 90 * 86_400
        const hash = await wallet.renew(node, BigInt(seconds))
        await liveData.refresh()
        return hash
      },
      create: async (spec, onStep) => {
        const hashes = await wallet.createChild(spec, onStep)
        await liveData.refresh()
        return hashes
      },
    }),
    [state.demoMode, liveData, model, account, nodeFor],
  )

  const createAgent = useCallback((draft: AgentDraft): CreateResult => {
    const current = ref.current
    const idx = indexAgents(current.agents)
    const parent = idx[draft.parentId]
    if (!parent) return { ok: false, error: 'Pick a parent agent to delegate from.' }
    if (parent.status === 'revoked') {
      return { ok: false, error: `${parent.name} is revoked and cannot delegate.` }
    }

    const name = draft.name.trim()
    if (!name) return { ok: false, error: 'Give the agent a name.' }
    if (current.agents.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, error: `An agent named "${name}" already exists.` }
    }

    const { available } = statsFor(idx, parent.id)
    if (!(draft.authority > 0)) return { ok: false, error: 'Set a budget above $0.' }
    if (draft.authority > available) {
      return {
        ok: false,
        error: `${parent.name} has ${money(available)} left to delegate. Requested ${money(draft.authority)}.`,
      }
    }
    if (draft.resources.length === 0) {
      return { ok: false, error: 'Allow at least one service.' }
    }

    let expiresAt: string | undefined
    if (draft.expires) {
      const when = new Date(`${draft.expiresDate}T${draft.expiresTime || '23:59'}`)
      if (Number.isNaN(when.getTime())) return { ok: false, error: 'Enter a valid expiry date.' }
      if (when.getTime() <= Date.now()) return { ok: false, error: 'Expiry must be in the future.' }
      if (parent.expiresAt && when.getTime() > new Date(parent.expiresAt).getTime()) {
        return {
          ok: false,
          error: `Authority cannot outlive ${parent.name}, which expires first.`,
        }
      }
      expiresAt = when.toISOString()
    }

    const policy =
      current.policies.find((p) => p.id === draft.policyId) ??
      current.policies.find((p) => p.id === parent.policyId)

    const limits = {
      transaction: draft.limits.transaction ?? policy?.maxTransaction ?? draft.authority,
      daily: draft.limits.daily ?? policy?.dailyLimit ?? draft.authority,
      monthly: draft.limits.monthly ?? policy?.monthlyLimit ?? draft.authority,
    }

    const allResources: ResourceKind[] = [
      'compute',
      'storage',
      'database',
      'inference',
      'networking',
      'secrets',
    ]

    const agent: Agent = {
      id: makeId('agt'),
      name,
      description: draft.description.trim() || `Delegated by ${parent.name}.`,
      parentId: parent.id,
      children: [],
      authority: draft.authority,
      spent: 0,
      status: 'active',
      createdAt: new Date().toISOString(),
      expiresAt,
      onExpiry: draft.onExpiry,
      permissions: allResources.map((resource) => ({
        resource,
        allowed: draft.resources.includes(resource),
        limits: draft.resources.includes(resource) ? limits : undefined,
      })),
      policyId: policy?.id,
      account: `0.0.${4_822_000 + Math.floor(Math.random() * 900)}`,
    }

    const now = new Date().toISOString()
    const created: ActivityEvent = {
      id: makeId('evt'),
      kind: 'agent.created',
      agentId: parent.id,
      targetAgentId: agent.id,
      timestamp: now,
      network: current.network,
    }
    const delegated: ActivityEvent = {
      id: makeId('evt'),
      kind: 'authority.delegated',
      agentId: parent.id,
      targetAgentId: agent.id,
      amount: agent.authority,
      timestamp: new Date(Date.now() + 1).toISOString(),
      txId: makeTxId(),
      network: current.network,
    }

    commit((prev) => ({
      ...prev,
      agents: prev.agents
        .map((a) => (a.id === parent.id ? { ...a, children: [...a.children, agent.id] } : a))
        .concat(agent),
      events: [delegated, created, ...prev.events],
    }))

    return { ok: true, agent }
  }, [commit])

  const revokeAgent = useCallback((id: string) => {
    commit((prev) => {
      const idx = indexAgents(prev.agents)
      const doomed = new Set<string>([id])
      const walk = (current: string) => {
        for (const child of idx[current]?.children ?? []) {
          doomed.add(child)
          walk(child)
        }
      }
      walk(id)

      const event: ActivityEvent = {
        id: makeId('evt'),
        kind: 'agent.revoked',
        agentId: id,
        timestamp: new Date().toISOString(),
        txId: makeTxId(),
        network: prev.network,
        reason:
          doomed.size > 1
            ? `Authority withdrawn from ${doomed.size - 1} delegated agent${doomed.size > 2 ? 's' : ''} as well`
            : undefined,
      }

      return {
        ...prev,
        agents: prev.agents.map((a) =>
          doomed.has(a.id) ? { ...a, status: 'revoked' as const } : a,
        ),
        events: [event, ...prev.events],
      }
    })
  }, [commit])

  const requestPayment = useCallback(
    (input: { agentId: string; amount: number; service: string }): PaymentDecision => {
      const current = ref.current
      const idx = indexAgents(current.agents)
      const agent = idx[input.agentId]
      const amount = Math.round(input.amount * 100) / 100

      const base = {
        id: makeId('evt'),
        agentId: input.agentId,
        amount,
        service: input.service,
        timestamp: new Date().toISOString(),
        network: current.network,
      }

      const block = (
        reason: string,
        limitLabel?: string,
        limitValue?: number,
        extra?: Partial<ActivityEvent>,
      ): PaymentDecision => {
        const event: ActivityEvent = {
          ...base,
          kind: 'payment.blocked',
          reason,
          policyId: agent?.policyId,
          policyLimit: limitValue,
          ...extra,
        }
        commit((prev) => ({ ...prev, events: [event, ...prev.events] }))
        return { approved: false, reason, limitLabel, limitValue, policyId: agent?.policyId, event }
      }

      if (!agent) return block('Unknown agent')
      if (agent.status === 'revoked') {
        return block('Agent authority has been revoked', 'Authority', 0)
      }
      if (agent.expiresAt && new Date(agent.expiresAt).getTime() <= Date.now()) {
        return block('Agent authority has expired', 'Authority', 0)
      }

      const resource = resourceForService(input.service)
      const permission = agent.permissions.find((p) => p.resource === resource)
      if (!permission?.allowed) {
        return block(`${input.service} is not a permitted service`, 'Permitted services')
      }

      const policy = current.policies.find((p) => p.id === agent.policyId)
      const maxTransaction = permission.limits?.transaction ?? policy?.maxTransaction
      if (maxTransaction != null && amount > maxTransaction) {
        return block(
          'Transaction exceeds maximum transaction limit',
          'Maximum transaction',
          maxTransaction,
          { dailyLimit: policy?.dailyLimit, dailyUsage: spentToday(current.events, agent.id) },
        )
      }

      const dailyLimit = permission.limits?.daily ?? policy?.dailyLimit
      const today = spentToday(current.events, agent.id)
      if (dailyLimit != null && today + amount > dailyLimit) {
        return block(
          'Daily spending limit exceeded',
          'Daily spending',
          dailyLimit,
          { dailyLimit, dailyUsage: today },
        )
      }

      const { available } = statsFor(idx, agent.id)
      if (amount > available) {
        return block(
          "Transaction exceeds the agent's remaining authority",
          'Remaining authority',
          available,
          { dailyLimit, dailyUsage: today },
        )
      }

      const event: ActivityEvent = {
        ...base,
        kind: 'payment.approved',
        policyId: agent.policyId,
        policyLimit: maxTransaction,
        dailyLimit,
        dailyUsage: today,
        txId: makeTxId(),
      }

      commit((prev) => ({
        ...prev,
        agents: prev.agents.map((a) =>
          a.id === agent.id ? { ...a, spent: Math.round((a.spent + amount) * 100) / 100 } : a,
        ),
        events: [event, ...prev.events],
      }))

      return { approved: true, policyId: agent.policyId, event }
    },
    [commit],
  )

  const setNetwork = useCallback(
    (network: Network) => commit((prev) => ({ ...prev, network })),
    [commit],
  )

  const setDemoMode = useCallback(
    (demoMode: boolean) => commit((prev) => ({ ...prev, demoMode })),
    [commit],
  )

  const setNotification = useCallback(
    (key: keyof NotificationSettings, value: boolean) =>
      commit((prev) => ({ ...prev, notifications: { ...prev.notifications, [key]: value } })),
    [commit],
  )

  const reset = useCallback(() => {
    const fresh = initialState()
    ref.current = fresh
    setState(fresh)
  }, [])

  const value = useMemo<LeashContextValue>(
    () => ({
      ...view,
      live,
      index,
      agentById: (id: string) => index[id],
      policyFor,
      createAgent,
      revokeAgent,
      requestPayment,
      setNetwork,
      setDemoMode,
      setNotification,
      reset,
    }),
    [
      view,
      live,
      index,
      policyFor,
      createAgent,
      revokeAgent,
      requestPayment,
      setNetwork,
      setDemoMode,
      setNotification,
      reset,
    ],
  )

  return <LeashContext.Provider value={value}>{children}</LeashContext.Provider>
}

export function useLeash(): LeashContextValue {
  const value = useContext(LeashContext)
  if (!value) throw new Error('useLeash must be used inside <LeashProvider>')
  return value
}
