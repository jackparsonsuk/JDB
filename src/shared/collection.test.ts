import { describe, expect, it } from 'vitest'
import type { ConnectionConfig, CrossLink } from './types'
import { buildCollection, parseCollection, sameDatabase } from './collection'

const shop: ConnectionConfig = {
  id: 'q', name: 'Shop', kind: 'mysql', host: 'localhost', port: 3306, database: 'Shop', user: 'root',
  authType: 'sql', env: 'local', readOnly: false, hasPassword: true, folder: 'Local'
}
const jobs: ConnectionConfig = {
  id: 'c', name: 'Jobs', kind: 'mssql', host: 'x.database.windows.net', port: 1433, database: 'Jobs', user: '',
  authType: 'entra-browser', env: 'test', readOnly: true
}
const link: CrossLink = {
  id: 'l', status: 'confirmed', source: 'auto',
  from: { connectionId: 'q', table: { schema: 'Shop', name: 'Orders' }, column: 'JobId' },
  to: { connectionId: 'c', table: { schema: 'dbo', name: 'Job' }, column: 'Id' }
}

describe('connection collections', () => {
  it('round-trips connections and the links between them, without ids or passwords', () => {
    const file = buildCollection([shop, jobs], [link], [], [], new Date('2026-09-29T00:00:00Z'))
    const text = JSON.stringify(file)
    expect(text).not.toContain('hasPassword')
    expect(text).not.toContain('"id"')
    const parsed = parseCollection(JSON.parse(text))
    expect(parsed.connections.map((c) => c.name)).toEqual(['Shop', 'Jobs'])
    expect(parsed.connections[0]).toMatchObject({ folder: 'Local', readOnly: false })
    expect(parsed.links).toEqual([{ from: { connection: 'c1', table: link.from.table, column: 'JobId' }, to: { connection: 'c2', table: link.to.table, column: 'Id' }, status: 'confirmed', source: 'auto' }])
  })

  it('carries saved queries, tied to connections by ref', () => {
    const at = '2026-09-30T00:00:00Z'
    const queries = [
      { id: '1', name: 'Open jobs', folder: 'Daily', sql: 'SELECT * FROM Job WHERE Closed = 0', connectionId: 'c', createdAt: at, updatedAt: at },
      { id: '2', name: 'Row count', sql: 'SELECT COUNT(*) FROM x', description: 'any table', createdAt: at, updatedAt: at },
      { id: '3', name: 'Elsewhere', sql: 'SELECT 1', connectionId: 'not-exported', createdAt: at, updatedAt: at }
    ]
    const file = buildCollection([shop, jobs], [], queries)
    expect(JSON.stringify(file.queries)).not.toContain('"id"')
    const parsed = parseCollection(JSON.parse(JSON.stringify(file)))
    expect(parsed.queries).toEqual([
      { name: 'Open jobs', folder: 'Daily', sql: 'SELECT * FROM Job WHERE Closed = 0', connection: 'c2' },
      { name: 'Row count', sql: 'SELECT COUNT(*) FROM x', description: 'any table' },
      { name: 'Elsewhere', sql: 'SELECT 1' }
    ])
  })

  it('carries the custom environments its connections use, and only those', () => {
    const uat = { id: 'uat', name: 'UAT', safety: 'confirm' as const, color: '#a371f7' }
    const demo = { id: 'demo', name: 'Demo', safety: 'relaxed' as const, color: '#1fb8a6' }
    const file = buildCollection([{ ...jobs, env: 'uat' }, shop], [], [], [uat, demo])
    expect(file.environments).toEqual([uat])
    const parsed = parseCollection(JSON.parse(JSON.stringify(file)))
    expect(parsed.environments).toEqual([uat])
    expect(parsed.connections[0].env).toBe('uat')
    expect(() => parseCollection({ format: 'jdb-connections', version: 1, connections: [{ name: 'X', host: 'h', kind: 'mysql', env: 'Bad Env!' }] })).toThrow(/invalid environment/)
  })

  it('reads files without queries, and skips broken ones', () => {
    const base = { format: 'jdb-connections', version: 1, connections: [{ name: 'X', host: 'h', kind: 'mysql', ref: 'c1' }] }
    expect(parseCollection(base).queries).toEqual([])
    expect(parseCollection({ ...base, queries: [{ name: '', sql: 'x' }, { name: 'ok', sql: 'SELECT 1', connection: 'c9' }, 'junk'] }).queries)
      .toEqual([{ name: 'ok', sql: 'SELECT 1' }])
  })

  it('leaves out links to connections that were not exported', () => {
    expect(buildCollection([shop], [link]).links).toEqual([])
  })

  it('rejects other files and bad connections with a reason', () => {
    expect(() => parseCollection({ info: { schema: 'postman' } })).toThrow(/not an OverlookDB connections file/)
    expect(() => parseCollection({ format: 'jdb-connections', version: 2, connections: [] })).toThrow(/newer version/)
    expect(() => parseCollection({ format: 'jdb-connections', version: 1, connections: [{ name: 'X', host: 'h', kind: 'oracle' }] })).toThrow(/unknown database type/)
  })

  it('fills sensible defaults and treats a missing read-only flag as read-only', () => {
    const parsed = parseCollection({ format: 'jdb-connections', version: 1, connections: [{ name: 'X', host: 'h', kind: 'mssql', password: 'secret' }] })
    expect(parsed.connections[0]).toEqual({ ref: 'c1', name: 'X', kind: 'mssql', host: 'h', port: 1433, database: '', user: '', authType: 'sql', env: 'test', readOnly: true })
  })

  it('matches the same database regardless of case', () => {
    expect(sameDatabase(shop, { ...shop, host: 'LOCALHOST', database: 'shop' })).toBe(true)
    expect(sameDatabase(shop, { ...shop, user: 'other' })).toBe(false)
  })
})
