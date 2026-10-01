import { clipboard, ipcMain, nativeTheme, type IpcMainInvokeEvent } from 'electron'
import type { LookupLink } from '@shared/lookups'
import { nativeThemeOf } from '@shared/types'
import type { CellValue, ColumnFilter, ConnectionConfig, DbKind, TableExportRequest, ConnectionInput, CrossLink, LinkEnd, RelatedCountRequest, RoutineRef, RowsRequest, SavedQueryInput, SavedSession, TableRef, ThemeSetting, ValueLookup } from '@shared/types'
import * as db from './db'
import * as store from './store'
import { discoverLinks, verifyLink } from './links'
import { countRelated, planValueSearch } from './explore'
import { signOutEntra } from './db/entra'
import { exportRows, exportTable, showExported } from './export'
import { exportConnections, importConnections } from './collections'
import { checkNow, installUpdate, readyUpdate } from './updater'
import { notifyOthers, openWindow, saveSessionFrom, sessionFor, setUnsaved, takeCarried } from './windows'

/**
 * What each saving call changes, so the other windows re-read it: a connection saved in one
 * window shows in the others' sidebars, a theme picked in one applies to all.
 */
const CHANGES: Record<string, string[]> = {
  'connections:save': ['connections'],
  'connections:delete': ['connections'],
  'connections:setFolder': ['connections'],
  'connections:import': ['connections', 'queries', 'links', 'environments'],
  'queries:save': ['queries'],
  'queries:delete': ['queries'],
  'links:save': ['links'],
  'links:delete': ['links'],
  'lookups:save': ['lookups'],
  'lookups:delete': ['lookups'],
  'envs:save': ['environments'],
  'envs:delete': ['environments', 'connections'],
  'theme:set': ['theme'],
  'appearance:set': ['appearance']
}

/**
 * Registers a handler that returns { ok, value } or { ok: false, error } rather than throwing,
 * because Electron mangles thrown errors into "Error invoking remote method ..." strings.
 */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  handleFrom<A, R>(channel, (_event, ...args) => fn(...args))
}

/** Like handle, with the calling window's event first, for calls that depend on which window asked. */
function handleFrom<A extends unknown[], R>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const value = await fn(event, ...(args as A))
      if (CHANGES[channel]) notifyOthers(event.sender, CHANGES[channel])
      return { ok: true, value }
    } catch (error) {
      // sqlLine: where in the SQL a query error happened (SQL Server), for the editor to point at.
      const sqlLine = (error as { sqlLine?: unknown })?.sqlLine
      return { ok: false, error: (error as Error)?.message ?? String(error), ...(typeof sqlLine === 'number' && { sqlLine }) }
    }
  })
}

export function registerIpc(): void {
  handle('connections:list', () => store.listConnections())
  handle('connections:save', async (input: ConnectionInput) => {
    const saved = store.saveConnection(input)
    await db.disconnect(saved.id)
    return saved
  })
  handle('connections:delete', async (id: string) => {
    await db.disconnect(id)
    store.deleteConnection(id)
  })
  handle('connections:test', (config: ConnectionConfig, password?: string) => db.testConnection(config, password))
  handle('connections:disconnect', (id: string) => db.disconnect(id))
  handle('connections:setFolder', (ids: string[], folder: string) => store.setFolder(ids, folder))
  handle('connections:export', (ids: string[] | null, name: string) => exportConnections(ids, name))
  handle('connections:import', () => importConnections())

  handle('db:tables', (id: string) => db.listTables(id))
  handle('db:databases', (id: string) => db.listDatabases(id))
  handle('db:describe', (id: string, table: TableRef) => db.describeTable(id, table))
  handle('db:design', (id: string, table: TableRef) => db.describeDesign(id, table))
  handle('db:routines', (id: string) => db.listRoutines(id))
  handle('db:routine', (id: string, routine: RoutineRef) => db.describeRoutine(id, routine))
  handle('db:routineSources', (id: string) => db.routineSources(id))
  handle('db:applyDesign', (id: string, statements: string[]) => db.applyDesign(id, statements))
  handle('db:rows', (id: string, request: RowsRequest) => db.fetchRows(id, request))
  handle('db:count', (id: string, table: TableRef, filters: ColumnFilter[]) => db.countRows(id, table, filters))
  handle('db:summarize', (id: string, table: TableRef, filters: ColumnFilter[], column: string, dataType: string) =>
    db.summarizeColumn(id, table, filters, column, dataType))
  handle('db:schema', (id: string) => db.cachedSchema(id))
  handle('db:distinct', (id: string, table: TableRef, column: string, limit: number, via?: ValueLookup) =>
    db.distinctValues(id, table, column, limit, via))
  handle('db:query', (id: string, sql: string, runId?: string, transactionId?: string) => db.runQuery(id, sql, runId, transactionId))
  handle('db:cancel', (runId: string) => db.cancelQuery(runId))
  handle('db:countForWrite', (id: string, sql: string) => db.countForWrite(id, sql))
  handle('db:snapshotRows', (id: string, sql: string, transactionId?: string) => db.snapshotRows(id, sql, transactionId))
  handle('db:applyChanges', (id: string, statements: string[]) => db.applyChanges(id, statements))
  handleFrom('tx:begin', (event, id: string) => db.beginTransaction(id, event.sender.id))
  handle('tx:commit', (transactionId: string) => db.commitTransaction(transactionId))
  handle('tx:rollback', (transactionId: string) => db.rollbackTransaction(transactionId))
  handle('tx:open', (transactionId: string) => db.transactionOpen(transactionId))

  handle('export:rows', (columns: string[], rows: CellValue[][], kind: DbKind, name: string) => exportRows(columns, rows, kind, name))
  handle('export:table', (id: string, kind: DbKind, request: TableExportRequest) => exportTable(id, kind, request))
  handle('export:show', (path: string) => showExported(path))

  handle('db:countRelated', (id: string, requests: RelatedCountRequest[]) => countRelated(id, requests))
  handle('db:planValueSearch', (id: string, value: string) => planValueSearch(id, value))
  handle('links:list', () => store.listLinks())
  handle('lookups:list', () => store.listLookups())
  handle('lookups:save', (link: LookupLink) => store.saveLookup(link))
  handle('lookups:delete', (id: string) => store.deleteLookup(id))
  handle('links:save', (links: CrossLink[]) => store.saveLinks(links))
  handle('links:delete', (id: string) => store.deleteLink(id))
  handle('links:discover', (a: string, b: string) => discoverLinks(a, b))
  handle('links:verify', (from: LinkEnd, to: LinkEnd) => verifyLink(from, to))

  handle('history:list', () => store.listHistory())
  handle('envs:list', () => store.listEnvironments())
  handle('envs:save', (environments: unknown) => store.saveEnvironments(environments))
  handle('envs:delete', (id: string, moveTo: string) => store.deleteEnvironment(id, moveTo))
  handle('queries:list', () => store.listQueries())
  handle('queries:save', (input: SavedQueryInput) => store.saveQuery(input))
  handle('queries:delete', (id: string) => store.deleteQuery(id))
  // Each window loads and saves its own tabs; main keeps them together in session.json.
  handleFrom('session:load', (event) => sessionFor(event.sender))
  // Fire-and-forget so the last save still lands while the window is closing.
  ipcMain.on('session:save', (event, session: SavedSession) => saveSessionFrom(event.sender, session))
  ipcMain.on('app:unsaved', (event, warnings: unknown) => {
    setUnsaved(event.sender, Array.isArray(warnings) ? warnings.filter((w): w is string => typeof w === 'string') : [])
  })
  /** A new window: empty, or opening with `session`'s tabs (a tab moved out of another window). */
  handle('window:open', (session?: SavedSession, carried?: unknown) => {
    openWindow({ session, carried })
  })
  handleFrom('window:carried', (event) => takeCarried(event.sender))
  handle('entra:signOut', async () => {
    await signOutEntra()
    // Open connections keep working until their token lapses; drop them so the next use signs in again.
    await db.disconnectAll()
  })
  handle('theme:get', () => store.getTheme())
  // nativeTheme drives prefers-color-scheme in the renderer and the native title bar.
  handle('theme:set', (theme: ThemeSetting) => {
    store.setTheme(theme)
    nativeTheme.themeSource = nativeThemeOf(theme)
  })
  handle('appearance:get', () => store.getAppearance())
  handle('appearance:set', (appearance: unknown) => store.setAppearance(appearance))
  // Interface size: zooming the page scales everything, grid rows included, evenly.
  ipcMain.handle('app:zoom', (event, factor: number) => {
    if (typeof factor === 'number' && factor >= 0.5 && factor <= 2) event.sender.setZoomFactor(factor)
  })
  handle('clipboard:write', (text: string) => clipboard.writeText(text))
  handle('clipboard:read', () => clipboard.readText())
  handle('update:ready', () => readyUpdate())
  handle('update:install', () => installUpdate())
  handle('update:check', () => checkNow())
}
