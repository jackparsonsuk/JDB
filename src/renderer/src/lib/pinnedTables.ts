import { useCallback, useSyncExternalStore } from 'react'
import type { TableRef } from '@shared/types'

/** Tables pinned to the top of each connection's sidebar list, as "schema.name" by connection id. Kept on this machine only. */
const STORE_KEY = 'jdb.pinnedTables'

type Pins = Record<string, string[]>

function read(): Pins {
  try {
    const value = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}')
    return value && typeof value === 'object' ? (value as Pins) : {}
  } catch {
    return {}
  }
}

let pins: Pins = read()
const listeners = new Set<() => void>()

function write(next: Pins): void {
  pins = next
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next))
  } catch {
    // Still pinned for this session.
  }
  listeners.forEach((l) => l())
}

// Windows share localStorage, so a pin made in another window arrives as a storage event.
window.addEventListener('storage', (event) => {
  if (event.key !== STORE_KEY) return
  pins = read()
  listeners.forEach((l) => l())
})

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const pinKey = (t: TableRef): string => `${t.schema}.${t.name}`.toLowerCase()

/** A connection's pinned tables, in the order they were pinned, and a way to pin or unpin one. */
export function usePinnedTables(connectionId: string): { pinned: string[]; setPinned(table: TableRef, on: boolean): void } {
  const all = useSyncExternalStore(subscribe, () => pins)
  const pinned = all[connectionId] ?? NONE
  const setPinned = useCallback((table: TableRef, on: boolean) => {
    const key = pinKey(table)
    const current = (pins[connectionId] ?? []).filter((k) => k !== key)
    const next = { ...pins, [connectionId]: on ? [...current, key] : current }
    if (!next[connectionId].length) delete next[connectionId]
    write(next)
  }, [connectionId])
  return { pinned, setPinned }
}

const NONE: string[] = []
