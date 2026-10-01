import type { ColumnInfo, SchemaTable, TableRef } from './types'

/**
 * Finding which tables hold a value (a GUID, an email, an id). Rather than scanning every table,
 * the value's shape picks the columns that could hold it, indexed columns are looked up first, and
 * unindexed ones are only read on small tables. Each lookup is an exact match, capped and
 * time-limited by the explorer's countRelated, so a search costs a few index lookups per column.
 */

/** Unindexed columns on tables bigger than this aren't searched unless asked (the explorer's limit too). */
export const SEARCH_LARGE_TABLE_ROWS = 200_000

/** Columns searched in one go, at most; a schema with more candidates than this says so. */
export const SEARCH_COLUMN_LIMIT = 2000

export type ValueShape =
  | { kind: 'guid'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'email'; value: string }
  | { kind: 'text'; value: string }

const GUID = /^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** What the value looks like, after trimming quotes and braces it was copied with; null when empty. */
export function valueShape(input: string): ValueShape | null {
  let value = input.trim()
  // Pasted from SQL ('...', N'...') or a .NET GUID ({...}).
  const quoted = /^N?'(.*)'$/s.exec(value) ?? /^"(.*)"$/s.exec(value)
  if (quoted) value = quoted[1].trim()
  const braced = /^\{(.*)\}$/.exec(value)
  if (braced && GUID.test(braced[1])) value = braced[1]
  if (!value) return null
  if (GUID.test(value)) return { kind: 'guid', value }
  if (/^-?\d{1,18}$/.test(value)) return { kind: 'number', value }
  if (EMAIL.test(value)) return { kind: 'email', value }
  return { kind: 'text', value }
}

export const SHAPE_LABELS: Record<ValueShape['kind'], string> = {
  guid: 'GUID',
  number: 'number',
  email: 'email address',
  text: 'text'
}

/** Text columns' length; null for (max), text and other large types, which can't be indexed well. */
function textLength(dataType: string): number | 'large' | null {
  const t = dataType.toLowerCase()
  if (/^(tiny|medium|long)?text\b|^ntext\b/.test(t) || /\(max\)/.test(t)) return 'large'
  const m = /^n?(var)?char\((\d+)\)/.exec(t)
  return m ? Number(m[2]) : null
}

const isInteger = (dataType: string): boolean => /^(tiny|small|medium|big)?int\b|^(numeric|decimal)\(\d+,\s*0\)/i.test(dataType)

/** Largest value each integer type holds, so a number too big for a column isn't looked for in it. */
function integerMax(dataType: string): number {
  const t = dataType.toLowerCase()
  const unsigned = /unsigned/.test(t)
  if (t.startsWith('tinyint')) return unsigned ? 255 : 127
  if (t.startsWith('smallint')) return unsigned ? 65535 : 32767
  if (t.startsWith('mediumint')) return unsigned ? 16777215 : 8388607
  if (t.startsWith('int')) return unsigned ? 4294967295 : 2147483647
  return Number.MAX_SAFE_INTEGER
}

/** Names of columns that hold ids: Id, OrderId, CreatedBy, ExternalRef, CustomerGuid. */
const ID_NAME = /(id|guid|uuid|key|ref|by|no|number|code)$/i
const EMAIL_NAME = /mail|login|user|contact|recipient|sender|address|username/i

/**
 * Whether a column could hold the value, and whether its name suggests it does (`likely`). Unlikely
 * columns are only searched when indexed, since reading them costs a scan for little chance of a match.
 */
export function columnFits(column: ColumnInfo, shape: ValueShape): { likely: boolean } | null {
  const t = column.dataType.toLowerCase()
  const len = textLength(t)
  const idLike = column.isPrimaryKey || !!column.references || ID_NAME.test(column.name)
  switch (shape.kind) {
    case 'guid':
      if (/^uniqueidentifier/.test(t)) return { likely: true }
      // char(36) is the usual GUID column; wider text columns only when named like an id.
      if (len === 36 || len === 38) return { likely: true }
      if (typeof len === 'number' && len > 38 && len <= 100) return idLike ? { likely: true } : { likely: false }
      return null
    case 'number': {
      if (!isInteger(t) || Math.abs(Number(shape.value)) > integerMax(t)) return null
      if (/unsigned/.test(t) && shape.value.startsWith('-')) return null
      // Numbers like 3 are everywhere; only id columns are worth asking.
      return idLike ? { likely: true } : null
    }
    case 'email':
    case 'text':
      if (len === null || len === 'large' || len < shape.value.length) return null
      if (shape.kind === 'email') return { likely: EMAIL_NAME.test(column.name) }
      return { likely: idLike }
  }
}

export interface SearchColumn {
  table: TableRef
  column: string
  dataType: string
  rowEstimate?: number
  indexed: boolean
  isPrimaryKey: boolean
}

export interface SearchPlan {
  shape: ValueShape
  /** Columns to look in, indexed ones first, then by table and column name. */
  columns: SearchColumn[]
  /** Unindexed columns on big tables, not searched unless asked. */
  skipped: SearchColumn[]
  /** Columns that fit the type but aren't indexed and aren't named like it, so aren't read at all. */
  unlikely: number
  /** More columns fitted than SEARCH_COLUMN_LIMIT; only the first were kept. */
  truncated: boolean
}

/**
 * The columns a search for `input` reads, from the whole schema and the set of indexed columns
 * (`indexed(table, column)`). Views are left out: they have no indexes of their own and can be slow.
 */
export function searchPlan(input: string, schema: SchemaTable[], indexed: (table: TableRef, column: string) => boolean): SearchPlan | null {
  const shape = valueShape(input)
  if (!shape) return null
  const columns: SearchColumn[] = []
  const skipped: SearchColumn[] = []
  let unlikely = 0
  for (const t of schema) {
    if (t.type !== 'table') continue
    const table = { schema: t.schema, name: t.name }
    for (const c of t.columns) {
      const fit = columnFits(c, shape)
      if (!fit) continue
      const isIndexed = indexed(table, c.name)
      const entry: SearchColumn = { table, column: c.name, dataType: c.dataType, rowEstimate: t.rowEstimate, indexed: isIndexed, isPrimaryKey: c.isPrimaryKey }
      if (isIndexed) columns.push(entry)
      else if (!fit.likely) unlikely++
      else if ((t.rowEstimate ?? 0) > SEARCH_LARGE_TABLE_ROWS) skipped.push(entry)
      else columns.push(entry)
    }
  }
  const byName = (a: SearchColumn, b: SearchColumn): number =>
    a.table.schema.localeCompare(b.table.schema) || a.table.name.localeCompare(b.table.name) || a.column.localeCompare(b.column)
  columns.sort((a, b) => Number(b.indexed) - Number(a.indexed) || byName(a, b))
  skipped.sort(byName)
  return { shape, columns: columns.slice(0, SEARCH_COLUMN_LIMIT), skipped, unlikely, truncated: columns.length > SEARCH_COLUMN_LIMIT }
}
