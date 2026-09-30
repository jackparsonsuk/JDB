import type { CellValue, ColumnInfo, DbKind, ResultSet } from './types'
import { lex } from './sqlLayout'
import { columnLiteral } from './edits'
import { quoteIdent } from './rows'
import { previewWrite, statements, topLevel } from './writePreview'

/**
 * Shows what an UPDATE changed: its rows are read before it runs (`updateSnapshot`), read again
 * by primary key afterwards (`rowsByKey`), and the two compared (`diffRows`). Only a single UPDATE
 * of one table is read, since joins and SQL Server's UPDATE ... FROM can't be re-read by key.
 */

/** Rows read before and after an UPDATE; more are counted but not shown. */
export const DIFF_ROW_LIMIT = 200

export type UpdateSnapshot =
  | {
      /** The table as written between UPDATE and SET, alias included, so the WHERE still reads. */
      tables: string
      /** Reads up to DIFF_ROW_LIMIT + 1 of the rows the UPDATE will change, so a cut-off shows. */
      beforeSql: string
    }
  | { unsupported: string }

export function updateSnapshot(sql: string, kind: DbKind): UpdateSnapshot {
  const preview = previewWrite(sql, kind)
  if ('unsupported' in preview) return preview
  if (preview.verb !== 'update') return { unsupported: 'Only an UPDATE is compared before and after.' }
  const t = statements(lex(sql, kind))[0]
  const set = topLevel(t, ['SET'])[0]
  const where = topLevel(t, ['WHERE']).find((w) => w.at > set.at)
  if (topLevel(t, ['JOIN', 'APPLY']).length || (kind === 'mssql' && topLevel(t, ['FROM']).some((f) => f.at > set.at && (!where || f.at < where.at)))) {
    return { unsupported: "It updates through a join, so the changed rows can't be read back by key." }
  }
  const slice = (from: number, to: number): string => sql.slice(t[from].start, t[to - 1].start + t[to - 1].text.length)
  const tables = slice(1, set.at)
  if (t.slice(1, set.at).some((tok) => tok.type === 'punct' && tok.text === ',')) {
    return { unsupported: "It updates several tables, so the changed rows can't be read back by key." }
  }
  const filter = where ? ` ${slice(where.at, t.length)}` : ''
  const limit = DIFF_ROW_LIMIT + 1
  const beforeSql = kind === 'mssql'
    ? `SELECT TOP ${limit} * FROM ${tables}${filter}`
    : `SELECT * FROM ${tables}${filter} LIMIT ${limit}`
  return { tables, beforeSql }
}

/** Index of each key column in a result's columns, matched case-insensitively; null if one is missing. */
export function keyIndexes(columns: string[], keys: ColumnInfo[]): number[] | null {
  const lower = columns.map((c) => c.toLowerCase())
  const found = keys.map((k) => lower.indexOf(k.name.toLowerCase()))
  return found.includes(-1) ? null : found
}

/** Reads rows back by primary key, from the same table text the UPDATE named. */
export function rowsByKey(kind: DbKind, tables: string, keys: ColumnInfo[], keyValues: CellValue[][]): string {
  const q = (name: string): string => quoteIdent(kind, name)
  const lit = (column: ColumnInfo, value: CellValue): string => columnLiteral(kind, column.dataType, value)
  const where = keys.length === 1
    ? `${q(keys[0].name)} IN (${keyValues.map((v) => lit(keys[0], v[0])).join(', ')})`
    : keyValues.map((v) => `(${keys.map((k, i) => v[i] === null ? `${q(k.name)} IS NULL` : `${q(k.name)} = ${lit(k, v[i])}`).join(' AND ')})`).join(' OR ')
  return `SELECT * FROM ${tables} WHERE ${where}`
}

export interface ChangedCell {
  column: string
  before: CellValue
  after: CellValue
}

export interface ChangedRow {
  /** The row's primary key values, in key column order. */
  key: CellValue[]
  cells: ChangedCell[]
}

export interface RowDiff {
  keyColumns: string[]
  changed: ChangedRow[]
  /** Rows the UPDATE matched whose values came out the same. */
  unchanged: number
  /** Rows read before that couldn't be found by key afterwards (the key itself changed). */
  missing: number
  /** Columns that changed in at least one row, in table order. */
  columns: string[]
  /** More rows matched than were read, so only the first DIFF_ROW_LIMIT are compared. */
  truncated: boolean
}

const same = (a: CellValue, b: CellValue): boolean => a === b || (a !== null && b !== null && String(a) === String(b))

const keyOf = (row: CellValue[], indexes: number[]): string => JSON.stringify(indexes.map((i) => row[i]))

export function diffRows(before: ResultSet, after: ResultSet, keys: ColumnInfo[]): RowDiff | null {
  const beforeKeys = keyIndexes(before.columns, keys)
  const afterKeys = keyIndexes(after.columns, keys)
  if (!beforeKeys || !afterKeys) return null
  const truncated = before.rows.length > DIFF_ROW_LIMIT
  const rows = before.rows.slice(0, DIFF_ROW_LIMIT)
  const afterByKey = new Map(after.rows.map((r) => [keyOf(r, afterKeys), r]))
  const afterIndex = new Map(after.columns.map((c, i) => [c.toLowerCase(), i]))
  const changedColumns = new Set<string>()
  const changed: ChangedRow[] = []
  let unchanged = 0
  let missing = 0
  for (const row of rows) {
    const next = afterByKey.get(keyOf(row, beforeKeys))
    if (!next) {
      missing++
      continue
    }
    const cells: ChangedCell[] = []
    before.columns.forEach((column, i) => {
      const j = afterIndex.get(column.toLowerCase())
      if (j === undefined || same(row[i], next[j])) return
      cells.push({ column, before: row[i], after: next[j] })
      changedColumns.add(column)
    })
    if (cells.length) changed.push({ key: beforeKeys.map((i) => row[i]), cells })
    else unchanged++
  }
  return {
    keyColumns: beforeKeys.map((i) => before.columns[i]),
    changed,
    unchanged,
    missing,
    columns: before.columns.filter((c) => changedColumns.has(c)),
    truncated
  }
}
