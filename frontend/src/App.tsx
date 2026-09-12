import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { LeashProvider } from './lib/store'
import { ToastProvider } from './app/toast'
import { UIProvider } from './app/ui'
import { AppShell } from './app/AppShell'
import { Overview } from './pages/Overview'
import { Agents } from './pages/Agents'
import { AgentDetail } from './pages/AgentDetail'
import { Spending } from './pages/Spending'
import { Activity } from './pages/Activity'
import { Policies } from './pages/Policies'
import { Services } from './pages/Services'
import { Settings } from './pages/Settings'

export default function App() {
  return (
    <BrowserRouter>
      <LeashProvider>
        <ToastProvider>
          <UIProvider>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<Overview />} />
                <Route path="agents" element={<Agents />} />
                <Route path="agents/:id" element={<AgentDetail />} />
                <Route path="spending" element={<Spending />} />
                <Route path="activity" element={<Activity />} />
                <Route path="policies" element={<Policies />} />
                <Route path="services" element={<Services />} />
                <Route path="settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </UIProvider>
        </ToastProvider>
      </LeashProvider>
    </BrowserRouter>
  )
}
