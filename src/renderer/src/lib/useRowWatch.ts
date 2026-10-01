import { useCallback, useEffect, useRef, useState } from 'react'
import type { ColumnFilter, TableRef } from '@shared/types'
import { addEvent, compareRead, WATCH_MAX_ERRORS, type WatchEvent, type WatchRead } from '@shared/rowWatch'

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
  start(): void
  stop(): void
  clear(): void
}

/**
 * Reads a row by its primary key every `intervalSeconds` while watching, and records what changed.
 * Reads go through fetchRows, which stays out of the query history; the next one starts only once
 * the last has finished. `initial` is the row as the explorer loaded it, the first thing compared.
 */
export function useRowWatch(connectionId: string, table: TableRef, key: ColumnFilter[], initial: WatchRead | null, intervalSeconds: number): RowWatch {
  const [watching, setWatching] = useState(false)
  const [events, setEvents] = useState<WatchEvent[]>([])
  const [latest, setLatest] = useState<WatchRead>()
  const [isGone, setGone] = useState(false)
  const [checkedAt, setCheckedAt] = useState<number>()
  const [error, setError] = useState<string>()

  // The last row found and whether it has since gone, kept across interval changes.
  const lastSeen = useRef<WatchRead | null>(null)
  const gone = useRef(false)
  useEffect(() => {
    if (initial?.row && !lastSeen.current) lastSeen.current = initial
  }, [initial])

  useEffect(() => {
    if (!watching) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    const tick = async (): Promise<void> => {
      try {
        const result = await window.api.fetchRows(connectionId, { table, limit: 1, offset: 0, filters: key })
        if (cancelled) return
        failures = 0
        setError(undefined)
        const next: WatchRead = { columns: result.columns, row: result.rows[0] ?? null }
        const event = lastSeen.current ? compareRead(lastSeen.current, gone.current, next, Date.now()) : null
        if (event) setEvents((list) => addEvent(list, event))
        if (next.row) {
          lastSeen.current = next
          setLatest(next)
        }
        gone.current = !next.row
        setGone(!next.row)
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
    setWatching(true)
  }, [])
  const stop = useCallback(() => setWatching(false), [])
  const clear = useCallback(() => setEvents([]), [])

  return { watching, events, latest, gone: isGone, checkedAt, error, start, stop, clear }
}
