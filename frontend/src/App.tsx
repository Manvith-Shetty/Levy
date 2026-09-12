import { getManifest } from './api'
import { ActivityFeed } from './components/ActivityFeed'
import { Header } from './components/Header'
import { MandateTree } from './components/MandateTree'
import { SeedForm } from './components/SeedForm'
import { useMandateTree } from './hooks/useMandateTree'
import { usePolling } from './hooks/usePolling'

export default function App() {
  const { data: manifest, error: manifestError } = usePolling(getManifest, 10_000)
  const { nodes, upsert, revoke, remove } = useMandateTree()

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <Header manifest={manifest} error={manifestError} />

      <main className="mx-auto grid max-w-6xl grid-cols-1 gap-6 px-6 py-8 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-6">
          <section>
            <h2 className="mb-3 text-sm font-semibold text-slate-200">Mandate tree</h2>
            <p className="mb-3 text-xs text-slate-500">
              Reflects mandates seeded or revoked from this dashboard. There's no read endpoint
              on the gateway yet, so a node seeded elsewhere (e.g. via curl) won't appear here
              until you seed it through this UI too.
            </p>
            <MandateTree nodes={nodes} onRevoked={revoke} onRemoved={remove} />
          </section>

          <ActivityFeed />
        </div>

        <aside>
          <SeedForm existingNames={Object.keys(nodes)} onSeeded={upsert} />
        </aside>
      </main>
    </div>
  )
}
