import type { ConnectionConfig, KeyKind, QueryResult, RowsRequest, TableRef, ValueLookup } from '@shared/types'
import { findWriteKeyword } from '@shared/sqlGuard'
import { addHistory, getConnection } from '../store'
import type { Driver } from './driver'
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
export const describeSchema = (id: string) => withDriver(id, (d) => d.describeSchema())
export const distinctValues = (id: string, table: TableRef, column: string, limit: number, via?: ValueLookup) =>
  withDriver(id, (d) => d.distinctValues(table, column, limit, via))

export const sampleDistinct = (id: string, table: TableRef, column: string, limit: number) =>
  withDriver(id, (d) => d.sampleDistinct(table, column, limit))
export const countMatchingKeys = (id: string, table: TableRef, column: string, values: string[], kind: KeyKind) =>
  withDriver(id, (d) => d.countMatchingKeys(table, column, values, kind))

export async function runQuery(connectionId: string, sql: string): Promise<QueryResult> {
  const started = Date.now()
  try {
    const result = await withDriver(connectionId, (driver, config) => {
      const keyword = config.readOnly ? findWriteKeyword(sql) : null
      if (keyword) {
        throw new Error(`Blocked: "${config.name}" is read-only and this query contains ${keyword}. Turn off read-only in the connection settings to allow changes.`)
      }
      return driver.query(sql)
    })
    addHistory({ connectionId, sql, ranAt: new Date().toISOString(), durationMs: result.durationMs })
    return result
  } catch (error) {
    addHistory({ connectionId, sql, ranAt: new Date().toISOString(), durationMs: Date.now() - started, error: String((error as Error).message ?? error) })
    throw error
  }
}
