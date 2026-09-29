import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ConnectionConfig, ConnectionInput, CrossLink, HistoryEntry, LinkEnd, SavedSession, ThemeSetting } from '@shared/types'
import { sameDatabase, type ConnectionCollection, type ImportSummary } from '@shared/collection'

interface StoredConnection extends ConnectionConfig {
  /** Password encrypted with the OS keychain (DPAPI on Windows), base64 encoded. */
  encryptedPassword?: string
}

const MAX_HISTORY = 500

function dataFile(name: string): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

function readJson<T>(name: string, fallback: T): T {
  const path = dataFile(name)
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(dataFile(name), JSON.stringify(value, null, 2), 'utf8')
}

/**
 * A fresh install starts with no connections: the installer is shared outside the team, so it
 * mustn't carry any server names. Colleagues add their own or import a shared collection.
 */
function loadStored(): StoredConnection[] {
  return readJson<StoredConnection[]>('connections.json', [])
}

function toPublic({ encryptedPassword, ...config }: StoredConnection): ConnectionConfig {
  return { ...config, hasPassword: Boolean(encryptedPassword) }
}

export function listConnections(): ConnectionConfig[] {
  return loadStored().map(toPublic)
}

export function getConnection(id: string): { config: ConnectionConfig; password?: string } {
  const stored = loadStored().find((c) => c.id === id)
  if (!stored) throw new Error('Connection not found')
  const password = stored.encryptedPassword
    ? safeStorage.decryptString(Buffer.from(stored.encryptedPassword, 'base64'))
    : undefined
  return { config: toPublic(stored), password }
}

export function saveConnection(input: ConnectionInput): ConnectionConfig {
  const all = loadStored()
  const { password, hasPassword: _ignored, ...config } = input
  const id = config.id || randomUUID()
  const existing = all.find((c) => c.id === id)

  let encryptedPassword = existing?.encryptedPassword
  if (password !== undefined) {
    encryptedPassword = password === '' ? undefined : safeStorage.encryptString(password).toString('base64')
  }

  const next: StoredConnection = { ...config, id, encryptedPassword }
  writeJson('connections.json', existing ? all.map((c) => (c.id === id ? next : c)) : [...all, next])
  return toPublic(next)
}

export function deleteConnection(id: string): void {
  writeJson('connections.json', loadStored().filter((c) => c.id !== id))
  writeJson('links.json', listLinks().filter((l) => l.from.connectionId !== id && l.to.connectionId !== id))
}

/** Moves connections into a folder; an empty name takes them out of any folder. */
export function setFolder(ids: string[], folder: string): void {
  const move = new Set(ids)
  const name = folder.trim()
  writeJson('connections.json', loadStored().map((c) => {
    if (!move.has(c.id)) return c
    const { folder: _old, ...rest } = c
    return name ? { ...rest, folder: name } : rest
  }))
}

/**
 * Adds a shared collection's connections and links. Connections already here are matched rather
 * than duplicated; production ones always arrive read-only so a shared file can't enable writes.
 */
export function importCollection(collection: ConnectionCollection): ImportSummary {
  const stored = loadStored()
  const idForRef = new Map<string, string>()
  const summary: ImportSummary = { added: [], existing: [], links: 0, madeReadOnly: [] }
  const added: StoredConnection[] = []
  for (const { ref, ...incoming } of collection.connections) {
    const match = [...stored, ...added].find((c) => sameDatabase(c, incoming))
    if (match) {
      idForRef.set(ref, match.id)
      summary.existing.push(match.name)
      continue
    }
    const readOnly = incoming.readOnly || incoming.env === 'prod'
    if (readOnly && !incoming.readOnly) summary.madeReadOnly.push(incoming.name)
    const connection: StoredConnection = { ...incoming, readOnly, id: randomUUID() }
    added.push(connection)
    idForRef.set(ref, connection.id)
    summary.added.push(connection.name)
  }
  writeJson('connections.json', [...stored, ...added])

  const existingLinks = listLinks()
  const key = (from: LinkEnd, to: LinkEnd): string => JSON.stringify([from.connectionId, from.table, from.column, to.connectionId, to.table, to.column])
  const known = new Set(existingLinks.map((l) => key(l.from, l.to)))
  const newLinks: CrossLink[] = []
  for (const l of collection.links) {
    const from: LinkEnd = { connectionId: idForRef.get(l.from.connection)!, table: l.from.table, column: l.from.column }
    const to: LinkEnd = { connectionId: idForRef.get(l.to.connection)!, table: l.to.table, column: l.to.column }
    if (from.connectionId === to.connectionId || known.has(key(from, to))) continue
    known.add(key(from, to))
    newLinks.push({ id: randomUUID(), from, to, status: l.status, source: l.source })
  }
  if (newLinks.length) saveLinks(newLinks)
  summary.links = newLinks.length
  return summary
}

/** A link within one connection is just a foreign key; never keep one. */
const crossesDatabases = (l: CrossLink): boolean => l.from.connectionId !== l.to.connectionId

export function listLinks(): CrossLink[] {
  return readJson<CrossLink[]>('links.json', []).filter(crossesDatabases)
}

/** Adds or replaces links by id. */
export function saveLinks(links: CrossLink[]): CrossLink[] {
  const incoming = links.filter(crossesDatabases).map((l) => ({ ...l, id: l.id || randomUUID() }))
  const ids = new Set(incoming.map((l) => l.id))
  const next = [...listLinks().filter((l) => !ids.has(l.id)), ...incoming]
  writeJson('links.json', next)
  return next
}

export function deleteLink(id: string): CrossLink[] {
  const next = listLinks().filter((l) => l.id !== id)
  writeJson('links.json', next)
  return next
}

export function listHistory(): HistoryEntry[] {
  return readJson<HistoryEntry[]>('history.json', [])
}

export function addHistory(entry: Omit<HistoryEntry, 'id'>): void {
  const history = [{ ...entry, id: randomUUID() }, ...listHistory()].slice(0, MAX_HISTORY)
  writeJson('history.json', history)
}

/** Returned as stored; the renderer checks it with parseSession, since it may be stale. */
export function loadSession(): unknown {
  return readJson<unknown>('session.json', null)
}

export function saveSession(session: SavedSession): void {
  writeJson('session.json', session)
}

interface Settings {
  theme?: ThemeSetting
}

const THEMES: ReadonlySet<string> = new Set<ThemeSetting>(['system', 'light', 'dark'])

export function getTheme(): ThemeSetting {
  const theme = readJson<Settings>('settings.json', {}).theme
  return theme && THEMES.has(theme) ? theme : 'system'
}

export function setTheme(theme: ThemeSetting): void {
  if (!THEMES.has(theme)) throw new Error(`Unknown theme: ${theme}`)
  writeJson('settings.json', { ...readJson<Settings>('settings.json', {}), theme })
}

const TOKEN_CACHE = 'entra-cache.bin'

/** The Entra token cache (MSAL's serialised JSON), or null if there isn't one or it can't be decrypted. */
export function readTokenCache(): string | null {
  const path = dataFile(TOKEN_CACHE)
  if (!existsSync(path) || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(readFileSync(path))
  } catch {
    return null
  }
}

/** Saves the cache encrypted with the OS keychain; null clears it. Never stored unencrypted. */
export function writeTokenCache(data: string | null): void {
  const path = dataFile(TOKEN_CACHE)
  if (data === null) {
    if (existsSync(path)) rmSync(path)
    return
  }
  if (!safeStorage.isEncryptionAvailable()) return
  writeFileSync(path, safeStorage.encryptString(data))
}
