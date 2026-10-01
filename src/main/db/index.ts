import { randomUUID } from 'crypto'
import type { ColumnFilter, ConnectionConfig, KeyKind, QueryResult, ResultSet, RoutineRef, RoutineSource, RowsRequest, SchemaTable, TableRef, ValueLookup, WriteCount } from '@shared/types'
import { findImplicitCommit, findTransactionControl, findWriteKeyword } from '@shared/sqlGuard'
import { MAX_PAGE_SIZE } from '@shared/rows'
import { addHistory, getAppearance, getConnection } from '../store'
import { TimeoutError, type Driver, type DriverTransaction } from './driver'
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
  sourceCache.delete(connectionId)
  await Promise.all([...transactions].filter(([, t]) => t.connectionId === connectionId).map(([id]) => rollbackTransaction(id).catch(() => undefined)))
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
export const listDatabases = (id: string) => withDriver(id, (d) => d.listDatabases())
export const describeTable = (id: string, table: TableRef) => withDriver(id, (d) => d.describeTable(table))
export const describeDesign = (id: string, table: TableRef) => withDriver(id, (d) => d.describeDesign(table))
export const listRoutines = (id: string) => withDriver(id, (d) => d.listRoutines())
export const describeRoutine = (id: string, routine: RoutineRef) => withDriver(id, (d) => d.describeRoutine(routine))

/** Every routine's source, for searching inside them; kept like the schema until DDL or a reconnect. */
const sourceCache = new Map<string, Promise<RoutineSource[]>>()
export function routineSources(id: string): Promise<RoutineSource[]> {
  let sources = sourceCache.get(id)
  if (!sources) {
    sources = withDriver(id, (d) => d.routineSources())
    sourceCache.set(id, sources)
    sources.catch(() => sourceCache.delete(id))
  }
  return sources
}

const SCHEMA_CHANGE = /^(CREATE|ALTER|DROP|RENAME|TRUNCATE|EXEC|EXECUTE|SELECT INTO)$/

/** Drops cached schema and key lists after DDL, so the next read sees the new columns. */
function forgetSchema(connectionId: string): void {
  schemaCache.delete(connectionId)
  sourceCache.delete(connectionId)
  drivers.get(connectionId)?.driver.forgetCaches()
}

/**
 * Runs a table designer script. SQL Server's DDL is transactional, so its steps run in one
 * transaction and a failure changes nothing. MySQL commits DDL at once, so the designer gives
 * it a single ALTER TABLE, which the server applies atomically.
 */
export async function applyDesign(connectionId: string, statements: string[]): Promise<number> {
  const started = Date.now()
  const sql = statements.join('\n')
  try {
    await withDriver(connectionId, async (driver, config) => {
      if (config.readOnly) throw new Error(`"${config.name}" is read-only. Turn off read-only in the connection settings to change tables.`)
      if (config.kind === 'mysql') {
        for (const statement of statements) await driver.query(statement)
        return
      }
      const tx = await driver.begin()
      try {
        for (const [i, statement] of statements.entries()) {
          try {
            await tx.query(statement)
          } catch (error) {
            throw new Error(`Nothing was changed. Step ${i + 1} of ${statements.length} failed: ${(error as Error).message}\n\n${statement}`)
          }
        }
        await tx.commit()
      } catch (error) {
        await tx.rollback().catch(() => undefined)
        throw error
      }
    })
    addHistory({ connectionId, sql, ranAt: new Date().toISOString(), durationMs: Date.now() - started })
    return statements.length
  } catch (error) {
    addHistory({ connectionId, sql, ranAt: new Date().toISOString(), durationMs: Date.now() - started, error: String((error as Error).message ?? error) })
    throw error
  } finally {
    // Even a failed MySQL script may have changed something.
    forgetSchema(connectionId)
  }
}
export const fetchRows = (id: string, request: RowsRequest) =>
  withDriver(id, (d) => d.fetchRows({ ...request, limit: Math.min(request.limit, MAX_PAGE_SIZE) }))

/** Counts stop after this long; a huge table then shows its estimate instead. */
const COUNT_TIMEOUT_MS = 10_000

/** The number of rows matching the filters, or null if counting took too long. */
export const countRows = (id: string, table: TableRef, filters: ColumnFilter[]) =>
  withDriver(id, (d) => d.countRows(table, filters, COUNT_TIMEOUT_MS).catch((error) => {
    if (error instanceof TimeoutError) return null
    throw error
  }))
export const describeSchema = (id: string) => withDriver(id, (d) => d.describeSchema())

/** A column summarised across every row matching the filters, or null if it took over COUNT_TIMEOUT_MS. */
export const summarizeColumn = (id: string, table: TableRef, filters: ColumnFilter[], column: string, dataType: string) =>
  withDriver(id, (d) => d.summarize(table, filters, column, dataType, COUNT_TIMEOUT_MS).catch((error) => {
    if (error instanceof TimeoutError) return null
    throw error
  }))

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

/** Runs user SQL; with `transactionId` it runs inside that open transaction instead of committing. */
/**
 * Cuts each result set to Settings' row limit, saying so in `capped`. The driver has still read
 * them all; this keeps a huge SELECT * from flooding the window.
 */
export function capRows(result: QueryResult, max: number | undefined): QueryResult {
  if (!max || !result.resultSets.some((rs) => rs.rows.length > max)) return result
  return { ...result, capped: max, resultSets: result.resultSets.map((rs) => (rs.rows.length > max ? { ...rs, rows: rs.rows.slice(0, max) } : rs)) }
}

export async function runQuery(connectionId: string, sql: string, runId?: string, transactionId?: string): Promise<QueryResult> {
  const started = Date.now()
  const controller = new AbortController()
  if (runId) runs.set(runId, controller)
  try {
    const result = await withDriver(connectionId, (driver, config) => {
      const keyword = config.readOnly ? findWriteKeyword(sql) : null
      if (keyword) {
        throw new Error(`Blocked: "${config.name}" is read-only and this query contains ${keyword}. Turn off read-only in the connection settings to allow changes.`)
      }
      if (!transactionId) return driver.query(sql, controller.signal)
      const { tx } = openTransaction(transactionId, connectionId)
      const control = findTransactionControl(sql, config.kind)
      if (control) throw new Error(`${control} can't run inside the staged transaction. Use the Commit or Roll back buttons instead.`)
      const implicit = config.kind === 'mysql' ? findImplicitCommit(sql) : null
      if (implicit) {
        throw new Error(`MySQL commits the open transaction before ${implicit}, so it can't be staged. Commit or roll back first, then run it on its own.`)
      }
      return tx.query(sql, controller.signal)
    })
    addHistory({ connectionId, sql, ranAt: new Date().toISOString(), durationMs: result.durationMs })
    const keyword = findWriteKeyword(sql)
    if (keyword && SCHEMA_CHANGE.test(keyword)) forgetSchema(connectionId)
    return capRows(result, getAppearance().maxRows)
  } catch (error) {
    addHistory({ connectionId, sql, ranAt: new Date().toISOString(), durationMs: Date.now() - started, error: String((error as Error).message ?? error) })
    throw error
  } finally {
    if (runId && runs.get(runId) === controller) runs.delete(runId)
  }
}

/** How long counting a write's rows may take before it is stopped; test databases are shared. */
const WRITE_COUNT_TIMEOUT_MS = 10_000

/**
 * Runs the SELECT COUNT(*) that previews a write (see @shared/writePreview). Refused if it could
 * change anything, stopped after WRITE_COUNT_TIMEOUT_MS, and kept out of the query history.
 */
export async function countForWrite(connectionId: string, sql: string): Promise<WriteCount> {
  const keyword = findWriteKeyword(sql)
  if (keyword) return { status: 'failed', error: `The count query contains ${keyword}, so it wasn't run.` }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WRITE_COUNT_TIMEOUT_MS)
  try {
    const result = await withDriver(connectionId, (driver) => driver.query(sql, controller.signal))
    const rows = Number(result.resultSets[0]?.rows[0]?.[0])
    return Number.isFinite(rows) ? { status: 'counted', rows } : { status: 'failed', error: 'The count came back empty.' }
  } catch (error) {
    if (controller.signal.aborted) return { status: 'timeout', seconds: WRITE_COUNT_TIMEOUT_MS / 1000 }
    return { status: 'failed', error: String((error as Error).message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Reads rows quietly: an UPDATE's rows before and after it runs (see @shared/writeDiff), and lookup lists. Like
 * countForWrite: refused if it could write, stopped after WRITE_COUNT_TIMEOUT_MS and kept out of
 * the history. With `transactionId` it reads inside that transaction, so staged changes show.
 */
export async function snapshotRows(connectionId: string, sql: string, transactionId?: string): Promise<ResultSet> {
  const keyword = findWriteKeyword(sql)
  if (keyword) throw new Error(`The read contains ${keyword}, so it wasn't run.`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WRITE_COUNT_TIMEOUT_MS)
  try {
    const result = await withDriver(connectionId, (driver) =>
      transactionId ? openTransaction(transactionId, connectionId).tx.query(sql, controller.signal) : driver.query(sql, controller.signal))
    return result.resultSets[0] ?? { columns: [], rows: [] }
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`Reading the rows took over ${WRITE_COUNT_TIMEOUT_MS / 1000} s, so it was stopped.`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** Stops a running query; a no-op if it has already finished. */
export function cancelQuery(runId: string): void {
  runs.get(runId)?.abort()
}

/**
 * Transactions staged from query tabs, by id. Each holds its own connection until it ends, and
 * `owner` is the window (webContents id) whose tab opened it, so a window that reloads or closes
 * rolls back only its own.
 */
const transactions = new Map<string, { connectionId: string; tx: DriverTransaction; owner?: number }>()

function openTransaction(id: string, connectionId?: string): { connectionId: string; tx: DriverTransaction } {
  const entry = transactions.get(id)
  if (!entry || !entry.tx.open) {
    transactions.delete(id)
    throw new Error('The transaction is no longer open. The server rolled it back, so none of its changes were kept.')
  }
  if (connectionId && entry.connectionId !== connectionId) throw new Error('That transaction belongs to another connection.')
  return entry
}

const logged = (connectionId: string, sql: string, error?: unknown): void =>
  addHistory({ connectionId, sql, ranAt: new Date().toISOString(), durationMs: 0, ...(error ? { error: String((error as Error).message ?? error) } : {}) })

export async function beginTransaction(connectionId: string, owner?: number): Promise<string> {
  const tx = await withDriver(connectionId, (driver, config) => {
    if (config.readOnly) throw new Error(`"${config.name}" is read-only, so there is nothing to commit.`)
    return driver.begin()
  })
  const id = randomUUID()
  transactions.set(id, { connectionId, tx, owner })
  logged(connectionId, 'BEGIN TRANSACTION')
  return id
}

/** Whether the transaction can still be committed; false once the server has rolled it back. */
export function transactionOpen(id: string): boolean {
  return transactions.get(id)?.tx.open ?? false
}

export async function commitTransaction(id: string): Promise<void> {
  const { connectionId, tx } = openTransaction(id)
  transactions.delete(id)
  try {
    await tx.commit()
    logged(connectionId, 'COMMIT')
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    logged(connectionId, 'COMMIT', error)
    throw new Error(`Commit failed: ${(error as Error).message}\n\nThe transaction has been closed. Check the data to see whether its changes were kept.`)
  }
}

/** A no-op when the transaction has already ended. */
export async function rollbackTransaction(id: string): Promise<void> {
  const entry = transactions.get(id)
  if (!entry) return
  transactions.delete(id)
  const wasOpen = entry.tx.open
  await entry.tx.rollback()
  if (wasOpen) logged(entry.connectionId, 'ROLLBACK')
}

/** Rolls back the transactions a window staged, e.g. when it reloads and forgets them, or closes. */
export async function rollbackOwnedBy(owner: number): Promise<void> {
  const ids = [...transactions].filter(([, t]) => t.owner === owner).map(([id]) => id)
  await Promise.all(ids.map((id) => rollbackTransaction(id).catch(() => undefined)))
}

/**
 * Saves edits made in the table grid, all or nothing: every statement must match exactly one
 * row (they are keyed by primary key), otherwise the whole transaction is rolled back.
 */
export async function applyChanges(connectionId: string, statements: string[]): Promise<number> {
  const started = Date.now()
  const sql = statements.join('\n')
  try {
    await withDriver(connectionId, async (driver, config) => {
      if (config.readOnly) throw new Error(`"${config.name}" is read-only. Turn off read-only in the connection settings to allow changes.`)
      const tx = await driver.begin()
      try {
        for (const [i, statement] of statements.entries()) {
          let matched: number
          try {
            matched = await tx.execute(statement)
          } catch (error) {
            throw new Error(`Nothing was saved. Change ${i + 1} of ${statements.length} failed: ${(error as Error).message}\n\n${statement}`)
          }
          if (matched !== 1) {
            throw new Error(`Nothing was saved. Change ${i + 1} of ${statements.length} matched ${matched} rows instead of 1, so the data may have changed since it was loaded.\n\n${statement}`)
          }
        }
        await tx.commit()
      } catch (error) {
        await tx.rollback().catch(() => undefined)
        throw error
      }
    })
    addHistory({ connectionId, sql, ranAt: new Date().toISOString(), durationMs: Date.now() - started })
    return statements.length
  } catch (error) {
    addHistory({ connectionId, sql, ranAt: new Date().toISOString(), durationMs: Date.now() - started, error: String((error as Error).message ?? error) })
    throw error
  }
}
