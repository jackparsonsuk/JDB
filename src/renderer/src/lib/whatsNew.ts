import { useSyncExternalStore } from 'react'
import changelogText from '../../../../CHANGELOG.md?raw'
import { changesSince, parseChangelog, type ChangelogEntry } from '@shared/changelog'
import { toast } from '../components/Toast'

/** CHANGELOG.md, bundled at build time, so an updated app knows its own notes offline. */
export const changelog = parseChangelog(changelogText)

/** The last version this install has run, so a newer one can say what changed. */
const LAST_SEEN_KEY = 'jdb.lastSeenVersion'

let shown: ChangelogEntry[] | null = null
const listeners = new Set<() => void>()

/** Opens the What's new dialog with these entries; no entries opens the whole changelog. */
export function openWhatsNew(entries: ChangelogEntry[] = changelog): void {
  shown = entries
  listeners.forEach((l) => l())
}

export function closeWhatsNew(): void {
  shown = null
  listeners.forEach((l) => l())
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useWhatsNew(): ChangelogEntry[] | null {
  return useSyncExternalStore(subscribe, () => shown)
}

function readLastSeen(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY)
  } catch {
    return null
  }
}

function writeLastSeen(version: string): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, version)
  } catch {
    // Storage unavailable: the notes just show again next time.
  }
}

/**
 * Called once at startup: if this is a newer version than the last one run here, offers its notes.
 * With nothing recorded it's either a fresh install (no connections yet), which gets no toast, or an
 * update from a version before this existed, which gets the current version's notes.
 */
export async function announceUpdate(): Promise<void> {
  const current = __APP_VERSION__
  const lastSeen = readLastSeen()
  if (lastSeen === current) return
  writeLastSeen(current)
  let entries: ChangelogEntry[]
  if (lastSeen) {
    entries = changesSince(changelog, lastSeen, current)
  } else {
    const connections = await window.api.listConnections().catch(() => [])
    entries = connections.length ? changelog.filter((e) => e.version === current) : []
  }
  if (entries.length) toast(`Updated to JDB ${current}`, false, { label: "What's new", run: () => openWhatsNew(entries) })
}
