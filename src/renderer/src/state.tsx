import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ColumnFilter, ConnectionConfig, CrossLink, SavedSession, SavedTab, TableInfo, TableRef, TableSort } from '@shared/types'
import * as panes from '@shared/panes'
import type { PaneId, Panes } from '@shared/panes'
import { forgetAllNlEngines, forgetNlEngine } from './lib/useNl'

export type Tab =
  | { kind: 'table'; id: string; pane: PaneId; connectionId: string; table: TableRef; initialFilters: ColumnFilter[]; initialSort?: TableSort }
  | { kind: 'query'; id: string; pane: PaneId; connectionId: string; title: string; initialSql: string }
  | { kind: 'record'; id: string; pane: PaneId; connectionId: string; table: TableRef; key: ColumnFilter[] }

/** Something a reference points at, which can be clicked open or dragged into a pane. */
export type OpenTarget =
  | { kind: 'table'; connectionId: string; table: TableRef; filters: ColumnFilter[] }
  | { kind: 'record'; connectionId: string; table: TableRef; key: ColumnFilter[] }

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

interface AppState {
  connections: ConnectionConfig[]
  reloadConnections(): Promise<void>
  /** Cross-database links, confirmed and dismissed. */
  links: CrossLink[]
  setLinks(links: CrossLink[]): void
  tables: Record<string, TablesState>
  loadTables(connectionId: string, force?: boolean): Promise<void>
  forgetTables(connectionId: string): void
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
  connection(id: string): ConnectionConfig | undefined
  /** Records a tab's current query text, filters or sort so the session saves them. */
  rememberTab(id: string, memory: TabMemory): void
  /** The split ratio restored from the last session. */
  initialRatio: number
  rememberRatio(ratio: number): void
}

const Ctx = createContext<AppState | null>(null)

let tabCounter = 0
const nextTabId = (): string => `tab-${++tabCounter}`

/** An open tab showing the same thing: an unfiltered table, or the same record. */
function sameAs(tab: Tab, target: OpenTarget): boolean {
  if (tab.kind === 'query' || tab.kind !== target.kind || tab.connectionId !== target.connectionId) return false
  if (tab.table.schema !== target.table.schema || tab.table.name !== target.table.name) return false
  if (tab.kind === 'table') return target.kind === 'table' && !target.filters.length && !tab.initialFilters.length
  return target.kind === 'record' && JSON.stringify(tab.key) === JSON.stringify(target.key)
}

/** How long after the last change the session is written. */
const SAVE_DELAY_MS = 500

function toSaved(tab: Tab, memory: TabMemory | undefined): SavedTab {
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
  }
}

function fromSaved(saved: SavedTab): Tab {
  const id = nextTabId()
  switch (saved.kind) {
    case 'query':
      return { kind: 'query', id, pane: saved.pane, connectionId: saved.connectionId, title: saved.title, initialSql: saved.sql }
    case 'table':
      return { kind: 'table', id, pane: saved.pane, connectionId: saved.connectionId, table: saved.table, initialFilters: saved.filters, initialSort: saved.sort }
    case 'record':
      return { kind: 'record', id, pane: saved.pane, connectionId: saved.connectionId, table: saved.table, key: saved.key }
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

  const forgetTables = useCallback((connectionId: string) => {
    forgetNlEngine(connectionId)
    setTables(({ [connectionId]: _removed, ...rest }) => rest)
  }, [])

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
    if (existing) {
      // Already open: bring it forward, moving it if a particular pane was asked for.
      setLayout((s) => panes.moveTab(s, existing.id, pane ?? existing.pane))
      return
    }
    const into = pane ?? current.focused
    const tab: Tab = target.kind === 'table'
      ? { kind: 'table', id: nextTabId(), pane: into, connectionId: target.connectionId, table: target.table, initialFilters: target.filters }
      : { kind: 'record', id: nextTabId(), pane: into, connectionId: target.connectionId, table: target.table, key: target.key }
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
  const closeTab = useCallback((id: string) => setLayout((s) => panes.closeTab(s, id)), [])

  const value = useMemo<AppState>(() => ({
    connections,
    reloadConnections,
    links,
    setLinks,
    tables,
    loadTables,
    forgetTables,
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
    connection: (id) => connections.find((c) => c.id === id),
    rememberTab,
    initialRatio,
    rememberRatio
  }), [connections, reloadConnections, links, setLinks, tables, loadTables, forgetTables, layout, setActiveTab, focusPane, moveTab, open, openTable, openQuery, openRecord, closeTab, rememberTab, initialRatio, rememberRatio])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppState(): AppState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAppState must be used inside AppStateProvider')
  return ctx
}
