import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { ConnectionConfig, ConnectionInput, HistoryEntry } from '@shared/types'

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

/** Starter connections so a fresh install opens with the databases in regular use. */
function defaultConnections(): StoredConnection[] {
  return [
    {
      id: randomUUID(),
      name: 'Shop',
      kind: 'mysql',
      host: 'localhost',
      port: 3306,
      database: 'Shop',
      user: 'root',
      authType: 'sql',
      env: 'local',
      readOnly: false
    },
    {
      id: randomUUID(),
      name: 'TestDB',
      kind: 'mssql',
      host: 'example.database.windows.net',
      port: 1433,
      database: 'TestDB',
      user: '',
      authType: 'sql',
      env: 'test',
      readOnly: true
    }
  ]
}

function loadStored(): StoredConnection[] {
  const path = dataFile('connections.json')
  if (!existsSync(path)) {
    const seeded = defaultConnections()
    writeJson('connections.json', seeded)
    return seeded
  }
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
}

export function listHistory(): HistoryEntry[] {
  return readJson<HistoryEntry[]>('history.json', [])
}

export function addHistory(entry: Omit<HistoryEntry, 'id'>): void {
  const history = [{ ...entry, id: randomUUID() }, ...listHistory()].slice(0, MAX_HISTORY)
  writeJson('history.json', history)
}
