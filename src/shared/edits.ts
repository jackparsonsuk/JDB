import type { CellValue, ColumnInfo, DbKind, TableRef } from './types'
import { qualifiedName, quoteIdent } from './rows'

/** A change made in the table grid, saved as one statement. Keys are the row's primary key values. */
export type TableChange =
  | { kind: 'update'; key: Record<string, CellValue>; set: Record<string, CellValue> }
  | { kind: 'delete'; key: Record<string, CellValue> }
  | { kind: 'insert'; values: Record<string, CellValue> }

const NUMERIC_TYPE = /^((tiny|small|medium|big)?int|integer|decimal|numeric|float|double|real|(small)?money|bit)\b/i
const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/
const MSSQL_UNICODE = /^(n(var)?char|ntext|xml|sysname)\b/i
const MSSQL_DATE = /^(date|datetime|datetime2|smalldatetime|time)\b/i
const STRING_TYPE = /(char|text|xml|sysname|enum|set|json)\b/i

export const isNumericType = (dataType: string): boolean => NUMERIC_TYPE.test(dataType)

/**
 * Whether the grid can edit a column. Binary values are shown as a truncated hex preview, and
 * SQL Server's timestamp is a rowversion the server fills in, so neither can be written back.
 */
export function isEditableColumn(kind: DbKind, column: ColumnInfo): boolean {
  if (column.isIdentity) return false
  if (/binary|blob|^image\b|geometry|geography|hierarchyid/i.test(column.dataType)) return false
  if (kind === 'mssql' && /^(timestamp|rowversion)\b/i.test(column.dataType)) return false
  return true
}

/** Whether a column can hold a GUID: SQL Server's uniqueidentifier, or text wide enough for 36 characters. */
export function canHoldGuid(dataType: string): boolean {
  if (/^uniqueidentifier\b/i.test(dataType)) return true
  const text = /^n?(var)?char\((\d+|max)\)/i.exec(dataType)
  if (text) return text[2].toLowerCase() === 'max' || Number(text[2]) >= 36
  return /^(n?text|tinytext|mediumtext|longtext)\b/i.test(dataType)
}

/** What a date/time column stores, for filling in "now" or "today"; null for other columns. */
export function dateKind(dataType: string): 'date' | 'datetime' | 'time' | null {
  if (/^date\b/i.test(dataType)) return 'date'
  if (/^time\b/i.test(dataType)) return 'time'
  if (/^(datetime|datetime2|smalldatetime|datetimeoffset|timestamp)\b/i.test(dataType)) return 'datetime'
  return null
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/**
 * A moment as text for a date/time cell, in the column's own form. Local time unless `utc`;
 * datetimeoffset keeps the offset so the instant is exact.
 */
export function momentText(dataType: string, at: Date, utc = false): string {
  const part = utc
    ? { y: at.getUTCFullYear(), mo: at.getUTCMonth() + 1, d: at.getUTCDate(), h: at.getUTCHours(), mi: at.getUTCMinutes(), s: at.getUTCSeconds(), ms: at.getUTCMilliseconds() }
    : { y: at.getFullYear(), mo: at.getMonth() + 1, d: at.getDate(), h: at.getHours(), mi: at.getMinutes(), s: at.getSeconds(), ms: at.getMilliseconds() }
  const date = `${part.y}-${pad(part.mo)}-${pad(part.d)}`
  const time = `${pad(part.h)}:${pad(part.mi)}:${pad(part.s)}`
  switch (dateKind(dataType)) {
    case 'date': return date
    case 'time': return time
    default: {
      const text = `${date} ${time}${/^(datetime2|datetimeoffset|datetime\(\d\)|timestamp\(\d\))/i.test(dataType) ? `.${pad(part.ms, 3)}` : ''}`
      if (!/^datetimeoffset/i.test(dataType)) return text
      const offset = utc ? 0 : -at.getTimezoneOffset()
      return `${text} ${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
    }
  }
}

/** A new GUID as SQL Server shows them (upper case), or lower case for MySQL. */
export function newGuid(kind: DbKind): string {
  const guid = crypto.randomUUID()
  return kind === 'mssql' ? guid.toUpperCase() : guid
}

/**
 * Turns what was typed into a cell into a value. Empty input is NULL except for text columns,
 * where it is an empty string (use Set NULL for those).
 */
export function parseInput(column: ColumnInfo, text: string): { value: CellValue } | { error: string } {
  const type = column.dataType
  if (/^bit\b/i.test(type)) {
    const t = text.trim().toLowerCase()
    if (t === '') return column.nullable ? { value: null } : { error: `${column.name} can't be empty` }
    if (['1', 'true', 'yes'].includes(t)) return { value: true }
    if (['0', 'false', 'no'].includes(t)) return { value: false }
    return { error: `${column.name} takes true or false` }
  }
  if (isNumericType(type)) {
    const t = text.trim()
    if (t === '') return column.nullable ? { value: null } : { error: `${column.name} can't be empty` }
    if (!NUMBER.test(t)) return { error: `${column.name} takes a number` }
    // Keep digits as typed when a number would lose precision (bigint, decimal).
    return { value: String(Number(t)) === t ? Number(t) : t }
  }
  if (text === '' && !STRING_TYPE.test(type)) {
    return column.nullable ? { value: null } : { error: `${column.name} can't be empty` }
  }
  return { value: text }
}

/**
 * Writes a value as a literal that suits the column, so SQL Server compares like with like
 * (N'' only for n*char columns) and dates can't be misread under UK date settings.
 */
export function columnLiteral(kind: DbKind, dataType: string, value: CellValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Can't write ${value} as a number`)
    return String(value)
  }
  if (isNumericType(dataType) && NUMBER.test(value)) return value
  if (kind === 'mysql') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
  const text = MSSQL_DATE.test(dataType) ? mssqlDate(value) : value
  return `${MSSQL_UNICODE.test(dataType) ? 'N' : ''}'${text.replace(/'/g, "''")}'`
}

/**
 * Dates as JDB reads them from SQL Server are UTC ISO strings ending in Z, which datetime
 * rejects; typed ones may be YYYY-MM-DD, which datetime can read day-first. Both become forms
 * SQL Server always reads the same way.
 */
function mssqlDate(value: string): string {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (day) return `${day[1]}${day[2]}${day[3]}`
  const moment = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2}(\.\d+)?)?Z?$/.exec(value)
  if (moment) return `${moment[1]}T${moment[2]}${moment[3] ?? ':00'}`
  return value
}

/** The statement that saves one change. Updates and deletes match the whole primary key. */
export function changeSql(kind: DbKind, table: TableRef, columns: ColumnInfo[], change: TableChange): string {
  const byName = new Map(columns.map((c) => [c.name, c]))
  const q = (name: string): string => quoteIdent(kind, name)
  const literal = (name: string, value: CellValue): string => {
    const column = byName.get(name)
    if (!column) throw new Error(`${name} is not a column of ${table.name}`)
    return columnLiteral(kind, column.dataType, value)
  }
  const where = (key: Record<string, CellValue>): string => {
    const parts = Object.entries(key).map(([name, value]) => (value === null ? `${q(name)} IS NULL` : `${q(name)} = ${literal(name, value)}`))
    if (!parts.length) throw new Error(`${table.name} has no primary key, so rows can't be matched safely`)
    return parts.join(' AND ')
  }
  const name = qualifiedName(kind, table)
  switch (change.kind) {
    case 'update': {
      const set = Object.entries(change.set).map(([column, value]) => `${q(column)} = ${literal(column, value)}`)
      return `UPDATE ${name} SET ${set.join(', ')} WHERE ${where(change.key)};`
    }
    case 'delete':
      return `DELETE FROM ${name} WHERE ${where(change.key)};`
    case 'insert': {
      const entries = Object.entries(change.values)
      if (!entries.length) return kind === 'mssql' ? `INSERT INTO ${name} DEFAULT VALUES;` : `INSERT INTO ${name} () VALUES ();`
      return `INSERT INTO ${name} (${entries.map(([c]) => q(c)).join(', ')}) VALUES (${entries.map(([c, v]) => literal(c, v)).join(', ')});`
    }
  }
}
