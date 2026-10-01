import { useCallback, useEffect, useRef, useState } from 'react'
import type { ColumnFilter, ResultSet, TableRef } from '@shared/types'
import { addEvent, CHILD_WATCH_ROWS, compareRead, compareRows, WATCH_MAX_ERRORS, type WatchEvent, type WatchRead, type WatchSource } from '@shared/rowWatch'

/** A related table watched alongside the row: its rows pointing at it. */
export interface WatchChild {
  id: string
  connectionId: string
  table: TableRef
  filter: ColumnFilter
  /** Primary key columns, to match rows up between reads. */
  keys: string[]
  source: WatchSource
  /** Read no more often than this, in seconds; shared servers get a floor. */
  minInterval: number
}

/** How a watched related table is doing: how many rows it had on the last read, or why it stopped. */
export type ChildState = { rows: number } | { error: string } | { tooMany: true }

export interface RowWatch {
  watching: boolean
  events: WatchEvent[]
  /** The row as last found; undefined before the first read. */
  latest?: WatchRead
  /** The last read found no row with the key. */
  gone: boolean
  /** When the row was last read, successfully or not. */
  checkedAt?: number
  error?: string
  /** Each related table's state, by WatchChild id, once read. */
  children: Record<string, ChildState>
  start(): void
  stop(): void
  clear(): void
}

/**
 * Reads a row by its primary key every `intervalSeconds` while watching, and records what changed;
 * `children` are related tables read with it, whose first read is what later ones are compared with.
 * Reads go through fetchRows, which stays out of the query history; the next round starts only once
 * the last has finished. `initial` is the row as the explorer loaded it, the first thing compared.
 */
export function useRowWatch(connectionId: string, table: TableRef, key: ColumnFilter[], initial: WatchRead | null, intervalSeconds: number, children: WatchChild[]): RowWatch {
  const [watching, setWatching] = useState(false)
  const [events, setEvents] = useState<WatchEvent[]>([])
  const [latest, setLatest] = useState<WatchRead>()
  const [isGone, setGone] = useState(false)
  const [checkedAt, setCheckedAt] = useState<number>()
  const [error, setError] = useState<string>()
  const [childStates, setChildStates] = useState<Record<string, ChildState>>({})

  // The last row found and whether it has since gone, kept across interval changes.
  const lastSeen = useRef<WatchRead | null>(null)
  const gone = useRef(false)
  useEffect(() => {
    if (initial?.row && !lastSeen.current) lastSeen.current = initial
  }, [initial])

  // Related tables can arrive while watching (as their counts come in), so they're read from a ref.
  const childrenRef = useRef(children)
  childrenRef.current = children
  const childRows = useRef(new Map<string, ResultSet>())
  const childReadAt = useRef(new Map<string, number>())
  const childDone = useRef(new Set<string>())

  useEffect(() => {
    if (!watching) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0

    const readChildren = async (): Promise<WatchEvent[]> => {
      const found: WatchEvent[] = []
      for (const child of childrenRef.current) {
        if (cancelled) break
        const due = (childReadAt.current.get(child.id) ?? 0) + Math.max(intervalSeconds, child.minInterval) * 1000 - 250
        if (childDone.current.has(child.id) || Date.now() < due) continue
        childReadAt.current.set(child.id, Date.now())
        let state: ChildState
        try {
          const result = await window.api.fetchRows(child.connectionId, { table: child.table, limit: CHILD_WATCH_ROWS + 1, offset: 0, filters: [child.filter], orderBy: child.keys[0] })
          if (cancelled) break
          if (result.rows.length > CHILD_WATCH_ROWS) {
            // Grew past the limit while watching: stop rather than compare a cut-off list.
            childDone.current.add(child.id)
            state = { tooMany: true }
          } else {
            const rows = { columns: result.columns, rows: result.rows }
            const before = childRows.current.get(child.id)
            if (before) found.push(...compareRows(before, rows, child.keys, child.source, Date.now()))
            childRows.current.set(child.id, rows)
            state = { rows: rows.rows.length }
          }
        } catch (e) {
          if (cancelled) break
          state = { error: (e as Error).message }
        }
        setChildStates((s) => ({ ...s, [child.id]: state }))
      }
      return found
    }

    const tick = async (): Promise<void> => {
      try {
        const result = await window.api.fetchRows(connectionId, { table, limit: 1, offset: 0, filters: key })
        if (cancelled) return
        failures = 0
        setError(undefined)
        const next: WatchRead = { columns: result.columns, row: result.rows[0] ?? null }
        const event = lastSeen.current ? compareRead(lastSeen.current, gone.current, next, Date.now()) : null
        if (next.row) {
          lastSeen.current = next
          setLatest(next)
        }
        gone.current = !next.row
        setGone(!next.row)
        const related = await readChildren()
        if (cancelled) return
        const all = [...(event ? [event] : []), ...related]
        if (all.length) setEvents((list) => addEvent(list, ...all))
      } catch (e) {
        if (cancelled) return
        setError((e as Error).message)
        if (++failures >= WATCH_MAX_ERRORS) {
          setWatching(false)
          return
        }
      } finally {
        if (!cancelled) setCheckedAt(Date.now())
      }
      if (!cancelled) timer = setTimeout(tick, intervalSeconds * 1000)
    }
    tick()
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [watching, connectionId, table, key, intervalSeconds])

  const start = useCallback(() => {
    setError(undefined)
    // A table that grew too big gets another chance.
    childDone.current.clear()
    setWatching(true)
  }, [])
  const stop = useCallback(() => setWatching(false), [])
  const clear = useCallback(() => setEvents([]), [])

  return { watching, events, latest, gone: isGone, checkedAt, error, children: childStates, start, stop, clear }
}
