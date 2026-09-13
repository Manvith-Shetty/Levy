import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from '../components/layout/Sidebar'
import { Topbar } from '../components/layout/Topbar'
import { CommandMenu } from '../components/layout/CommandMenu'
import { CreateAgentModal } from '../components/agents/CreateAgentModal'
import { CreateLiveAgentModal } from '../components/agents/CreateLiveAgentModal'
import { RevokeAgentModal } from '../components/agents/RevokeAgentModal'
import { RunAgentModal } from '../components/agents/RunAgentModal'
import { AgentDrawer } from '../components/agents/AgentDrawer'
import { TransactionDrawer } from '../components/activity/TransactionDrawer'
import { DemoControls } from '../components/demo/DemoControls'
import { config } from '../lib/config'
import { explain } from '../lib/live/wallet'
import { useLeash } from '../lib/store'
import { Button } from '../components/common/Button'
import { useToast } from './toast'
import { useUI } from './ui'

export function AppShell() {
  const ui = useUI()
  const { revokeAgent, index, live, demoMode, setDemoMode } = useLeash()
  const { push } = useToast()
  const [navOpen, setNavOpen] = useState(false)
  const [revoking, setRevoking] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        ui.setCommandOpen(true)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [ui])

  return (
    <div className="flex min-h-screen bg-canvas">
      <div className="sticky top-0 hidden h-screen lg:block">
        <Sidebar />
      </div>

      {navOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setNavOpen(false)}
            className="absolute inset-0 bg-[#040507]/70"
          />
          <div className="animate-slide-in absolute top-0 left-0 h-full">
            <Sidebar onNavigate={() => setNavOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          onOpenCommand={() => ui.setCommandOpen(true)}
          onOpenNav={() => setNavOpen(true)}
        />
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-6 lg:px-8 lg:py-8">
          {demoMode && (
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-delegated/35 bg-delegated/[0.07] px-4 py-3">
              <p className="copy text-[13px] text-ink-dim">
                <span className="font-medium text-delegated">Simulated data.</span> Agents, payments and receipts here
                are generated for the demo. Nothing touches Sepolia or Hedera.
              </p>
              <Button size="sm" onClick={() => setDemoMode(false)}>
                Show the live system
              </Button>
            </div>
          )}
          <Outlet />
        </main>
      </div>

      <CommandMenu
        open={ui.commandOpen}
        onClose={() => ui.setCommandOpen(false)}
        onCreateAgent={() => ui.openCreate()}
        onRunAgent={live.active && config.runnerEnabled ? () => ui.openRun() : undefined}
      />

      {live.active ? (
        <CreateLiveAgentModal
          key={ui.createOpen ? `live-${ui.createParentId ?? 'root'}` : 'live-closed'}
          open={ui.createOpen}
          onClose={ui.closeCreate}
          parentId={ui.createParentId}
        />
      ) : (
        <CreateAgentModal
          key={ui.createOpen ? `open-${ui.createParentId ?? 'root'}` : 'closed'}
          open={ui.createOpen}
          onClose={ui.closeCreate}
          parentId={ui.createParentId}
        />
      )}

      {live.active && ui.runOpen && (
        <RunAgentModal
          key={`run-${ui.runAgentId ?? 'default'}`}
          open
          onClose={ui.closeRun}
          agentId={ui.runAgentId}
        />
      )}

      <AgentDrawer
        agent={ui.agentDrawer}
        onClose={ui.closeAgent}
        onRevoke={(agent) => {
          ui.closeAgent()
          ui.openRevoke(agent)
        }}
      />

      <TransactionDrawer event={ui.eventDrawer} onClose={ui.closeEvent} />

      <RevokeAgentModal
        agent={ui.revokeTarget}
        onClose={ui.closeRevoke}
        busy={revoking}
        onConfirm={async (agent) => {
          if (!live.active) {
            revokeAgent(agent.id)
            ui.closeRevoke()
            push({
              tone: 'blocked',
              title: 'Agent revoked',
              body: `${agent.name} can no longer authorize spending.`,
            })
            return
          }
          setRevoking(true)
          try {
            if (!live.account) await live.connect()
            await live.revoke(agent.id)
            ui.closeRevoke()
            push({
              tone: 'blocked',
              title: 'Agent revoked',
              body: `${agent.name} can no longer authorize spending. Every agent under it is blocked too.`,
            })
          } catch (error) {
            push({ tone: 'blocked', title: 'Revoke not sent', body: explain(error, agent.account) })
          } finally {
            setRevoking(false)
          }
        }}
      />

      <DemoControls
        onRequestCreate={(parentId) => ui.openCreate(parentId)}
        onRequestRevoke={(agentId) => {
          const agent = index[agentId]
          if (agent) ui.openRevoke(agent)
        }}
      />
    </div>
  )
}
