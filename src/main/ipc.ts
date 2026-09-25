import { clipboard, ipcMain } from 'electron'
import type { ConnectionConfig, ConnectionInput, CrossLink, LinkEnd, RelatedCountRequest, RowsRequest, TableRef, ValueLookup } from '@shared/types'
import * as db from './db'
import * as store from './store'
import { discoverLinks, verifyLink } from './links'
import { countRelated } from './explore'

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
  handle('db:schema', (id: string) => db.cachedSchema(id))
  handle('db:distinct', (id: string, table: TableRef, column: string, limit: number, via?: ValueLookup) =>
    db.distinctValues(id, table, column, limit, via))
  handle('db:query', (id: string, sql: string, runId?: string) => db.runQuery(id, sql, runId))
  handle('db:cancel', (runId: string) => db.cancelQuery(runId))

  handle('db:countRelated', (id: string, requests: RelatedCountRequest[]) => countRelated(id, requests))
  handle('links:list', () => store.listLinks())
  handle('links:save', (links: CrossLink[]) => store.saveLinks(links))
  handle('links:delete', (id: string) => store.deleteLink(id))
  handle('links:discover', (a: string, b: string) => discoverLinks(a, b))
  handle('links:verify', (from: LinkEnd, to: LinkEnd) => verifyLink(from, to))

  handle('history:list', () => store.listHistory())
  handle('clipboard:write', (text: string) => clipboard.writeText(text))
}
