import type { AuthType, ConnectionConfig, CrossLink, DbKind, EnvTag, LinkEnd, SavedQuery } from './types'
import { APP_NAME } from './brand'

/**
 * A shareable file of connections (and the cross-database links between them), like a Postman
 * collection. Passwords are never included: they are encrypted for this Windows user only.
 */
export interface ConnectionCollection {
  format: typeof FORMAT
  version: 1
  exportedAt: string
  connections: CollectionConnection[]
  links: CollectionLink[]
  /** Saved queries; older files have none. */
  queries: CollectionQuery[]
}

/** A saved query without its id or dates; `connection` is the ref of the connection it runs on, if any. */
export interface CollectionQuery {
  name: string
  folder?: string
  sql: string
  description?: string
  connection?: string
}

/** A connection without its id; `ref` ties links to it within the file. */
export type CollectionConnection = Omit<ConnectionConfig, 'id' | 'hasPassword'> & { ref: string }

export interface CollectionLink {
  from: CollectionLinkEnd
  to: CollectionLinkEnd
  status: CrossLink['status']
  source: CrossLink['source']
}

type CollectionLinkEnd = Omit<LinkEnd, 'connectionId'> & { connection: string }

export interface ImportSummary {
  added: string[]
  /** Already here (same server, database and login), so left as they were. */
  existing: string[]
  links: number
  /** Production connections that came in read-only although the file allowed writes. */
  madeReadOnly: string[]
  /** Saved queries added (ones already here with the same name, folder and SQL are skipped). */
  queries: number
}

const FORMAT = 'jdb-connections'
const KINDS: ReadonlySet<string> = new Set<DbKind>(['mssql', 'mysql'])
const AUTH: ReadonlySet<string> = new Set<AuthType>(['sql', 'entra-browser', 'entra-default'])
const ENVS: ReadonlySet<string> = new Set<EnvTag>(['local', 'dev', 'test', 'prod'])

export function buildCollection(connections: ConnectionConfig[], links: CrossLink[], queries: SavedQuery[] = [], now = new Date()): ConnectionCollection {
  const refs = new Map(connections.map((c, i) => [c.id, `c${i + 1}`]))
  const end = (e: LinkEnd): CollectionLinkEnd => ({ connection: refs.get(e.connectionId)!, table: e.table, column: e.column })
  return {
    format: FORMAT,
    version: 1,
    exportedAt: now.toISOString(),
    connections: connections.map(({ id, hasPassword: _hasPassword, ...rest }) => ({ ref: refs.get(id)!, ...rest })),
    // Only links whose both ends are in the file make sense to someone else.
    links: links
      .filter((l) => refs.has(l.from.connectionId) && refs.has(l.to.connectionId))
      .map((l) => ({ from: end(l.from), to: end(l.to), status: l.status, source: l.source })),
    queries: queries.map((q) => ({
      name: q.name,
      ...(q.folder && { folder: q.folder }),
      sql: q.sql,
      ...(q.description && { description: q.description }),
      // A query tied to a connection that isn't in the file travels as one for any connection.
      ...(q.connectionId && refs.has(q.connectionId) && { connection: refs.get(q.connectionId)! })
    }))
  }
}

/** Checks a collection file, keeping only known fields; throws with a readable reason. */
export function parseCollection(raw: unknown): ConnectionCollection {
  if (!isObject(raw) || raw.format !== FORMAT) throw new Error(`This is not an ${APP_NAME} connections file.`)
  if (raw.version !== 1) throw new Error(`This file is from a newer version of ${APP_NAME} (format ${String(raw.version)}).`)
  if (!Array.isArray(raw.connections)) throw new Error('The file has no connections.')
  const connections = raw.connections.map((c, i) => parseConnection(c, i))
  const refs = new Set(connections.map((c) => c.ref))
  if (refs.size !== connections.length) throw new Error('Two connections in the file share a ref.')
  const links = (Array.isArray(raw.links) ? raw.links : []).flatMap((l): CollectionLink[] => {
    const from = parseEnd(isObject(l) ? l.from : null, refs)
    const to = parseEnd(isObject(l) ? l.to : null, refs)
    if (!from || !to || from.connection === to.connection || !isObject(l)) return []
    return [{ from, to, status: l.status === 'dismissed' ? 'dismissed' : 'confirmed', source: l.source === 'auto' ? 'auto' : 'manual' }]
  })
  const queries = (Array.isArray(raw.queries) ? raw.queries : []).flatMap((q): CollectionQuery[] => {
    if (!isObject(q) || typeof q.name !== 'string' || typeof q.sql !== 'string' || !q.name.trim()) return []
    const folder = typeof q.folder === 'string' ? q.folder.trim() : ''
    const description = typeof q.description === 'string' ? q.description.trim() : ''
    const connection = typeof q.connection === 'string' && refs.has(q.connection) ? q.connection : undefined
    return [{ name: q.name.trim(), sql: q.sql, ...(folder && { folder }), ...(description && { description }), ...(connection && { connection }) }]
  })
  return { format: FORMAT, version: 1, exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '', connections, links, queries }
}

function parseConnection(value: unknown, index: number): CollectionConnection {
  const where = `Connection ${index + 1}`
  if (!isObject(value)) throw new Error(`${where} is not an object.`)
  const text = (key: string, required = false): string => {
    const v = value[key]
    if (typeof v === 'string') return v
    if (required || v !== undefined) throw new Error(`${where} has no valid ${key}.`)
    return ''
  }
  const name = text('name', true).trim()
  const host = text('host', true).trim()
  if (!name || !host) throw new Error(`${where} needs a name and host.`)
  const kind = text('kind', true)
  if (!KINDS.has(kind)) throw new Error(`${where} (${name}) has an unknown database type "${kind}".`)
  const authType = value.authType === undefined ? 'sql' : text('authType')
  if (!AUTH.has(authType)) throw new Error(`${where} (${name}) has an unknown sign-in type "${authType}".`)
  const env = value.env === undefined ? 'test' : text('env')
  if (!ENVS.has(env)) throw new Error(`${where} (${name}) has an unknown environment "${env}".`)
  const port = value.port === undefined ? (kind === 'mysql' ? 3306 : 1433) : Number(value.port)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`${where} (${name}) has an invalid port.`)
  const folder = text('folder').trim()
  const tenantId = text('tenantId').trim()
  return {
    ref: value.ref === undefined ? `c${index + 1}` : text('ref'),
    name,
    kind: kind as DbKind,
    host,
    port,
    database: text('database'),
    user: text('user'),
    authType: authType as AuthType,
    env: env as EnvTag,
    // Anything unclear comes in read-only.
    readOnly: value.readOnly !== false,
    ...(tenantId && { tenantId }),
    ...(value.trustServerCertificate === true && { trustServerCertificate: true }),
    ...(folder && { folder })
  }
}

function parseEnd(value: unknown, refs: ReadonlySet<string>): CollectionLinkEnd | null {
  if (!isObject(value) || typeof value.connection !== 'string' || !refs.has(value.connection)) return null
  const table = value.table
  if (!isObject(table) || typeof table.schema !== 'string' || typeof table.name !== 'string' || typeof value.column !== 'string') return null
  return { connection: value.connection, table: { schema: table.schema, name: table.name }, column: value.column }
}

/** Two configs pointing at the same database as the same login count as the same connection. */
export function sameDatabase(a: Pick<ConnectionConfig, 'kind' | 'host' | 'port' | 'database' | 'user' | 'authType'>, b: typeof a): boolean {
  const norm = (s: string): string => s.trim().toLowerCase()
  return a.kind === b.kind && norm(a.host) === norm(b.host) && a.port === b.port && norm(a.database) === norm(b.database)
    && norm(a.user) === norm(b.user) && a.authType === b.authType
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
