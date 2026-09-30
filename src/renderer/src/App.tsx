import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type { ConnectionConfig } from '@shared/types'
import { isSplit, otherPane, tabsIn, tabsToClose, type CloseScope, type PaneId } from '@shared/panes'
import { useAppState, type Tab } from './state'
import { startDrag, useDragging, type DragPayload } from './lib/openLink'
import { Sidebar } from './components/Sidebar'
import { TableView } from './components/TableView'
import { QueryView } from './components/QueryView'
import { RecordView } from './components/RecordView'
import { TableDesigner } from './components/TableDesigner'
import { RoutineView } from './components/RoutineView'
import { ConnectionDialog } from './components/ConnectionDialog'
import { CommandPalette } from './components/CommandPalette'
import { toast, ToastHost } from './components/Toast'
import { LinksDialog } from './components/LinksDialog'
import { SlopLayer } from './components/SlopLayer'
import { WhatsNewDialog } from './components/WhatsNewDialog'
import { announceUpdate } from './lib/whatsNew'
import { appVersion } from './lib/version'

const SIDEBAR_DEFAULT = 270
const SIDEBAR_MIN = 180
const SIDEBAR_KEY = 'jdb.sidebar.width'
const SIDEBAR_HIDDEN_KEY = 'jdb.sidebar.hidden'

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Only a layout convenience; the default is fine.
  }
}

/** The sidebar's width (dragged, remembered) and whether it's hidden (Ctrl+B). */
function useSidebar() {
  const [width, setWidthState] = useState(() => {
    const saved = Number(readStored(SIDEBAR_KEY))
    return Number.isFinite(saved) && saved >= SIDEBAR_MIN ? saved : SIDEBAR_DEFAULT
  })
  const [hidden, setHiddenState] = useState(() => readStored(SIDEBAR_HIDDEN_KEY) === '1')
  const setWidth = useCallback((next: number) => {
    // Leave most of the window to the tables.
    const clamped = Math.round(Math.max(SIDEBAR_MIN, Math.min(window.innerWidth * 0.6, next)))
    setWidthState(clamped)
    store(SIDEBAR_KEY, String(clamped))
  }, [])
  const setHidden = useCallback((next: boolean) => {
    setHiddenState(next)
    store(SIDEBAR_HIDDEN_KEY, next ? '1' : '0')
  }, [])
  const startResize = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = (event.currentTarget.parentElement as HTMLElement).offsetWidth
    const move = (e: MouseEvent): void => setWidth(startWidth + e.clientX - startX)
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('resizing-cols')
    }
    document.body.classList.add('resizing-cols')
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [setWidth])
  return useMemo(() => ({ width, hidden, setWidth, setHidden, startResize }), [width, hidden, setWidth, setHidden, startResize])
}

export function App() {
  const sidebar = useSidebar()
  const { layout, activeTabId, setActiveTab, closeTab, moveTab, focusPane, connections, openQuery, initialRatio, rememberRatio } = useAppState()
  const [editing, setEditing] = useState<ConnectionConfig | null | 'new'>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [linksFor, setLinksFor] = useState<string | null>(null)
  /** Share of the width the left pane takes when split. */
  const [ratio, setRatioState] = useState(initialRatio)
  const setRatio = (next: number): void => {
    setRatioState(next)
    rememberRatio(next)
  }
  /**
   * Tabs that have been shown at least once. A tab's view only mounts then, so tabs restored from
   * the last session don't all connect (and prompt for sign-in) at startup.
   */
  const shown = useRef(new Set<string>())
  const panesRef = useRef<HTMLDivElement>(null)

  // After an update, offer the release notes for what changed.
  useEffect(() => {
    announceUpdate()
  }, [])

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
        // Pinned tabs close only from their menu, so a stray Ctrl+W can't lose them.
        if (activeTab?.pinned) toast('Pinned tab: unpin it, or use Close from its right-click menu')
        else closeTab(activeTabId)
      } else if (mod && key === 'b') {
        e.preventDefault()
        sidebar.setHidden(!sidebar.hidden)
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
  }, [activeTab, activeTabId, closeTab, connections, layout, moveTab, openQuery, setActiveTab, sidebar])

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
      {sidebar.hidden ? (
        <button className="sidebar-reveal" title="Show the sidebar (Ctrl+B)" onClick={() => sidebar.setHidden(false)}>›</button>
      ) : (
        <div className="sidebar-wrap" style={{ width: sidebar.width }}>
          <Sidebar onEdit={(c) => setEditing(c)} onNew={() => setEditing('new')} onLinks={(c) => setLinksFor(c.id)} />
          <div
            className="sidebar-resize"
            title="Drag to resize · double-click to reset · Ctrl+B hides the sidebar"
            onMouseDown={sidebar.startResize}
            onDoubleClick={() => sidebar.setWidth(SIDEBAR_DEFAULT)}
          />
        </div>
      )}

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
          if (visible) shown.current.add(tab.id)
          const mounted = shown.current.has(tab.id)
          return (
            <div
              key={tab.id}
              className="tab-pane"
              data-pane={tab.pane}
              style={{ gridColumn: column(tab.pane) }}
              hidden={!visible}
              onMouseDownCapture={() => focusPane(tab.pane)}
            >
              {mounted && tab.kind === 'table' && <TableView tab={tab} focused={focused} />}
              {mounted && tab.kind === 'query' && <QueryView tab={tab} active={visible} focused={focused} />}
              {mounted && tab.kind === 'record' && <RecordView tab={tab} />}
              {mounted && tab.kind === 'design' && <TableDesigner tab={tab} />}
              {mounted && tab.kind === 'routine' && <RoutineView tab={tab} />}
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
      <WhatsNewDialog />
      <ToastHost />
      <SlopLayer />
    </div>
  )
}

/** A pane's tab bar and the environment banner for the tab it shows. */
function PaneHead({ pane, split }: { pane: PaneId; split: boolean }) {
  const { layout, setActiveTab, closeTab, pinTab, reorderTab, focusPane, connection, unsavedTabs } = useAppState()
  const [menu, setMenu] = useState<{ x: number; y: number; tabId: string } | null>(null)
  const own = tabsIn(layout, pane)

  // Dragging a tab along a tab bar reorders it; the marker shows where it will land.
  const drag = useDragging()
  const draggedTab = drag?.kind === 'tab' ? drag.tabId : null
  /** The tab the dragged one would go before, null for the end, undefined when not over this bar. */
  const [dropBefore, setDropBefore] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!draggedTab) setDropBefore(undefined)
  }, [draggedTab])
  const overTab = (e: DragEvent, index: number): void => {
    if (!draggedTab) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const after = e.clientX > rect.left + rect.width / 2
    setDropBefore(after ? own[index + 1]?.id ?? null : own[index].id)
  }
  const dropTab = (e: DragEvent): void => {
    if (!draggedTab || dropBefore === undefined) return
    e.preventDefault()
    e.stopPropagation()
    reorderTab(draggedTab, pane, dropBefore)
    setDropBefore(undefined)
  }
  const active = own.find((t) => t.id === layout.active[pane])
  const activeConn = active ? connection(active.connectionId) : undefined
  const focused = layout.focused === pane

  return (
    <div
      className={`pane-head ${activeConn ? `env-${activeConn.env}` : ''} ${split && focused ? 'focused' : ''}`}
      style={{ gridColumn: pane === 0 ? 1 : 3 }}
      onMouseDownCapture={() => focusPane(pane)}
    >
      <div
        className="tabbar"
        onDragOver={(e) => {
          // Past the last tab: drop at the end.
          if (!draggedTab) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          setDropBefore(null)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropBefore(undefined)
        }}
        onDrop={dropTab}
      >
        {own.map((tab, index) => {
          const conn = connection(tab.connectionId)
          return (
            <div
              key={tab.id}
              className={[
                'tab', `env-${conn?.env ?? 'local'}`,
                tab.id === active?.id && 'on',
                tab.pinned && 'pinned',
                tab.id === draggedTab && 'dragging',
                dropBefore === tab.id && 'drop-before',
                dropBefore === null && index === own.length - 1 && 'drop-after'
              ].filter(Boolean).join(' ')}
              draggable
              onDragStart={(e) => startDrag(e, { kind: 'tab', tabId: tab.id }, tabTitle(tab))}
              onDragOver={(e) => overTab(e, index)}
              onDrop={dropTab}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  if (!tab.pinned) closeTab(tab.id)
                } else if (e.button === 0) {
                  setActiveTab(tab.id)
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                setActiveTab(tab.id)
                setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
              }}
              title={`${conn?.name ?? ''} · ${tabTitle(tab)}${tab.pinned ? ' (pinned)' : ''}\nDrag to the other side to split · right-click for more`}
            >
              <span className="tab-icon">{tab.kind === 'table' ? '▦' : tab.kind === 'record' ? '◉' : tab.kind === 'design' ? '⚙' : tab.kind === 'routine' ? 'ƒ' : '⌨'}</span>
              <span className="tab-title">{tabTitle(tab)}</span>
              {unsavedTabs.has(tab.id) && <span className="tab-unsaved" title="Unsaved changes to this saved query (Ctrl+S saves)" />}
              <span className="tab-conn">{conn?.name}</span>
              {tab.pinned ? (
                <button className="icon small tab-pin" title="Unpin" onMouseDown={(e) => e.stopPropagation()} onClick={() => pinTab(tab.id, false)}>📌</button>
              ) : (
                <button className="icon small" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeTab(tab.id)}>✕</button>
              )}
            </div>
          )
        })}
      </div>

      {menu && <TabMenu {...menu} onClose={() => setMenu(null)} />}

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

/** A tab's right-click menu. Bulk closes act on its own pane and leave pinned tabs open. */
function TabMenu({ x, y, tabId, onClose }: { x: number; y: number; tabId: string; onClose(): void }) {
  const { layout, closeTab, closeTabs, pinTab, moveTab } = useAppState()
  const tab = layout.tabs.find((t) => t.id === tabId)
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Keep the menu on screen when opened near the right edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setPosition({ left: Math.min(x, window.innerWidth - el.offsetWidth - 8), top: Math.min(y, window.innerHeight - el.offsetHeight - 8) })
  }, [x, y])

  if (!tab) return null
  const count = (scope: CloseScope): number => tabsToClose(layout, tabId, scope).length
  const others = count('others')
  const right = count('right')
  const all = count('all')
  const act = (run: () => void) => (): void => {
    onClose()
    run()
  }
  // A lone tab on the left can't split off; one on the right can always go back.
  const canMove = tab.pane === 1 || tabsIn(layout, 0).length > 1

  return (
    <div ref={ref} className="menu tab-menu" style={position} onMouseDown={(e) => e.stopPropagation()}>
      <button onClick={act(() => pinTab(tabId, !tab.pinned))}>{tab.pinned ? 'Unpin tab' : 'Pin tab'}</button>
      <div className="menu-sep" />
      <button onClick={act(() => closeTab(tabId))}>Close{!tab.pinned && <kbd>Ctrl+W</kbd>}</button>
      <button disabled={!others} onClick={act(() => closeTabs(tabId, 'others'))}>Close others{others ? ` (${others})` : ''}</button>
      <button disabled={!right} onClick={act(() => closeTabs(tabId, 'right'))}>Close to the right{right ? ` (${right})` : ''}</button>
      <button disabled={!all} onClick={act(() => closeTabs(tabId, 'all'))}>Close all{all ? ` (${all})` : ''}</button>
      <div className="menu-sep" />
      <button disabled={!canMove} onClick={act(() => moveTab(tabId, otherPane(tab.pane)))}>
        Move to {tab.pane === 0 ? 'right' : 'left'} side<kbd>Ctrl+\</kbd>
      </button>
      {tabsIn(layout, tab.pane).some((t) => t.pinned) && <div className="menu-label">Pinned tabs stay open when closing several</div>}
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
  if (tab.kind === 'design') return `${tab.table.name} (design)`
  if (tab.kind === 'routine') return tab.routine.name
  const filter = tab.initialFilters[0]
  return filter ? `${tab.table.name} (${filter.column}=${filter.value ?? ''})` : tab.table.name
}

function Welcome({ onPalette }: { onPalette(): void }) {
  return (
    <div className="welcome">
      <h1>JDB <span className="welcome-version muted">{appVersion}</span></h1>
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
