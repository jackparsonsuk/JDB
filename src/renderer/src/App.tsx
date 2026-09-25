import { useEffect, useState } from 'react'
import type { ConnectionConfig } from '@shared/types'
import { useAppState, type Tab } from './state'
import { Sidebar } from './components/Sidebar'
import { TableView } from './components/TableView'
import { QueryView } from './components/QueryView'
import { ConnectionDialog } from './components/ConnectionDialog'
import { CommandPalette } from './components/CommandPalette'
import { ToastHost } from './components/Toast'
import { LinksDialog } from './components/LinksDialog'

export function App() {
  const { tabs, activeTabId, setActiveTab, closeTab, connection, connections, openQuery } = useAppState()
  const [editing, setEditing] = useState<ConnectionConfig | null | 'new'>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [linksFor, setLinksFor] = useState<string | null>(null)

  const activeTab = tabs.find((t) => t.id === activeTabId)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && (key === 'k' || key === 'p')) {
        e.preventDefault()
        setPaletteOpen((open) => !open)
      } else if (mod && key === 'w' && activeTabId) {
        e.preventDefault()
        closeTab(activeTabId)
      } else if (mod && key === 't') {
        e.preventDefault()
        const target = activeTab?.connectionId ?? connections[0]?.id
        if (target) openQuery(target)
      } else if (mod && e.key === 'Tab' && tabs.length > 1) {
        e.preventDefault()
        const i = tabs.findIndex((t) => t.id === activeTabId)
        setActiveTab(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTab, activeTabId, closeTab, connections, openQuery, setActiveTab, tabs])

  const activeConn = activeTab ? connection(activeTab.connectionId) : undefined

  return (
    <div className="app">
      <Sidebar onEdit={(c) => setEditing(c)} onNew={() => setEditing('new')} onLinks={(c) => setLinksFor(c.id)} />

      <main className={`workspace ${activeConn ? `env-${activeConn.env}` : ''}`}>
        <div className="tabbar">
          {tabs.map((tab) => {
            const conn = connection(tab.connectionId)
            return (
              <div
                key={tab.id}
                className={`tab env-${conn?.env ?? 'local'} ${tab.id === activeTabId ? 'on' : ''}`}
                onMouseDown={(e) => {
                  if (e.button === 1) closeTab(tab.id)
                  else setActiveTab(tab.id)
                }}
                title={`${conn?.name ?? ''} · ${tabTitle(tab)}`}
              >
                <span className="tab-icon">{tab.kind === 'table' ? '▦' : '⌨'}</span>
                <span className="tab-title">{tabTitle(tab)}</span>
                <span className="tab-conn">{conn?.name}</span>
                <button className="icon small" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeTab(tab.id)}>✕</button>
              </div>
            )
          })}
        </div>

        {activeConn && (
          <div className="env-banner">
            <span className="env-dot" />
            <span>{activeConn.name}</span>
            <span className="env-name">{activeConn.env}</span>
            {activeConn.readOnly ? <span className="ro">read-only</span> : <span className="rw">writes allowed</span>}
          </div>
        )}

        <div className="tab-content">
          {tabs.map((tab) => (
            <div key={tab.id} className="tab-pane" hidden={tab.id !== activeTabId}>
              {tab.kind === 'table'
                ? <TableView tab={tab} active={tab.id === activeTabId} />
                : <QueryView tab={tab} active={tab.id === activeTabId} />}
            </div>
          ))}
          {!tabs.length && <Welcome onPalette={() => setPaletteOpen(true)} />}
        </div>
      </main>

      {editing && <ConnectionDialog initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          onNewConnection={() => setEditing('new')}
          onLinks={(id) => setLinksFor(id)}
        />
      )}
      {linksFor && <LinksDialog connectionId={linksFor} onClose={() => setLinksFor(null)} />}
      <ToastHost />
    </div>
  )
}

function tabTitle(tab: Tab): string {
  if (tab.kind === 'query') return tab.title
  const filter = tab.initialFilters[0]
  return filter ? `${tab.table.name} (${filter.column}=${filter.value ?? ''})` : tab.table.name
}

function Welcome({ onPalette }: { onPalette(): void }) {
  return (
    <div className="welcome">
      <h1>JDB</h1>
      <p className="muted">Open a connection on the left, or press <kbd>Ctrl</kbd> <kbd>K</kbd> to jump straight to a table.</p>
      <ul className="shortcuts">
        <li><kbd>Ctrl K</kbd> Jump to table / command</li>
        <li><kbd>Ctrl T</kbd> New query tab</li>
        <li><kbd>Ctrl Enter</kbd> Run query (or selection)</li>
        <li><kbd>Ctrl W</kbd> Close tab</li>
        <li><kbd>F5</kbd> Refresh table</li>
        <li><kbd>Ctrl C</kbd> Copy selected rows for Excel</li>
      </ul>
      <button className="primary" onClick={onPalette}>Open command palette</button>
    </div>
  )
}
