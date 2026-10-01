import { useEffect, useMemo, useState } from 'react'
import type { CellValue, ConnectionConfig } from '@shared/types'
import { LOOKUP_LIMIT, lookupItems, lookupListSql } from '@shared/lookups'
import type { ColumnLookup } from './lookups'

/** Keys read per query, so the IN list stays a sensible size. */
const BATCH = 200

/** Labels already read, by connection and lookup, then by key (lowercased); null when the key has no row. Kept for the session. */
const cache = new Map<string, Map<string, string | null>>()
/** Keys being read now, by the same key as `cache`, so a grid that re-renders mid-read doesn't ask for them again. */
const reading = new Map<string, Set<string>>()

export const labelKey = (value: CellValue): string => String(value).toLowerCase()

const linkKey = (conn: ConnectionConfig, lookup: ColumnLookup): string => `${conn.id}|${JSON.stringify(lookup.link)}`

/**
 * Labels for the lookup keys showing in a grid, by grid column, then by key (see `labelKey`). Only
 * the keys on screen are read, at most LOOKUP_LIMIT per column, through the bounded read-only path,
 * and each is read once per session. Lookups without label columns are skipped.
 */
export function useLookupLabels(conn: ConnectionConfig | undefined, lookups: Map<string, ColumnLookup>, columns: string[], rows: CellValue[][], enabled: boolean): Map<string, Map<string, string>> {
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!conn || !enabled || !lookups.size) return
    let live = true
    const work = [...lookups].flatMap(([column, lookup]) => {
      const ci = columns.indexOf(column)
      if (ci < 0 || !lookup.link.labels.length) return []
      const id = linkKey(conn, lookup)
      const known = cache.get(id) ?? new Map<string, string | null>()
      cache.set(id, known)
      const busy = reading.get(id) ?? new Set<string>()
      reading.set(id, busy)
      const wanted = new Map<string, CellValue>()
      for (const row of rows) {
        const value = row[ci]
        if (value === null || value === undefined || value === '') continue
        const key = labelKey(value)
        if (!known.has(key) && !busy.has(key) && !wanted.has(key)) wanted.set(key, value)
        if (wanted.size >= LOOKUP_LIMIT) break
      }
      return wanted.size ? [{ lookup, known, busy, keys: [...wanted.values()] }] : []
    })
    if (!work.length) return
    ;(async () => {
      for (const { lookup, known, busy, keys } of work) {
        for (let i = 0; i < keys.length && live; i += BATCH) {
          const batch = keys.slice(i, i + BATCH)
          for (const k of batch) busy.add(labelKey(k))
          try {
            const result = await window.api.snapshotRows(conn.id, lookupListSql(conn.kind, lookup.link, lookup.types, { keys: batch, unordered: true }))
            for (const k of batch) known.set(labelKey(k), null)
            for (const item of lookupItems(result.rows)) if (item.label) known.set(labelKey(item.key), item.label)
          } catch {
            // No labels for this column rather than an error in the grid; the side panel still works.
            for (const k of batch) known.set(labelKey(k), null)
            break
          } finally {
            for (const k of batch) busy.delete(labelKey(k))
          }
          // Even if the grid moved on: a later render may be waiting for these keys.
          setVersion((v) => v + 1)
        }
      }
    })()
    return () => { live = false }
  }, [conn, lookups, columns, rows, enabled])

  return useMemo(() => {
    const out = new Map<string, Map<string, string>>()
    if (!conn || !enabled) return out
    for (const [column, lookup] of lookups) {
      const known = cache.get(linkKey(conn, lookup))
      if (!known) continue
      const labels = new Map<string, string>()
      for (const [key, label] of known) if (label) labels.set(key, label)
      if (labels.size) out.set(column, labels)
    }
    return out
    // `version` changes as labels arrive in the cache.
  }, [conn, lookups, enabled, version])
}
