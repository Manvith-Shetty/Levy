import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import { Sidebar } from '../components/layout/Sidebar'
import { Topbar } from '../components/layout/Topbar'
import { CommandMenu } from '../components/layout/CommandMenu'
import { CreateAgentModal } from '../components/agents/CreateAgentModal'
import { RevokeAgentModal } from '../components/agents/RevokeAgentModal'
import { AgentDrawer } from '../components/agents/AgentDrawer'
import { TransactionDrawer } from '../components/activity/TransactionDrawer'
import { DemoControls } from '../components/demo/DemoControls'
import { useLeash } from '../lib/store'
import { useToast } from './toast'
import { useUI } from './ui'

export function AppShell() {
  const ui = useUI()
  const { revokeAgent, index } = useLeash()
  const { push } = useToast()
  const [navOpen, setNavOpen] = useState(false)

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
          <Outlet />
        </main>
      </div>

      <CommandMenu
        open={ui.commandOpen}
        onClose={() => ui.setCommandOpen(false)}
        onCreateAgent={() => ui.openCreate()}
      />

      <CreateAgentModal
        key={ui.createOpen ? `open-${ui.createParentId ?? 'root'}` : 'closed'}
        open={ui.createOpen}
        onClose={ui.closeCreate}
        parentId={ui.createParentId}
      />

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
        onConfirm={(agent) => {
          revokeAgent(agent.id)
          ui.closeRevoke()
          push({
            tone: 'blocked',
            title: 'Agent revoked',
            body: `${agent.name} can no longer authorize spending.`,
          })
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
