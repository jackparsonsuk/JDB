import type { CellValue, ColumnInfo, DbKind, TableRef } from './types'
import { columnLiteral } from './edits'
import { qualifiedName, quoteIdent } from './rows'
import { pickDisplayColumn } from './display'

/**
 * Lookups: a column whose values are keys into another table (a status id into `lookups`, say),
 * shown in the table view as that table's rows with their labels. A declared foreign key is a
 * lookup already; others are set up by hand and saved as a LookupLink.
 */
export interface LookupLink {
  id: string
  connectionId: string
  /** The table and column holding the keys. */
  table: TableRef
  column: string
  /** The table the keys point into, its key column and the columns shown as the label. */
  target: TableRef
  key: string
  labels: string[]
  /**
   * A column in the target that splits it into kinds, like TypeId in a shared lookups table.
   * The list then shows only the kinds the column's own values belong to.
   */
  narrowBy?: string
}

/** Values listed at most; beyond that, searching asks the server. */
export const LOOKUP_LIMIT = 1000
/**
 * Lookup tables bigger than this aren't listed (sorting them by label would scan the lot on a
 * shared server); only searched, unsorted, so the server can stop at the first matches.
 */
export const LOOKUP_LIST_MAX_ROWS = 20_000
/** Rows of the column read to find which kinds it uses; bounded because tables can be big. */
export const LOOKUP_SAMPLE_ROWS = 1000

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
const sameTable = (a: TableRef, b: TableRef): boolean => same(a.schema, b.schema) && same(a.name, b.name)

/**
 * The saved lookup for a column: this connection's own, else one set up for the same table and
 * column on another connection (the same database on another server), if its target table is
 * here too.
 */
export function findLookup(links: LookupLink[], connectionId: string, table: TableRef, column: string, hasTable: (t: TableRef) => boolean): LookupLink | undefined {
  const matching = links.filter((l) => same(l.column, column) && sameTable(l.table, table))
  const own = matching.find((l) => l.connectionId === connectionId)
  if (own) return own
  const borrowed = matching.find((l) => hasTable(l.target))
  return borrowed && { ...borrowed, connectionId }
}

/** A column that sorts a shared lookup table into kinds: TypeId, LookupTypeId, Category, Kind… */
export function guessNarrowBy(columns: ColumnInfo[], key: string): string | undefined {
  const kind = /^(lookup_?)?(type|kind|category|group)(_?id)?$|typeid$|_type_id$/i
  return columns.find((c) => !same(c.name, key) && kind.test(c.name))?.name
}

/** The label a lookup shows by default: the target's most readable column. */
export function defaultLabels(columns: ColumnInfo[], tableName: string): string[] {
  const display = pickDisplayColumn(columns, tableName)
  return display ? [display.name] : []
}

/** A declared foreign key as a lookup, labelled and narrowed by guesses from the target's columns. */
export function lookupFromReference(connectionId: string, table: TableRef, column: ColumnInfo, targetColumns: ColumnInfo[]): LookupLink | undefined {
  const ref = column.references
  if (!ref) return undefined
  return {
    id: '',
    connectionId,
    table,
    column: column.name,
    target: { schema: ref.schema, name: ref.name },
    key: ref.column,
    labels: defaultLabels(targetColumns, ref.name),
    narrowBy: guessNarrowBy(targetColumns, ref.column)
  }
}

const top = (kind: DbKind, n: number, body: string): string =>
  kind === 'mssql' ? `SELECT TOP ${n} ${body}` : `SELECT ${body} LIMIT ${n}`

/**
 * The kinds (narrowBy values) that the column's values belong to, from a bounded sample of the
 * column: one query, run on the column's own connection.
 */
export function lookupKindsSql(kind: DbKind, link: LookupLink & { narrowBy: string }): string {
  const q = (name: string): string => quoteIdent(kind, name)
  const sample = top(kind, LOOKUP_SAMPLE_ROWS, `${q(link.column)} AS v FROM ${qualifiedName(kind, link.table)} WHERE ${q(link.column)} IS NOT NULL`)
  return `SELECT DISTINCT ${q(link.narrowBy)} FROM ${qualifiedName(kind, link.target)} WHERE ${q(link.key)} IN (SELECT v FROM (${sample}) s)`
}

export interface LookupQuery {
  /** Only rows of these kinds (narrowBy values); null for every kind. */
  kinds?: CellValue[] | null
  /** Only these keys, e.g. the current cell's value. */
  keys?: CellValue[]
  /** Text the key or a label must contain. */
  search?: string
  /** Leave out ORDER BY, so the server can stop at the first matches (big tables). */
  unordered?: boolean
}

/**
 * The lookup's rows: key first, then the label columns, in label order, up to LOOKUP_LIMIT + 1 so
 * a cut-off shows. `types` gives the target's column types, so literals match them.
 */
export function lookupListSql(kind: DbKind, link: LookupLink, types: Map<string, string>, query: LookupQuery = {}): string {
  const q = (name: string): string => quoteIdent(kind, name)
  const lit = (column: string, value: CellValue): string => columnLiteral(kind, types.get(column.toLowerCase()) ?? '', value)
  const where: string[] = []
  if (link.narrowBy && query.kinds) {
    where.push(query.kinds.length ? `${q(link.narrowBy)} IN (${query.kinds.map((v) => lit(link.narrowBy!, v)).join(', ')})` : '1 = 0')
  }
  if (query.keys) where.push(query.keys.length ? `${q(link.key)} IN (${query.keys.map((v) => lit(link.key, v)).join(', ')})` : '1 = 0')
  // Backslashes are dropped: MySQL reads them as escapes in literals, and nobody searches a label for one.
  const needle = query.search?.replace(/\\/g, '').trim()
  if (needle) {
    const escaped = needle.replace(/'/g, "''").replace(/[%_[]/g, (m) => (kind === 'mssql' ? `[${m}]` : m === '[' ? m : `\\${m}`))
    const like = `'%${escaped}%'`
    const text = (column: string): string => (kind === 'mssql' ? `CAST(${q(column)} AS nvarchar(max))` : `CAST(${q(column)} AS char)`)
    where.push(`(${[link.key, ...link.labels].map((c) => `${text(c)} LIKE ${kind === 'mssql' ? 'N' : ''}${like}`).join(' OR ')})`)
  }
  const columns = [link.key, ...link.labels.filter((l) => !same(l, link.key))].map(q).join(', ')
  const order = link.labels[0] ?? link.key
  return top(kind, LOOKUP_LIMIT + 1, `${columns} FROM ${qualifiedName(kind, link.target)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${query.unordered ? '' : ` ORDER BY ${q(order)}`}`)
}

export interface LookupItem {
  key: CellValue
  label: string
}

/** Rows from lookupListSql as key and label, the label columns joined with " · ". */
export function lookupItems(rows: CellValue[][]): LookupItem[] {
  return rows.map((r) => ({ key: r[0], label: r.slice(1).filter((v) => v !== null && v !== '').map(String).join(' · ') }))
}
