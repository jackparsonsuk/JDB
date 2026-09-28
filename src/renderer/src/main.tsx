import { createRoot } from 'react-dom/client'
import type { SavedSession } from '@shared/types'
import { parseSession } from '@shared/session'
import { AppStateProvider } from './state'
import { App } from './App'
import './styles.css'

/** The last session, loaded before the first render so restored tabs don't flash in. */
async function loadSession(): Promise<SavedSession | null> {
  try {
    const [raw, connections] = await Promise.all([window.api.loadSession(), window.api.listConnections()])
    return parseSession(raw, new Set(connections.map((c) => c.id)))
  } catch {
    return null
  }
}

loadSession().then((session) => {
  createRoot(document.getElementById('root')!).render(
    <AppStateProvider session={session}>
      <App />
    </AppStateProvider>
  )
})
