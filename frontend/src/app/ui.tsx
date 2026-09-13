import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import type { ActivityEvent, Agent } from '../lib/types'

interface UIState {
  createParentId?: string
  createOpen: boolean
  revokeTarget: Agent | null
  agentDrawer: Agent | null
  eventDrawer: ActivityEvent | null
  commandOpen: boolean
  runOpen: boolean
  runAgentId?: string
  runPreset?: RunPreset
}

/** Opens the run modal pre-filled, e.g. to add time to a running container. */
export interface RunPreset {
  service: string
  prompt?: string
  job?: import('../lib/live/runner').JobSpec
  provider?: string
}

interface UIActions {
  openCreate: (parentId?: string) => void
  closeCreate: () => void
  openRevoke: (agent: Agent) => void
  closeRevoke: () => void
  openAgent: (agent: Agent) => void
  closeAgent: () => void
  openEvent: (event: ActivityEvent) => void
  closeEvent: () => void
  setCommandOpen: (open: boolean) => void
  openRun: (agentId?: string, preset?: RunPreset) => void
  closeRun: () => void
}

const UIContext = createContext<(UIState & UIActions) | null>(null)

export function UIProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<UIState>({
    createOpen: false,
    revokeTarget: null,
    agentDrawer: null,
    eventDrawer: null,
    commandOpen: false,
    runOpen: false,
  })

  const openCreate = useCallback((parentId?: string) => {
    setState((s) => ({ ...s, createOpen: true, createParentId: parentId }))
  }, [])
  const closeCreate = useCallback(() => setState((s) => ({ ...s, createOpen: false })), [])
  const openRevoke = useCallback((agent: Agent) => setState((s) => ({ ...s, revokeTarget: agent })), [])
  const closeRevoke = useCallback(() => setState((s) => ({ ...s, revokeTarget: null })), [])
  const openAgent = useCallback((agent: Agent) => setState((s) => ({ ...s, agentDrawer: agent })), [])
  const closeAgent = useCallback(() => setState((s) => ({ ...s, agentDrawer: null })), [])
  const openEvent = useCallback((event: ActivityEvent) => setState((s) => ({ ...s, eventDrawer: event })), [])
  const closeEvent = useCallback(() => setState((s) => ({ ...s, eventDrawer: null })), [])
  const setCommandOpen = useCallback((commandOpen: boolean) => setState((s) => ({ ...s, commandOpen })), [])
  const openRun = useCallback(
    (runAgentId?: string, runPreset?: RunPreset) => setState((s) => ({ ...s, runOpen: true, runAgentId, runPreset })),
    [],
  )
  const closeRun = useCallback(() => setState((s) => ({ ...s, runOpen: false })), [])

  const value = useMemo(
    () => ({
      ...state,
      openCreate,
      closeCreate,
      openRevoke,
      closeRevoke,
      openAgent,
      closeAgent,
      openEvent,
      closeEvent,
      setCommandOpen,
      openRun,
      closeRun,
    }),
    [
      state,
      openCreate,
      closeCreate,
      openRevoke,
      closeRevoke,
      openAgent,
      closeAgent,
      openEvent,
      closeEvent,
      setCommandOpen,
      openRun,
      closeRun,
    ],
  )

  return <UIContext.Provider value={value}>{children}</UIContext.Provider>
}

export function useUI() {
  const value = useContext(UIContext)
  if (!value) throw new Error('useUI must be used inside <UIProvider>')
  return value
}
