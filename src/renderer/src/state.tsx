import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ColumnFilter, ConnectionConfig, CrossLink, RoutineInfo, RoutineRef, SavedSession, SavedTab, TableInfo, TableRef, TableSort } from '@shared/types'
import { sameRoutine } from '@shared/routines'
import * as panes from '@shared/panes'
import type { CloseScope, PaneId, Panes } from '@shared/panes'
import { forgetAllNlEngines, forgetNlEngine } from './lib/useNl'

export type Tab = (
  | {
      kind: 'table'; id: string; pane: PaneId; connectionId: string; table: TableRef; initialFilters: ColumnFilter[]; initialSort?: TableSort
      /** A column to scroll to and highlight; `seq` changes when asked again. Not saved. */
      focusColumn?: { name: string; seq: number }
    }
  | { kind: 'query'; id: string; pane: PaneId; connectionId: string; title: string; initialSql: string }
  | { kind: 'record'; id: string; pane: PaneId; connectionId: string; table: TableRef; key: ColumnFilter[] }
  | { kind: 'design'; id: string; pane: PaneId; connectionId: string; table: TableRef }
  | {
      kind: 'routine'; id: string; pane: PaneId; connectionId: string; routine: RoutineRef
      /** Text to find and select in the source (from a source search); `seq` changes when asked again. Not saved. */
      find?: { text: string; seq: number }
    }
) & { pinned?: boolean }

/** Something a reference points at, which can be clicked open or dragged into a pane. */
export type OpenTarget =
  | { kind: 'table'; connectionId: string; table: TableRef; filters: ColumnFilter[]; column?: string }
  | { kind: 'record'; connectionId: string; table: TableRef; key: ColumnFilter[] }
  | { kind: 'design'; connectionId: string; table: TableRef }
  | { kind: 'routine'; connectionId: string; routine: RoutineRef; find?: string }

/** What a tab has changed since it opened, kept for saving the session. */
export interface TabMemory {
  sql?: string
  filters?: ColumnFilter[]
  sort?: TableSort | null
}

export interface TablesState {
  status: 'loading' | 'ready' | 'error'
  tables: TableInfo[]
  error?: string
}

export interface RoutinesState {
  status: 'loading' | 'ready' | 'error'
  routines: RoutineInfo[]
  error?: string
}

interface AppState {
  connections: ConnectionConfig[]
  reloadConnections(): Promise<void>
  /** Cross-database links, confirmed and dismissed. */
  links: CrossLink[]
  setLinks(links: CrossLink[]): void
  tables: Record<string, TablesState>
  loadTables(connectionId: string, force?: boolean): Promise<void>
  forgetTables(connectionId: string): void
  /** Stored procedures, functions and triggers per connection, loaded on first use. */
  routines: Record<string, RoutinesState>
  loadRoutines(connectionId: string, force?: boolean): Promise<void>
  tabs: Tab[]
  /** Tabs and which one each pane shows; see @shared/panes. */
  layout: Panes<Tab>
  /** The focused pane's active tab, which keyboard shortcuts act on. */
  activeTabId: string | null
  setActiveTab(id: string): void
  focusPane(pane: PaneId): void
  moveTab(id: string, pane: PaneId): void
  /** Opens a reference in a pane (the focused one by default), re-using a matching open tab. */
  open(target: OpenTarget, pane?: PaneId): void
  openTable(connectionId: string, table: TableRef, filters?: ColumnFilter[], pane?: PaneId): void
  openQuery(connectionId: string, sql?: string): void
  /** Opens the record explorer for one row, identified by its primary key values. */
  openRecord(connectionId: string, table: TableRef, key: ColumnFilter[], pane?: PaneId): void
  closeTab(id: string): void
  /** Closes the unpinned tabs in `id`'s pane that `scope` picks, asking first about any with unsaved work. */
  closeTabs(id: string, scope: CloseScope): void
  pinTab(id: string, pinned: boolean): void
  /** Bumped when JDB changes a connection's schema, so open views re-read their columns. */
  schemaVersions: Record<string, number>
  schemaChanged(connectionId: string): void
  /** Moves a tab before `beforeId` in `pane`'s tab bar, or to its end when null. */
  reorderTab(id: string, pane: PaneId, beforeId: string | null): void
  connection(id: string): ConnectionConfig | undefined
  /** Records a tab's current query text, filters or sort so the session saves them. */
  rememberTab(id: string, memory: TabMemory): void
  /** The split ratio restored from the last session. */
  initialRatio: number
  rememberRatio(ratio: number): void
}

const Ctx = createContext<AppState | null>(null)

/** Tabs that would lose something if closed (an open transaction, unsaved edits), with the warning. */
const closeWarnings = new Map<string, string>()

/** The main process asks before the window closes while there's unsaved work, so keep it told. */
const reportUnsaved = (): void => window.api.setUnsavedWork([...closeWarnings.values()])

// Blocking the unload makes Electron raise will-prevent-unload, where the main process asks.
window.addEventListener('beforeunload', (event) => {
  if (closeWarnings.size) event.preventDefault()
})

/** While `warning` is set, closing the tab (or the window) asks first. */
export function useCloseWarning(tabId: string, warning: string | null): void {
  useEffect(() => {
    if (!warning) return
    closeWarnings.set(tabId, warning)
    reportUnsaved()
    return () => {
      closeWarnings.delete(tabId)
      reportUnsaved()
    }
  }, [tabId, warning])
}

let tabCounter = 0
const nextTabId = (): string => `tab-${++tabCounter}`

/** An open tab showing the same thing: an unfiltered table, or the same record. */
function sameAs(tab: Tab, target: OpenTarget): boolean {
  if (tab.kind === 'query' || tab.kind !== target.kind || tab.connectionId !== target.connectionId) return false
  if (tab.kind === 'routine' || target.kind === 'routine') return tab.kind === 'routine' && target.kind === 'routine' && sameRoutine(tab.routine, target.routine)
  if (tab.table.schema !== target.table.schema || tab.table.name !== target.table.name) return false
  if (tab.kind === 'table') return target.kind === 'table' && !target.filters.length && !tab.initialFilters.length
  if (tab.kind === 'design') return true
  return target.kind === 'record' && JSON.stringify(tab.key) === JSON.stringify(target.key)
}

/** How long after the last change the session is written. */
const SAVE_DELAY_MS = 500

function toSaved(tab: Tab, memory: TabMemory | undefined): SavedTab {
  return { ...savedContent(tab, memory), ...(tab.pinned && { pinned: true }) }
}

function savedContent(tab: Tab, memory: TabMemory | undefined): SavedTab {
  const { pane, connectionId } = tab
  switch (tab.kind) {
    case 'query':
      return { kind: 'query', pane, connectionId, title: tab.title, sql: memory?.sql ?? tab.initialSql }
    case 'table': {
      const sort = memory && 'sort' in memory ? memory.sort ?? undefined : tab.initialSort
      return { kind: 'table', pane, connectionId, table: tab.table, filters: memory?.filters ?? tab.initialFilters, ...(sort && { sort }) }
    }
    case 'record':
      return { kind: 'record', pane, connectionId, table: tab.table, key: tab.key }
    case 'design':
      return { kind: 'design', pane, connectionId, table: tab.table }
    case 'routine':
      return { kind: 'routine', pane, connectionId, routine: tab.routine }
  }
}

function fromSaved(saved: SavedTab): Tab {
  return { ...savedTab(saved), ...(saved.pinned && { pinned: true }) }
}

function savedTab(saved: SavedTab): Tab {
  const id = nextTabId()
  switch (saved.kind) {
    case 'query':
      return { kind: 'query', id, pane: saved.pane, connectionId: saved.connectionId, title: saved.title, initialSql: saved.sql }
    case 'table':
      return { kind: 'table', id, pane: saved.pane, connectionId: saved.connectionId, table: saved.table, initialFilters: saved.filters, initialSort: saved.sort }
    case 'record':
      return { kind: 'record', id, pane: saved.pane, connectionId: saved.connectionId, table: saved.table, key: saved.key }
    case 'design':
      return { kind: 'design', id, pane: saved.pane, connectionId: saved.connectionId, table: saved.table }
    case 'routine':
      return { kind: 'routine', id, pane: saved.pane, connectionId: saved.connectionId, routine: saved.routine }
  }
}

function restoreLayout(session: SavedSession | null): Panes<Tab> {
  if (!session) return panes.emptyPanes()
  const tabs = session.tabs.map(fromSaved)
  const idAt = (i: number | null): string | null => (i === null ? null : tabs[i]?.id ?? null)
  return panes.restore(tabs, [idAt(session.active[0]), idAt(session.active[1])], session.focused)
}

/** `session`: the last saved session, already checked with parseSession. */
export function AppStateProvider({ children, session }: { children: ReactNode; session: SavedSession | null }) {
  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [tables, setTables] = useState<Record<string, TablesState>>({})
  const [links, setLinksState] = useState<CrossLink[]>([])

  const setLinks = useCallback((next: CrossLink[]) => {
    setLinksState(next)
    forgetAllNlEngines()
  }, [])

  useEffect(() => {
    window.api.listLinks().then(setLinksState).catch(() => undefined)
  }, [])
  const [layout, setLayout] = useState<Panes<Tab>>(() => restoreLayout(session))

  const reloadConnections = useCallback(async () => {
    setConnections(await window.api.listConnections())
  }, [])

  useEffect(() => {
    reloadConnections()
  }, [reloadConnections])

  const tablesRef = useRef(tables)
  tablesRef.current = tables

  const loadTables = useCallback(async (connectionId: string, force = false) => {
    const current = tablesRef.current[connectionId]
    if (!force && current && current.status !== 'error') return
    setTables((prev) => ({ ...prev, [connectionId]: { status: 'loading', tables: current?.tables ?? [] } }))
    try {
      const list = await window.api.listTables(connectionId)
      setTables((prev) => ({ ...prev, [connectionId]: { status: 'ready', tables: list } }))
    } catch (error) {
      setTables((prev) => ({ ...prev, [connectionId]: { status: 'error', tables: [], error: (error as Error).message } }))
    }
  }, [])

  const [routines, setRoutines] = useState<Record<string, RoutinesState>>({})
  const routinesRef = useRef(routines)
  routinesRef.current = routines
  const loadRoutines = useCallback(async (connectionId: string, force = false) => {
    const current = routinesRef.current[connectionId]
    if (!force && current && current.status !== 'error') return
    setRoutines((prev) => ({ ...prev, [connectionId]: { status: 'loading', routines: current?.routines ?? [] } }))
    try {
      const list = await window.api.listRoutines(connectionId)
      setRoutines((prev) => ({ ...prev, [connectionId]: { status: 'ready', routines: list } }))
    } catch (error) {
      setRoutines((prev) => ({ ...prev, [connectionId]: { status: 'error', routines: [], error: (error as Error).message } }))
    }
  }, [])

  const forgetTables = useCallback((connectionId: string) => {
    forgetNlEngine(connectionId)
    setTables(({ [connectionId]: _removed, ...rest }) => rest)
    setRoutines(({ [connectionId]: _removed, ...rest }) => rest)
  }, [])

  const [schemaVersions, setSchemaVersions] = useState<Record<string, number>>({})
  const schemaChanged = useCallback((connectionId: string) => {
    setSchemaVersions((v) => ({ ...v, [connectionId]: (v[connectionId] ?? 0) + 1 }))
    forgetNlEngine(connectionId)
    loadTables(connectionId, true)
    if (routinesRef.current[connectionId]) loadRoutines(connectionId, true)
  }, [loadTables, loadRoutines])

  const layoutRef = useRef(layout)
  layoutRef.current = layout
  // Carry on numbering after restored queries rather than repeating their titles.
  const queryCounter = useRef(Math.max(0, ...layout.tabs.map((t) => (t.kind === 'query' && Number(/^Query (\d+)$/.exec(t.title)?.[1])) || 0)))

  const memory = useRef(new Map<string, TabMemory>())
  const initialRatio = session?.ratio ?? 0.5
  const ratioRef = useRef(initialRatio)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const saveNow = useCallback(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = undefined
    const { tabs, active, focused } = layoutRef.current
    for (const id of memory.current.keys()) if (!tabs.some((t) => t.id === id)) memory.current.delete(id)
    const indexOf = (id: string | null): number | null => {
      const i = tabs.findIndex((t) => t.id === id)
      return i >= 0 ? i : null
    }
    window.api.saveSession({
      tabs: tabs.map((t) => toSaved(t, memory.current.get(t.id))),
      active: [indexOf(active[0]), indexOf(active[1])],
      focused,
      ratio: ratioRef.current
    })
  }, [])

  const scheduleSave = useCallback(() => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(saveNow, SAVE_DELAY_MS)
  }, [saveNow])

  // The first run is the restored layout itself, which is already on disk.
  const firstLayout = useRef(true)
  useEffect(() => {
    if (firstLayout.current) firstLayout.current = false
    else scheduleSave()
  }, [layout, scheduleSave])

  // Flush a pending save when the window closes or reloads.
  useEffect(() => {
    const flush = (): void => {
      if (saveTimer.current !== undefined) saveNow()
    }
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [saveNow])

  const rememberTab = useCallback((id: string, next: TabMemory) => {
    memory.current.set(id, { ...memory.current.get(id), ...next })
    scheduleSave()
  }, [scheduleSave])

  const rememberRatio = useCallback((ratio: number) => {
    ratioRef.current = ratio
    scheduleSave()
  }, [scheduleSave])

  const open = useCallback((target: OpenTarget, pane?: PaneId) => {
    const current = layoutRef.current
    const existing = current.tabs.find((t) => sameAs(t, target))
    const focusColumn = target.kind === 'table' && target.column ? { name: target.column, seq: Date.now() } : undefined
    const find = target.kind === 'routine' && target.find ? { text: target.find, seq: Date.now() } : undefined
    if (existing) {
      // Already open: bring it forward, moving it if a particular pane was asked for.
      setLayout((s) => {
        const moved = panes.moveTab(s, existing.id, pane ?? existing.pane)
        if (focusColumn) return { ...moved, tabs: moved.tabs.map((t) => (t.id === existing.id && t.kind === 'table' ? { ...t, focusColumn } : t)) }
        if (find) return { ...moved, tabs: moved.tabs.map((t) => (t.id === existing.id && t.kind === 'routine' ? { ...t, find } : t)) }
        return moved
      })
      return
    }
    const into = pane ?? current.focused
    const id = nextTabId()
    const tab: Tab = target.kind === 'table'
      ? { kind: 'table', id, pane: into, connectionId: target.connectionId, table: target.table, initialFilters: target.filters, focusColumn }
      : target.kind === 'routine'
        ? { kind: 'routine', id, pane: into, connectionId: target.connectionId, routine: target.routine, find }
        : target.kind === 'design'
        ? { kind: 'design', id, pane: into, connectionId: target.connectionId, table: target.table }
        : { kind: 'record', id, pane: into, connectionId: target.connectionId, table: target.table, key: target.key }
    setLayout((s) => panes.addTab(s, tab))
  }, [])

  const openTable = useCallback((connectionId: string, table: TableRef, filters: ColumnFilter[] = [], pane?: PaneId) =>
    open({ kind: 'table', connectionId, table, filters }, pane), [open])

  const openRecord = useCallback((connectionId: string, table: TableRef, key: ColumnFilter[], pane?: PaneId) =>
    open({ kind: 'record', connectionId, table, key }, pane), [open])

  const openQuery = useCallback((connectionId: string, sql = '') => {
    const title = `Query ${++queryCounter.current}`
    setLayout((s) => panes.addTab(s, { kind: 'query', id: nextTabId(), pane: s.focused, connectionId, title, initialSql: sql }))
  }, [])

  const setActiveTab = useCallback((id: string) => setLayout((s) => panes.activate(s, id)), [])
  const focusPane = useCallback((pane: PaneId) => setLayout((s) => panes.focusPane(s, pane)), [])
  const moveTab = useCallback((id: string, pane: PaneId) => setLayout((s) => panes.moveTab(s, id, pane)), [])
  const closeTab = useCallback((id: string) => {
    const warning = closeWarnings.get(id)
    if (warning && !window.confirm(`${warning}\n\nClose the tab anyway?`)) return
    setLayout((s) => panes.closeTab(s, id))
  }, [])

  const closeTabs = useCallback((id: string, scope: CloseScope) => {
    let ids = panes.tabsToClose(layoutRef.current, id, scope)
    const warned = ids.filter((t) => closeWarnings.has(t))
    if (warned.length) {
      const list = warned.map((t) => `• ${closeWarnings.get(t)}`).join('\n')
      const plural = warned.length === 1 ? 'tab has' : 'tabs have'
      // Cancel still closes the tabs that have nothing to lose.
      if (!window.confirm(`${warned.length} ${plural} unsaved work:\n\n${list}\n\nClose ${warned.length === 1 ? 'it' : 'them'} too?`)) {
        ids = ids.filter((t) => !closeWarnings.has(t))
      }
    }
    setLayout((s) => panes.closeTabs(s, ids, scope === 'all' ? undefined : id))
  }, [])

  const pinTab = useCallback((id: string, pinned: boolean) => setLayout((s) => panes.setPinned(s, id, pinned)), [])
  const reorderTab = useCallback((id: string, pane: PaneId, beforeId: string | null) =>
    setLayout((s) => panes.reorderTab(s, id, pane, beforeId)), [])

  const value = useMemo<AppState>(() => ({
    connections,
    reloadConnections,
    links,
    setLinks,
    tables,
    loadTables,
    forgetTables,
    routines,
    loadRoutines,
    tabs: layout.tabs,
    layout,
    activeTabId: panes.focusedTabId(layout),
    setActiveTab,
    focusPane,
    moveTab,
    open,
    openTable,
    openQuery,
    openRecord,
    closeTab,
    closeTabs,
    pinTab,
    reorderTab,
    schemaVersions,
    schemaChanged,
    connection: (id) => connections.find((c) => c.id === id),
    rememberTab,
    initialRatio,
    rememberRatio
  }), [connections, reloadConnections, links, setLinks, tables, loadTables, forgetTables, routines, loadRoutines, layout, setActiveTab, focusPane, moveTab, open, openTable, openQuery, openRecord, closeTab, closeTabs, pinTab, reorderTab, schemaVersions, schemaChanged, rememberTab, initialRatio, rememberRatio])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppState(): AppState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAppState must be used inside AppStateProvider')
  return ctx
}
