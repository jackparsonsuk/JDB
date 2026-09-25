import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { ConnectionConfig } from '@shared/types'
import { isSplit, otherPane, tabsIn, type PaneId } from '@shared/panes'
import { useAppState, type Tab } from './state'
import { startDrag, useDragging, type DragPayload } from './lib/openLink'
import { Sidebar } from './components/Sidebar'
import { TableView } from './components/TableView'
import { QueryView } from './components/QueryView'
import { RecordView } from './components/RecordView'
import { ConnectionDialog } from './components/ConnectionDialog'
import { CommandPalette } from './components/CommandPalette'
import { ToastHost } from './components/Toast'
import { LinksDialog } from './components/LinksDialog'

export function App() {
  const { layout, activeTabId, setActiveTab, closeTab, moveTab, focusPane, connections, openQuery } = useAppState()
  const [editing, setEditing] = useState<ConnectionConfig | null | 'new'>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [linksFor, setLinksFor] = useState<string | null>(null)
  /** Share of the width the left pane takes when split. */
  const [ratio, setRatio] = useState(0.5)
  const panesRef = useRef<HTMLDivElement>(null)

  const split = isSplit(layout)
  const tabs = layout.tabs
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
      } else if (mod && e.key === '\\' && activeTab) {
        e.preventDefault()
        moveTab(activeTab.id, otherPane(activeTab.pane))
      } else if (mod && e.key === 'Tab') {
        // Cycles within the focused pane, like an editor group.
        const own = tabsIn(layout, layout.focused)
        if (own.length < 2) return
        e.preventDefault()
        const i = own.findIndex((t) => t.id === activeTabId)
        setActiveTab(own[(i + (e.shiftKey ? -1 : 1) + own.length) % own.length].id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [activeTab, activeTabId, closeTab, connections, layout, moveTab, openQuery, setActiveTab])

  const startResize = (event: React.MouseEvent): void => {
    event.preventDefault()
    const rect = panesRef.current!.getBoundingClientRect()
    const move = (e: MouseEvent): void => setRatio(Math.max(0.2, Math.min(0.8, (e.clientX - rect.left) / rect.width)))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing-cols')
    }
    document.body.classList.add('resizing-cols')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const column = (pane: PaneId): number => (pane === 0 ? 1 : 3)

  return (
    <div className="app">
      <Sidebar onEdit={(c) => setEditing(c)} onNew={() => setEditing('new')} onLinks={(c) => setLinksFor(c.id)} />

      {/* One grid holds every tab's content as siblings, so moving a tab between panes keeps it mounted. */}
      <main
        ref={panesRef}
        className={`workspace ${split ? 'split' : ''}`}
        style={{ gridTemplateColumns: split ? `minmax(0, ${ratio}fr) 5px minmax(0, ${1 - ratio}fr)` : 'minmax(0, 1fr)' }}
      >
        <PaneHead pane={0} split={split} />
        {split && (
          <>
            <div className="pane-splitter" onMouseDown={startResize} onDoubleClick={() => setRatio(0.5)} title="Drag to resize, double-click to even out" />
            <PaneHead pane={1} split={split} />
          </>
        )}

        {tabs.map((tab) => {
          const visible = layout.active[tab.pane] === tab.id
          const focused = visible && layout.focused === tab.pane
          return (
            <div
              key={tab.id}
              className="tab-pane"
              data-pane={tab.pane}
              style={{ gridColumn: column(tab.pane) }}
              hidden={!visible}
              onMouseDownCapture={() => focusPane(tab.pane)}
            >
              {tab.kind === 'table' && <TableView tab={tab} focused={focused} />}
              {tab.kind === 'query' && <QueryView tab={tab} active={visible} focused={focused} />}
              {tab.kind === 'record' && <RecordView tab={tab} />}
            </div>
          )
        })}
        {!tabs.length && <Welcome onPalette={() => setPaletteOpen(true)} />}

        <DropZones split={split} ratio={ratio} />
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

/** A pane's tab bar and the environment banner for the tab it shows. */
function PaneHead({ pane, split }: { pane: PaneId; split: boolean }) {
  const { layout, setActiveTab, closeTab, focusPane, connection } = useAppState()
  const own = tabsIn(layout, pane)
  const active = own.find((t) => t.id === layout.active[pane])
  const activeConn = active ? connection(active.connectionId) : undefined
  const focused = layout.focused === pane

  return (
    <div
      className={`pane-head ${activeConn ? `env-${activeConn.env}` : ''} ${split && focused ? 'focused' : ''}`}
      style={{ gridColumn: pane === 0 ? 1 : 3 }}
      onMouseDownCapture={() => focusPane(pane)}
    >
      <div className="tabbar">
        {own.map((tab) => {
          const conn = connection(tab.connectionId)
          return (
            <div
              key={tab.id}
              className={`tab env-${conn?.env ?? 'local'} ${tab.id === active?.id ? 'on' : ''}`}
              draggable
              onDragStart={(e) => startDrag(e, { kind: 'tab', tabId: tab.id }, tabTitle(tab))}
              onMouseDown={(e) => {
                if (e.button === 1) closeTab(tab.id)
                else setActiveTab(tab.id)
              }}
              title={`${conn?.name ?? ''} · ${tabTitle(tab)}\nDrag to the other side to split`}
            >
              <span className="tab-icon">{tab.kind === 'table' ? '▦' : tab.kind === 'record' ? '◉' : '⌨'}</span>
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
    </div>
  )
}

/** While a reference or tab is dragged, the workspace shows where it can land. */
function DropZones({ split, ratio }: { split: boolean; ratio: number }) {
  const { layout, open, moveTab } = useAppState()
  const drag = useDragging()
  const [over, setOver] = useState<PaneId | null>(null)
  useEffect(() => setOver(null), [drag])
  if (!drag) return null

  const tab = drag.kind === 'tab' ? layout.tabs.find((t) => t.id === drag.tabId) : undefined
  // A tab can't split off from a pane it's alone in, and dropping it on its own pane does nothing.
  const lonely = !!tab && !split && tabsIn(layout, tab.pane).length < 2
  const verb = drag.kind === 'tab' ? 'Move' : 'Open'
  const zones: { pane: PaneId; label: string; width: string }[] = split
    ? [
        { pane: 0, label: `${verb} on the left`, width: `${ratio * 100}%` },
        { pane: 1, label: `${verb} on the right`, width: `${(1 - ratio) * 100}%` }
      ]
    : [
        { pane: 0, label: `${verb} here`, width: '50%' },
        { pane: 1, label: `${verb} to the side`, width: '50%' }
      ]

  const land = (pane: PaneId, payload: DragPayload): void => {
    if (payload.kind === 'open') open(payload.target, pane)
    else moveTab(payload.tabId, pane)
  }

  return (
    <div className="drop-zones">
      {zones.map((z) => {
        const idle = (tab && tab.pane === z.pane) || (lonely && z.pane === 1)
        return (
          <div
            key={z.pane}
            className={`drop-zone ${over === z.pane ? 'over' : ''} ${idle ? 'idle' : ''}`}
            style={{ width: z.width }}
            onDragOver={(e: DragEvent) => {
              if (idle) return
              e.preventDefault()
              e.dataTransfer.dropEffect = drag.kind === 'tab' ? 'move' : 'copy'
              setOver(z.pane)
            }}
            onDragLeave={() => setOver((o) => (o === z.pane ? null : o))}
            onDrop={(e: DragEvent) => {
              e.preventDefault()
              land(z.pane, drag)
            }}
          >
            {!idle && <span className="drop-label">{z.label}</span>}
          </div>
        )
      })}
    </div>
  )
}

function tabTitle(tab: Tab): string {
  if (tab.kind === 'query') return tab.title
  if (tab.kind === 'record') return `${tab.table.name} ${tab.key.map((k) => k.value).join('·')}`
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
        <li><kbd>Ctrl \</kbd> Move tab to the other side</li>
        <li><kbd>Shift</kbd> click a reference to open it beside</li>
        <li><kbd>F5</kbd> Refresh table</li>
        <li><kbd>Ctrl C</kbd> Copy selected rows for Excel</li>
      </ul>
      <button className="primary" onClick={onPalette}>Open command palette</button>
    </div>
  )
}
