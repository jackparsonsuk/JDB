import type {
  CellValue, ColumnInfo, QueryResult, RowsRequest, RowsResult, SchemaTable, TableDetails, TableInfo, TableRef,
  ValueLookup
} from '@shared/types'

export interface Driver {
  listTables(): Promise<TableInfo[]>
  describeTable(table: TableRef): Promise<TableDetails>
  /** Every column of every table in one pass (tables come from listTables for row estimates). */
  describeSchema(): Promise<SchemaTable[]>
  /** Distinct non-null values of a column, or null when there are more than `limit`. */
  distinctValues(table: TableRef, column: string, limit: number, via?: ValueLookup): Promise<CellValue[] | null>
  fetchRows(request: RowsRequest): Promise<RowsResult>
  query(sql: string): Promise<QueryResult>
  close(): Promise<void>
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
