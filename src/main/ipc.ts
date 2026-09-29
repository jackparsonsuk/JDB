import { clipboard, ipcMain, nativeTheme } from 'electron'
import type { CellValue, ColumnFilter, ConnectionConfig, DbKind, TableExportRequest, ConnectionInput, CrossLink, LinkEnd, RelatedCountRequest, RowsRequest, SavedSession, TableRef, ThemeSetting, ValueLookup } from '@shared/types'
import * as db from './db'
import * as store from './store'
import { discoverLinks, verifyLink } from './links'
import { countRelated } from './explore'
import { signOutEntra } from './db/entra'
import { exportRows, exportTable, showExported } from './export'
import { exportConnections, importConnections } from './collections'
import { installUpdate, readyUpdate } from './updater'

/**
 * Registers a handler that returns { ok, value } or { ok: false, error } rather than throwing,
 * because Electron mangles thrown errors into "Error invoking remote method ..." strings.
 */
function handle<A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...(args as A)) }
    } catch (error) {
      return { ok: false, error: (error as Error)?.message ?? String(error) }
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
  handle('db:describe', (id: string, table: TableRef) => db.describeTable(id, table))
  handle('db:design', (id: string, table: TableRef) => db.describeDesign(id, table))
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
  handle('db:applyChanges', (id: string, statements: string[]) => db.applyChanges(id, statements))
  handle('tx:begin', (id: string) => db.beginTransaction(id))
  handle('tx:commit', (transactionId: string) => db.commitTransaction(transactionId))
  handle('tx:rollback', (transactionId: string) => db.rollbackTransaction(transactionId))
  handle('tx:open', (transactionId: string) => db.transactionOpen(transactionId))

  handle('export:rows', (columns: string[], rows: CellValue[][], kind: DbKind, name: string) => exportRows(columns, rows, kind, name))
  handle('export:table', (id: string, kind: DbKind, request: TableExportRequest) => exportTable(id, kind, request))
  handle('export:show', (path: string) => showExported(path))

  handle('db:countRelated', (id: string, requests: RelatedCountRequest[]) => countRelated(id, requests))
  handle('links:list', () => store.listLinks())
  handle('links:save', (links: CrossLink[]) => store.saveLinks(links))
  handle('links:delete', (id: string) => store.deleteLink(id))
  handle('links:discover', (a: string, b: string) => discoverLinks(a, b))
  handle('links:verify', (from: LinkEnd, to: LinkEnd) => verifyLink(from, to))

  handle('history:list', () => store.listHistory())
  handle('session:load', () => store.loadSession())
  // Fire-and-forget so the last save still lands while the window is closing.
  ipcMain.on('session:save', (_event, session: SavedSession) => {
    try {
      store.saveSession(session)
    } catch {
      // Losing a session save only means the next launch opens an older layout.
    }
  })
  handle('entra:signOut', async () => {
    await signOutEntra()
    // Open connections keep working until their token lapses; drop them so the next use signs in again.
    await db.disconnectAll()
  })
  handle('theme:get', () => store.getTheme())
  // nativeTheme drives prefers-color-scheme in the renderer and the native title bar.
  handle('theme:set', (theme: ThemeSetting) => {
    store.setTheme(theme)
    nativeTheme.themeSource = theme
  })
  handle('clipboard:write', (text: string) => clipboard.writeText(text))
  handle('update:ready', () => readyUpdate())
  handle('update:install', () => installUpdate())
}
