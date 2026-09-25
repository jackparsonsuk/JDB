import { createRoot } from 'react-dom/client'
import { AppStateProvider } from './state'
import { App } from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <AppStateProvider>
    <App />
  </AppStateProvider>
)
