import type { ColumnInfo, ConnectionConfig, ResultSet } from '@shared/types'
import type { Model } from '@shared/nl/model'
import { mentionedTables, resolveMentions } from '@shared/sqlComplete'
import { diffRows, keyIndexes, rowsByKey, updateSnapshot, type RowDiff } from '@shared/writeDiff'

/** What a query tab shows after an UPDATE: the rows it changed, or why they can't be shown. */
export type UpdateChanges = { table: string; diff: RowDiff } | { table?: string; note: string }

/** An UPDATE's rows as they were before it ran, ready to be read again by key afterwards. */
export interface UpdateBefore {
  table: string
  tables: string
  keys: ColumnInfo[]
  rows: ResultSet
}

/** Reads the rows an UPDATE is about to change. Never throws: a failure becomes a note. */
export async function readBefore(conn: ConnectionConfig, model: Model | null, sql: string, transactionId?: string): Promise<UpdateBefore | UpdateChanges> {
  const snapshot = updateSnapshot(sql, conn.kind)
  if ('unsupported' in snapshot) return { note: snapshot.unsupported }
  if (!model) return { note: "The schema hadn't loaded yet, so the changed rows couldn't be matched up." }
  const target = resolveMentions(mentionedTables(sql).slice(0, 1), model)[0]?.table
  if (!target) return { note: "The table wasn't found in the schema, so the changed rows couldn't be matched up." }
  const table = target.info.name
  const keys = target.columns.filter((c) => c.info.isPrimaryKey).map((c) => c.info)
  if (!keys.length) return { table, note: `${table} has no primary key, so the rows can't be matched up before and after.` }
  try {
    const rows = await window.api.snapshotRows(conn.id, snapshot.beforeSql, transactionId)
    if (!keyIndexes(rows.columns, keys)) return { table, note: "The primary key wasn't in the rows read back, so they couldn't be matched up." }
    return { table, tables: snapshot.tables, keys, rows }
  } catch (e) {
    return { table, note: `Couldn't read the rows first: ${(e as Error).message}` }
  }
}

/** Reads the same rows again by primary key and compares them with how they were. */
export async function readAfter(conn: ConnectionConfig, before: UpdateBefore, transactionId?: string): Promise<UpdateChanges> {
  const { table, tables, keys, rows } = before
  const indexes = keyIndexes(rows.columns, keys)!
  const keyValues = rows.rows.map((r) => indexes.map((i) => r[i]))
  try {
    const after = keyValues.length
      ? await window.api.snapshotRows(conn.id, rowsByKey(conn.kind, tables, keys, keyValues), transactionId)
      : { columns: rows.columns, rows: [] }
    const diff = diffRows(rows, after, keys)
    return diff ? { table, diff } : { table, note: "The primary key wasn't in the rows read back, so they couldn't be matched up." }
  } catch (e) {
    return { table, note: `Couldn't read the rows back: ${(e as Error).message}` }
  }
}

export const isBefore = (x: UpdateBefore | UpdateChanges): x is UpdateBefore => 'rows' in x
