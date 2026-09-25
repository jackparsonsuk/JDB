import { clipboard, ipcMain } from 'electron'
import type { ConnectionConfig, ConnectionInput, RowsRequest, TableRef, ValueLookup } from '@shared/types'
import * as db from './db'
import * as store from './store'

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

  handle('db:tables', (id: string) => db.listTables(id))
  handle('db:describe', (id: string, table: TableRef) => db.describeTable(id, table))
  handle('db:rows', (id: string, request: RowsRequest) => db.fetchRows(id, request))
  handle('db:schema', (id: string) => db.describeSchema(id))
  handle('db:distinct', (id: string, table: TableRef, column: string, limit: number, via?: ValueLookup) =>
    db.distinctValues(id, table, column, limit, via))
  handle('db:query', (id: string, sql: string) => db.runQuery(id, sql))

  handle('history:list', () => store.listHistory())
  handle('clipboard:write', (text: string) => clipboard.writeText(text))
}
