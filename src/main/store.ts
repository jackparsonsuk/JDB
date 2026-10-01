import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ConnectionConfig, ConnectionInput, CrossLink, HistoryEntry, LinkEnd, SavedQuery, SavedQueryInput, SavedSession, ThemeSetting } from '@shared/types'
import { sameDatabase, type ConnectionCollection, type ImportSummary } from '@shared/collection'
import { parseAppearance, type Appearance } from '@shared/appearance'
import { mergeEnvironments, parseEnvironments, safetyOf, type EnvironmentDef } from '@shared/environments'
import type { LookupLink } from '@shared/lookups'

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
  writeJson('lookups.json', listLookups().filter((l) => l.connectionId !== id))
  // Its saved queries stay, as queries for any connection.
  const queries = listQueries()
  if (queries.some((q) => q.connectionId === id)) {
    writeJson('queries.json', queries.map(({ connectionId, ...q }) => (connectionId === id ? q : { ...q, ...(connectionId && { connectionId }) })))
  }
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
  const summary: ImportSummary = { added: [], existing: [], links: 0, madeReadOnly: [], queries: 0, environments: [] }
  // Environments first, so the connections' safety is judged by the merged list. A file can add
  // environments but never loosen one already defined here.
  const merged = mergeEnvironments(listEnvironments(), collection.environments)
  if (merged.added.length) writeJson('environments.json', merged.environments)
  summary.environments = merged.added
  const added: StoredConnection[] = []
  for (const { ref, ...incoming } of collection.connections) {
    const match = [...stored, ...added].find((c) => sameDatabase(c, incoming))
    if (match) {
      idForRef.set(ref, match.id)
      summary.existing.push(match.name)
      continue
    }
    // Protected environments (prod, or any the user marks so) always arrive read-only.
    const readOnly = incoming.readOnly || safetyOf(incoming.env, merged.environments) === 'protected'
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

  // Queries already here with the same name, folder and SQL are skipped.
  const existingQueries = listQueries()
  const queryKey = (q: { name: string; folder?: string; sql: string }): string => JSON.stringify([q.name.trim().toLowerCase(), (q.folder ?? '').trim().toLowerCase(), q.sql.trim()])
  const knownQueries = new Set(existingQueries.map(queryKey))
  const now = new Date().toISOString()
  const newQueries: SavedQuery[] = []
  for (const q of collection.queries) {
    if (knownQueries.has(queryKey(q))) continue
    knownQueries.add(queryKey(q))
    const connectionId = q.connection ? idForRef.get(q.connection) : undefined
    newQueries.push({
      id: randomUUID(),
      name: q.name,
      sql: q.sql,
      ...(q.folder && { folder: q.folder }),
      ...(q.description && { description: q.description }),
      ...(connectionId && { connectionId }),
      createdAt: now,
      updatedAt: now
    })
  }
  if (newQueries.length) writeJson('queries.json', [...existingQueries, ...newQueries])
  summary.queries = newQueries.length
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

/** Lookups set up by hand (declared foreign keys don't need one). */
export function listLookups(): LookupLink[] {
  return readJson<LookupLink[]>('lookups.json', [])
}

/** Adds or replaces a lookup; a column has at most one per connection. */
export function saveLookup(link: LookupLink): LookupLink[] {
  const saved = { ...link, id: link.id || randomUUID() }
  const lower = (s: string): string => s.toLowerCase()
  const sameColumn = (l: LookupLink): boolean => l.connectionId === saved.connectionId && lower(l.column) === lower(saved.column)
    && lower(l.table.schema) === lower(saved.table.schema) && lower(l.table.name) === lower(saved.table.name)
  const next = [...listLookups().filter((l) => l.id !== saved.id && !sameColumn(l)), saved]
  writeJson('lookups.json', next)
  return next
}

export function deleteLookup(id: string): LookupLink[] {
  const next = listLookups().filter((l) => l.id !== id)
  writeJson('lookups.json', next)
  return next
}

/** The user's own environments (the built-ins aren't stored). */
export function listEnvironments(): EnvironmentDef[] {
  return parseEnvironments(readJson<unknown>('environments.json', []))
}

/** Replaces the user's environments; invalid entries are dropped. Returns what was kept. */
export function saveEnvironments(environments: unknown): EnvironmentDef[] {
  const clean = parseEnvironments(environments)
  writeJson('environments.json', clean)
  return clean
}

/** Removes an environment, moving any connections that use it to `moveTo` first. */
export function deleteEnvironment(id: string, moveTo: string): EnvironmentDef[] {
  const stored = loadStored()
  if (stored.some((c) => c.env === id)) {
    writeJson('connections.json', stored.map((c) => (c.env === id ? { ...c, env: moveTo } : c)))
  }
  const next = listEnvironments().filter((e) => e.id !== id)
  writeJson('environments.json', next)
  return next
}

export function listQueries(): SavedQuery[] {
  return readJson<SavedQuery[]>('queries.json', [])
}

/** Adds a query (no id) or replaces the one with its id. */
export function saveQuery(input: SavedQueryInput): SavedQuery {
  const name = input.name.trim()
  if (!name) throw new Error('A saved query needs a name.')
  const all = listQueries()
  const now = new Date().toISOString()
  const existing = input.id ? all.find((q) => q.id === input.id) : undefined
  const folder = input.folder?.trim()
  const description = input.description?.trim()
  const saved: SavedQuery = {
    id: existing?.id ?? randomUUID(),
    name,
    sql: input.sql,
    ...(folder && { folder }),
    ...(description && { description }),
    ...(input.connectionId && { connectionId: input.connectionId }),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  writeJson('queries.json', existing ? all.map((q) => (q.id === saved.id ? saved : q)) : [...all, saved])
  return saved
}

export function deleteQuery(id: string): void {
  writeJson('queries.json', listQueries().filter((q) => q.id !== id))
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
  appearance?: unknown
}

const THEMES: ReadonlySet<string> = new Set<ThemeSetting>(['system', 'light', 'dark', 'dim', 'midnight', 'contrast', 'gruvbox'])

export function getTheme(): ThemeSetting {
  const theme = readJson<Settings>('settings.json', {}).theme
  return theme && THEMES.has(theme) ? theme : 'system'
}

export function setTheme(theme: ThemeSetting): void {
  if (!THEMES.has(theme)) throw new Error(`Unknown theme: ${theme}`)
  writeJson('settings.json', { ...readJson<Settings>('settings.json', {}), theme })
}

export function getAppearance(): Appearance {
  return parseAppearance(readJson<Settings>('settings.json', {}).appearance)
}

/** Saves the appearance, keeping only valid settings; returns what was kept. */
export function setAppearance(appearance: unknown): Appearance {
  const clean = parseAppearance(appearance)
  writeJson('settings.json', { ...readJson<Settings>('settings.json', {}), appearance: clean })
  return clean
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
