import type { ColumnFilter, ConnectionConfig, KeyKind, QueryResult, RowsRequest, SchemaTable, TableRef, ValueLookup } from '@shared/types'
import { findWriteKeyword } from '@shared/sqlGuard'
import { addHistory, getConnection } from '../store'
import { TimeoutError, type Driver } from './driver'
import { MssqlDriver } from './mssql'
import { MysqlDriver } from './mysql'

const drivers = new Map<string, { driver: Driver; config: ConnectionConfig }>()

function createDriver(config: ConnectionConfig, password?: string): Driver {
  return config.kind === 'mssql' ? new MssqlDriver(config, password) : new MysqlDriver(config, password)
}

function open(connectionId: string): { driver: Driver; config: ConnectionConfig } {
  let entry = drivers.get(connectionId)
  if (!entry) {
    const { config, password } = getConnection(connectionId)
    entry = { driver: createDriver(config, password), config }
    drivers.set(connectionId, entry)
  }
  return entry
}

/** Runs an operation and drops the cached driver if it fails, so the next call reconnects cleanly. */
async function withDriver<T>(connectionId: string, run: (driver: Driver, config: ConnectionConfig) => Promise<T>): Promise<T> {
  const entry = open(connectionId)
  try {
    return await run(entry.driver, entry.config)
  } catch (error) {
    if (isConnectionError(error)) await disconnect(connectionId)
    throw error
  }
}

function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? ''
  return ['ESOCKET', 'ELOGIN', 'ETIMEOUT', 'ECONNCLOSED', 'ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ER_ACCESS_DENIED_ERROR'].includes(code)
}

export async function disconnect(connectionId: string): Promise<void> {
  schemaCache.delete(connectionId)
  const entry = drivers.get(connectionId)
  drivers.delete(connectionId)
  await entry?.driver.close().catch(() => undefined)
}

export async function disconnectAll(): Promise<void> {
  await Promise.all([...drivers.keys()].map(disconnect))
}

/** Connects with an unsaved config to verify it works, then closes. */
export async function testConnection(config: ConnectionConfig, password?: string): Promise<void> {
  const stored = password === undefined && config.id ? getConnection(config.id).password : password
  const driver = createDriver(config, stored)
  try {
    await driver.query('SELECT 1')
  } finally {
    await driver.close().catch(() => undefined)
  }
}

export const listTables = (id: string) => withDriver(id, (d) => d.listTables())
export const describeTable = (id: string, table: TableRef) => withDriver(id, (d) => d.describeTable(table))
export const fetchRows = (id: string, request: RowsRequest) => withDriver(id, (d) => d.fetchRows(request))

/** Counts stop after this long; a huge table then shows its estimate instead. */
const COUNT_TIMEOUT_MS = 10_000

/** The number of rows matching the filters, or null if counting took too long. */
export const countRows = (id: string, table: TableRef, filters: ColumnFilter[]) =>
  withDriver(id, (d) => d.countRows(table, filters, COUNT_TIMEOUT_MS).catch((error) => {
    if (error instanceof TimeoutError) return null
    throw error
  }))
export const describeSchema = (id: string) => withDriver(id, (d) => d.describeSchema())

/** Schema reads are one big query; keep them per connection until it reconnects. */
const schemaCache = new Map<string, Promise<SchemaTable[]>>()
export function cachedSchema(id: string): Promise<SchemaTable[]> {
  let schema = schemaCache.get(id)
  if (!schema) {
    schema = describeSchema(id)
    schemaCache.set(id, schema)
    schema.catch(() => schemaCache.delete(id))
  }
  return schema
}
export const indexedColumns = (id: string, tables: TableRef[]) => withDriver(id, (d) => d.indexedColumns(tables))
export const countWhere = (id: string, table: TableRef, column: string, dataType: string, value: string, cap: number, timeoutMs: number) =>
  withDriver(id, (d) => d.countWhere(table, column, dataType, value, cap, timeoutMs))
export const distinctValues = (id: string, table: TableRef, column: string, limit: number, via?: ValueLookup) =>
  withDriver(id, (d) => d.distinctValues(table, column, limit, via))

export const sampleDistinct = (id: string, table: TableRef, column: string, limit: number) =>
  withDriver(id, (d) => d.sampleDistinct(table, column, limit))
export const countMatchingKeys = (id: string, table: TableRef, column: string, values: string[], kind: KeyKind) =>
  withDriver(id, (d) => d.countMatchingKeys(table, column, values, kind))

/** In-flight user queries by the run id the renderer gave them, so they can be cancelled. */
const runs = new Map<string, AbortController>()

export async function runQuery(connectionId: string, sql: string, runId?: string): Promise<QueryResult> {
  const started = Date.now()
  const controller = new AbortController()
  if (runId) runs.set(runId, controller)
  try {
    const result = await withDriver(connectionId, (driver, config) => {
      const keyword = config.readOnly ? findWriteKeyword(sql) : null
      if (keyword) {
        throw new Error(`Blocked: "${config.name}" is read-only and this query contains ${keyword}. Turn off read-only in the connection settings to allow changes.`)
      }
      return driver.query(sql, controller.signal)
    })
    addHistory({ connectionId, sql, ranAt: new Date().toISOString(), durationMs: result.durationMs })
    return result
  } catch (error) {
    addHistory({ connectionId, sql, ranAt: new Date().toISOString(), durationMs: Date.now() - started, error: String((error as Error).message ?? error) })
    throw error
  } finally {
    if (runId && runs.get(runId) === controller) runs.delete(runId)
  }
}

/** Stops a running query; a no-op if it has already finished. */
export function cancelQuery(runId: string): void {
  runs.get(runId)?.abort()
}
