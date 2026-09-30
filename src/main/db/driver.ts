import type {
  CellValue, ColumnFilter, ColumnInfo, QueryResult, RowsRequest, RowsResult, SchemaTable, TableDetails, TableInfo, TableRef,
  ColumnSummary, KeyKind, RoutineDefinition, RoutineInfo, RoutineRef, RoutineSource, TableDesign, ValueLookup
} from '@shared/types'

export interface Driver {
  listTables(): Promise<TableInfo[]>
  describeTable(table: TableRef): Promise<TableDetails>
  /** Columns with defaults and collations, indexes and foreign keys, for the table designer. */
  describeDesign(table: TableRef): Promise<TableDesign>
  /** Forgets cached table metadata (primary keys) after the schema has changed. */
  forgetCaches(): void
  /** Stored procedures, functions and triggers, without their source. */
  listRoutines(): Promise<RoutineInfo[]>
  /** One routine's source (null when this login can't see it) and parameters. */
  describeRoutine(routine: RoutineRef): Promise<RoutineDefinition>
  /** Every routine's source in one pass, for searching inside them. */
  routineSources(): Promise<RoutineSource[]>
  /** Every column of every table in one pass (tables come from listTables for row estimates). */
  describeSchema(): Promise<SchemaTable[]>
  /** Distinct non-null values of a column, or null when there are more than `limit`. */
  distinctValues(table: TableRef, column: string, limit: number, via?: ValueLookup): Promise<CellValue[] | null>
  /** Up to `limit` distinct non-null values of a column, for checking cross-database links. */
  sampleDistinct(table: TableRef, column: string, limit: number): Promise<CellValue[]>
  /** How many of `values` exist in `column` (a key, so each matches at most one row). */
  countMatchingKeys(table: TableRef, column: string, values: string[], kind: KeyKind): Promise<number>
  /** Columns that lead an index, as lowercased "schema.table.column" keys. */
  indexedColumns(tables: TableRef[]): Promise<Set<string>>
  /** Rows where column = value, counting at most cap + 1; rejects with TimeoutError after timeoutMs. */
  countWhere(table: TableRef, column: string, dataType: string, value: string, cap: number, timeoutMs: number): Promise<number>
  fetchRows(request: RowsRequest): Promise<RowsResult>
  /** Rows matching the filters; rejects with TimeoutError after timeoutMs. */
  countRows(table: TableRef, filters: ColumnFilter[], timeoutMs: number): Promise<number>
  /** Count, distinct and (numeric columns) sum/average/min/max over the filtered rows; TimeoutError after timeoutMs. */
  summarize(table: TableRef, filters: ColumnFilter[], column: string, dataType: string, timeoutMs: number): Promise<ColumnSummary>
  /** Runs user SQL; aborting `signal` stops it on the server and rejects with QueryCancelledError. */
  query(sql: string, signal?: AbortSignal): Promise<QueryResult>
  /** Starts a transaction on a connection of its own, held until it is committed or rolled back. */
  begin(): Promise<DriverTransaction>
  close(): Promise<void>
}

export interface DriverTransaction {
  /** False once committed, rolled back, or ended by the server (e.g. a deadlock victim). */
  readonly open: boolean
  query(sql: string, signal?: AbortSignal): Promise<QueryResult>
  /** Runs one statement and returns how many rows it matched. */
  execute(sql: string): Promise<number>
  commit(): Promise<void>
  /** A no-op once the transaction has ended. */
  rollback(): Promise<void>
}

/** Row shape both drivers' schema queries return, one row per column (and per FK it belongs to). */
export interface SchemaColumnRow {
  schema: string
  table: string
  column: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
  isIdentity: boolean
  refSchema: string | null
  refTable: string | null
  refColumn: string | null
}

/** Groups flat column rows under their tables, keeping the first FK when a column is in several. */
export function assembleSchema(tables: TableInfo[], rows: SchemaColumnRow[]): SchemaTable[] {
  const byKey = new Map<string, SchemaTable>(tables.map((t) => [`${t.schema}.${t.name}`, { ...t, columns: [] }]))
  const seen = new Set<string>()
  for (const row of rows) {
    const table = byKey.get(`${row.schema}.${row.table}`)
    const key = `${row.schema}.${row.table}.${row.column}`
    if (!table || seen.has(key)) continue
    seen.add(key)
    const column: ColumnInfo = {
      name: row.column,
      dataType: row.dataType,
      nullable: row.nullable,
      isPrimaryKey: row.isPrimaryKey,
      isIdentity: row.isIdentity,
      references: row.refTable ? { schema: row.refSchema!, name: row.refTable, column: row.refColumn! } : undefined
    }
    table.columns.push(column)
  }
  return [...byKey.values()]
}

/** SELECT DISTINCT body shared by both drivers: the column itself, or a lookup's display column via the FK. */
export function distinctSource(
  quote: (identifier: string) => string,
  qualified: (table: TableRef) => string,
  table: TableRef,
  column: string,
  via?: ValueLookup
): { expr: string; from: string } {
  if (!via) {
    return { expr: quote(column), from: `${qualified(table)} WHERE ${quote(column)} IS NOT NULL` }
  }
  const expr = `r.${quote(via.display)}`
  return {
    expr,
    from: `${qualified(table)} t JOIN ${qualified(via.table)} r ON r.${quote(via.column)} = t.${quote(column)} WHERE ${expr} IS NOT NULL`
  }
}

/** SQL Server can't compare these, so COUNT(DISTINCT ...) on them fails. */
export const MSSQL_UNCOMPARABLE = /^(n?text|image|xml|geography|geometry|hierarchyid|sql_variant)\b/i

/** Builds a summary from the aggregate row both drivers select as n, d, s, a, lo, hi. */
export function summaryFrom(row: Record<string, unknown>, numeric: boolean, distinct: boolean): ColumnSummary {
  const num = (v: unknown): number => (v === null || v === undefined ? NaN : Number(v))
  const count = num(row.n)
  const summary: ColumnSummary = { count: Number.isFinite(count) ? count : 0 }
  if (distinct) summary.distinct = num(row.d)
  // With no non-null values SUM and the rest are NULL; there's nothing to show.
  if (numeric && summary.count > 0) summary.numeric = { sum: num(row.s), average: num(row.a), min: num(row.lo), max: num(row.hi) }
  return summary
}

export class TimeoutError extends Error {
  constructor() {
    super('Query timed out')
  }
}

export class QueryCancelledError extends Error {
  constructor() {
    super('Query cancelled')
  }
}

export const indexKey = (schema: string, table: string, column: string): string => `${schema}.${table}.${column}`.toLowerCase()

/** Key lookups are sent in batches to stay well under SQL Server's 2100-parameter / statement limits. */
export const KEY_BATCH = 500

/** Sampling only scans this many rows, so a huge table (e.g. a 100M-row log) stays cheap. */
export const SAMPLE_SCAN_ROWS = 5000

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const MAX_BINARY_PREVIEW = 64

/** Converts driver values into something that renders and clones cleanly over IPC. */
export function toCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Date) return isNaN(value.getTime()) ? String(value) : value.toISOString()
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, MAX_BINARY_PREVIEW).toString('hex').toUpperCase()
    return `0x${hex}${value.length > MAX_BINARY_PREVIEW ? `… (${value.length} bytes)` : ''}`
  }
  return JSON.stringify(value)
}
