import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ColumnFilter, ConnectionConfig, TableInfo, TableRef } from '@shared/types'
import { forgetNlEngine } from './lib/useNl'

export type Tab =
  | { kind: 'table'; id: string; connectionId: string; table: TableRef; initialFilters: ColumnFilter[] }
  | { kind: 'query'; id: string; connectionId: string; title: string; initialSql: string }

export interface TablesState {
  status: 'loading' | 'ready' | 'error'
  tables: TableInfo[]
  error?: string
}

interface AppState {
  connections: ConnectionConfig[]
  reloadConnections(): Promise<void>
  tables: Record<string, TablesState>
  loadTables(connectionId: string, force?: boolean): Promise<void>
  forgetTables(connectionId: string): void
  tabs: Tab[]
  activeTabId: string | null
  setActiveTab(id: string): void
  openTable(connectionId: string, table: TableRef, filters?: ColumnFilter[]): void
  openQuery(connectionId: string, sql?: string): void
  closeTab(id: string): void
  connection(id: string): ConnectionConfig | undefined
}

const Ctx = createContext<AppState | null>(null)

let tabCounter = 0
const nextTabId = (): string => `tab-${++tabCounter}`

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [tables, setTables] = useState<Record<string, TablesState>>({})
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)

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

  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const queryCounter = useRef(0)

  const addTab = useCallback((tab: Tab) => {
    setTabs((prev) => [...prev, tab])
    setActiveTabId(tab.id)
  }, [])

  const openTable = useCallback((connectionId: string, table: TableRef, filters: ColumnFilter[] = []) => {
    // Re-use an existing unfiltered tab for the same table rather than stacking duplicates.
    const existing = !filters.length && tabsRef.current.find(
      (t) => t.kind === 'table' && t.connectionId === connectionId && t.table.schema === table.schema &&
        t.table.name === table.name && !t.initialFilters.length
    )
    if (existing) setActiveTabId(existing.id)
    else addTab({ kind: 'table', id: nextTabId(), connectionId, table, initialFilters: filters })
  }, [addTab])

  const openQuery = useCallback((connectionId: string, sql = '') => {
    addTab({ kind: 'query', id: nextTabId(), connectionId, title: `Query ${++queryCounter.current}`, initialSql: sql })
  }, [addTab])

  const closeTab = useCallback((id: string) => {
    const prev = tabsRef.current
    const index = prev.findIndex((t) => t.id === id)
    const next = prev.filter((t) => t.id !== id)
    setTabs(next)
    setActiveTabId((active) => (active === id ? (next[Math.min(index, next.length - 1)]?.id ?? null) : active))
  }, [])

  const value = useMemo<AppState>(() => ({
    connections,
    reloadConnections,
    tables,
    loadTables,
    forgetTables,
    tabs,
    activeTabId,
    setActiveTab: setActiveTabId,
    openTable,
    openQuery,
    closeTab,
    connection: (id) => connections.find((c) => c.id === id)
  }), [connections, reloadConnections, tables, loadTables, forgetTables, tabs, activeTabId, openTable, openQuery, closeTab])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAppState(): AppState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAppState must be used inside AppStateProvider')
  return ctx
}
