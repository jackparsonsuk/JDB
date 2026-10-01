import type { CellValue } from './types'
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

/** Reads that fail in a row before the watch stops, so a dropped server isn't retried for ever. */
export const WATCH_MAX_ERRORS = 3

export const watchIntervals = (safety: EnvSafety): number[] =>
  safety === 'relaxed' ? WATCH_INTERVALS : WATCH_INTERVALS.filter((s) => s >= SHARED_MIN_INTERVAL)

export const defaultWatchInterval = (safety: EnvSafety): number => (safety === 'relaxed' ? 2 : 10)

export type WatchEvent =
  | { at: number; kind: 'changed'; cells: ChangedCell[] }
  /** The row is no longer found by its key: deleted, or its key changed. */
  | { at: number; kind: 'gone' }
  /** Found again after being gone, with the values that differ from before it went. */
  | { at: number; kind: 'back'; cells: ChangedCell[] }

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

/** Adds an event to the timeline, newest first, keeping at most WATCH_EVENT_LIMIT. */
export const addEvent = (events: WatchEvent[], event: WatchEvent): WatchEvent[] => [event, ...events].slice(0, WATCH_EVENT_LIMIT)

/** The timeline as plain text, oldest first, for copying into a bug report. */
export function watchText(events: WatchEvent[], time: (at: number) => string, value: (v: CellValue) => string): string {
  return [...events].reverse().map((e) => {
    const head = `${time(e.at)}  ${e.kind === 'changed' ? 'changed' : e.kind === 'gone' ? 'row gone' : 'row back'}`
    const cells = e.kind === 'gone' ? [] : e.cells.map((c) => `  ${c.column}: ${value(c.before)} -> ${value(c.after)}`)
    return [head, ...cells].join('\n')
  }).join('\n')
}
