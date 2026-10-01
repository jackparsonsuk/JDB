import type { CellValue, RelatedCount, ResultSet } from './types'
import type { EnvSafety } from './environments'
import type { ChangedCell } from './writeDiff'

/**
 * Watching a row: the record explorer reads it again by primary key every few seconds and keeps a
 * timeline of what changed. Changes between two reads collapse into one, so the view says how often
 * it reads.
 */

/** How often a watched row can be read, in seconds. */
export const WATCH_INTERVALS = [1, 2, 5, 10, 30, 60]

/** Shared servers get no faster than this; a primary key read is cheap, but many watchers add up. */
export const SHARED_MIN_INTERVAL = 5

/** Only the newest events are kept. */
export const WATCH_EVENT_LIMIT = 500

/** Related rows read per table; a table with more matching rows than this isn't watched. */
export const CHILD_WATCH_ROWS = 200

/** Related tables watched alongside the row, at most. */
export const CHILD_WATCH_TABLES = 20

/** Reads that fail in a row before the watch stops, so a dropped server isn't retried for ever. */
export const WATCH_MAX_ERRORS = 3

export const watchIntervals = (safety: EnvSafety): number[] =>
  safety === 'relaxed' ? WATCH_INTERVALS : WATCH_INTERVALS.filter((s) => s >= SHARED_MIN_INTERVAL)

export const defaultWatchInterval = (safety: EnvSafety): number => (safety === 'relaxed' ? 2 : 10)

/** A related table being watched, as the timeline names it. */
export interface WatchSource {
  table: string
  /** Its column pointing at the watched row. */
  column: string
  /** The connection's name, when the table is in another database. */
  connection?: string
}

export interface RowValue {
  column: string
  value: CellValue
}

export type WatchEvent =
  | { at: number; kind: 'changed'; cells: ChangedCell[] }
  /** The row is no longer found by its key: deleted, or its key changed. */
  | { at: number; kind: 'gone' }
  /** Found again after being gone, with the values that differ from before it went. */
  | { at: number; kind: 'back'; cells: ChangedCell[] }
  /** A related row appeared, with its values (NULLs left out). */
  | { at: number; kind: 'added'; source: WatchSource; key: CellValue[]; values: RowValue[] }
  /** A related row went, with its last values (NULLs left out). */
  | { at: number; kind: 'removed'; source: WatchSource; key: CellValue[]; values: RowValue[] }
  | { at: number; kind: 'rowChanged'; source: WatchSource; key: CellValue[]; cells: ChangedCell[] }

/** One read of the row: its columns and values, or null when no row has the key. */
export interface WatchRead {
  columns: string[]
  row: CellValue[] | null
}

const same = (a: CellValue, b: CellValue): boolean => a === b || (a !== null && b !== null && String(a) === String(b))

/** The values that differ between two reads, matched by column name in the first read's order. */
export function changedCells(before: WatchRead, after: WatchRead): ChangedCell[] {
  if (!before.row || !after.row) return []
  const afterIndex = new Map(after.columns.map((c, i) => [c.toLowerCase(), i]))
  const cells: ChangedCell[] = []
  before.columns.forEach((column, i) => {
    const j = afterIndex.get(column.toLowerCase())
    if (j === undefined || same(before.row![i], after.row![j])) return
    cells.push({ column, before: before.row![i], after: after.row![j] })
  })
  return cells
}

/**
 * Compares a read with the last row found (`lastSeen`, kept while the row is gone so one that
 * comes back shows what differs). Returns null when nothing changed.
 */
export function compareRead(lastSeen: WatchRead, wasGone: boolean, next: WatchRead, at: number): WatchEvent | null {
  if (!next.row) return wasGone ? null : { at, kind: 'gone' }
  const cells = changedCells(lastSeen, next)
  if (wasGone) return { at, kind: 'back', cells }
  return cells.length ? { at, kind: 'changed', cells } : null
}

/** Adds events to the timeline, newest first, keeping at most WATCH_EVENT_LIMIT. */
export const addEvent = (events: WatchEvent[], ...added: WatchEvent[]): WatchEvent[] => [...added.reverse(), ...events].slice(0, WATCH_EVENT_LIMIT)

/** Why a related table can't be watched, or null when it can. `count` is the explorer's count of its rows. */
export function childWatchProblem(count: RelatedCount | undefined, hasKey: boolean): string | null {
  if (!count) return 'still counting its rows'
  if (count.status === 'skipped') return count.reason
  if (count.status === 'timeout') return 'counting its rows was too slow to read it repeatedly'
  if (count.status === 'error') return count.message
  if (count.capped || count.count > CHILD_WATCH_ROWS) return `more than ${CHILD_WATCH_ROWS} rows`
  if (!hasKey) return "no primary key, so its rows can't be matched up between reads"
  return null
}

const keyIndexesOf = (columns: string[], keys: string[]): number[] | null => {
  const lower = columns.map((c) => c.toLowerCase())
  const found = keys.map((k) => lower.indexOf(k.toLowerCase()))
  return found.includes(-1) ? null : found
}

const valuesOf = (columns: string[], row: CellValue[]): RowValue[] =>
  columns.map((column, i) => ({ column, value: row[i] })).filter((v) => v.value !== null)

/**
 * Compares two reads of a related table's rows, matched by primary key: rows added, removed and
 * changed. Returns an empty list when the key columns are missing from either read.
 */
export function compareRows(before: ResultSet, after: ResultSet, keys: string[], source: WatchSource, at: number): WatchEvent[] {
  const beforeKeys = keyIndexesOf(before.columns, keys)
  const afterKeys = keyIndexesOf(after.columns, keys)
  if (!beforeKeys || !afterKeys) return []
  const keyOf = (row: CellValue[], indexes: number[]): string => JSON.stringify(indexes.map((i) => (row[i] === null ? null : String(row[i]))))
  const beforeBy = new Map(before.rows.map((r) => [keyOf(r, beforeKeys), r]))
  const afterBy = new Map(after.rows.map((r) => [keyOf(r, afterKeys), r]))
  const events: WatchEvent[] = []
  for (const [k, row] of beforeBy) {
    const next = afterBy.get(k)
    const key = beforeKeys.map((i) => row[i])
    if (!next) {
      events.push({ at, kind: 'removed', source, key, values: valuesOf(before.columns, row) })
      continue
    }
    const cells = changedCells({ columns: before.columns, row }, { columns: after.columns, row: next })
    if (cells.length) events.push({ at, kind: 'rowChanged', source, key, cells })
  }
  for (const [k, row] of afterBy) {
    if (!beforeBy.has(k)) events.push({ at, kind: 'added', source, key: afterKeys.map((i) => row[i]), values: valuesOf(after.columns, row) })
  }
  return events
}

const sourceText = (s: WatchSource): string => `${s.connection ? `${s.connection}: ` : ''}${s.table}`

/** What an event says, in a few words: "row changed", "OrderLines 17 added". */
export function eventTitle(e: WatchEvent, value: (v: CellValue) => string): string {
  switch (e.kind) {
    case 'changed': return 'row changed'
    case 'gone': return 'row gone'
    case 'back': return 'row back'
    case 'added': return `${sourceText(e.source)} ${e.key.map(value).join(' · ')} added`
    case 'removed': return `${sourceText(e.source)} ${e.key.map(value).join(' · ')} removed`
    case 'rowChanged': return `${sourceText(e.source)} ${e.key.map(value).join(' · ')} changed`
  }
}

/** The timeline as plain text, oldest first, for copying into a bug report. */
export function watchText(events: WatchEvent[], time: (at: number) => string, value: (v: CellValue) => string): string {
  return [...events].reverse().map((e) => {
    const head = `${time(e.at)}  ${eventTitle(e, value)}`
    const lines = e.kind === 'gone' ? []
      : e.kind === 'added' || e.kind === 'removed' ? e.values.map((v) => `  ${v.column}: ${value(v.value)}`)
      : e.cells.map((c) => `  ${c.column}: ${value(c.before)} -> ${value(c.after)}`)
    return [head, ...lines].join('\n')
  }).join('\n')
}
