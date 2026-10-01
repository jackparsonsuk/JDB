import { createRoot } from 'react-dom/client'
import type { SavedSession } from '@shared/types'
import { parseSession } from '@shared/session'
import { AppStateProvider, parseCarried, type Carried } from './state'
import { App } from './App'
import './styles.css'
// Applies the saved colours, fonts and size before the first render.
import './lib/appearance'

/**
 * This window's tabs, loaded before the first render so restored tabs don't flash in: its own from
 * the last session, or the tab moved into it, with any results that tab brought. Main leaves the
 * session out when Settings says to start without it.
 */
async function loadSession(): Promise<{ session: SavedSession | null; carried: Carried | null }> {
  try {
    const [raw, connections, carried] = await Promise.all([window.api.loadSession(), window.api.listConnections(), window.api.takeCarried()])
    return { session: parseSession(raw, new Set(connections.map((c) => c.id))), carried: parseCarried(carried) }
  } catch {
    return { session: null, carried: null }
  }
}

loadSession().then(({ session, carried }) => {
  createRoot(document.getElementById('root')!).render(
    <AppStateProvider session={session} carried={carried}>
      <App />
    </AppStateProvider>
  )
})
