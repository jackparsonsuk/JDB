import { describe, expect, it } from 'vitest'
import type { ColumnInfo, CrossLink, SchemaTable } from '../types'
import { attachRemote, buildModel, type Model } from './model'
import { translate } from './translate'
import { keyPredicate, valueList } from './federated'
import { pickDisplayColumn } from '../display'

const col = (name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo =>
  ({ name, dataType, nullable: true, isPrimaryKey: false, isIdentity: false, ...extra })
const pk = (dataType: string): ColumnInfo => col('Id', dataType, { isPrimaryKey: true, nullable: false })

// Finance (MySQL) orders point at Ops (SQL Server) jobs.
const FINANCE: SchemaTable[] = [
  { schema: 'Finance', name: 'Orders', type: 'table', columns: [pk('char(36)'), col('JobId', 'int'), col('Total', 'decimal(10,2)'), col('DeletedOn', 'datetime')] }
]
const OPS: SchemaTable[] = [
  { schema: 'dbo', name: 'Job', type: 'table', columns: [pk('int'), col('ClientCompanyName', 'nvarchar(100)'), col('ClaimReference', 'varchar(30)'), col('Status', 'varchar(20)')] }
]
const link: CrossLink = {
  id: 'l1',
  from: { connectionId: 'fin', table: { schema: 'Finance', name: 'Orders' }, column: 'JobId' },
  to: { connectionId: 'ops', table: { schema: 'dbo', name: 'Job' }, column: 'Id' },
  status: 'confirmed',
  source: 'auto'
}

function models(): { finance: Model; ops: Model } {
  const make = (schema: SchemaTable[], kind: 'mysql' | 'mssql', id: string, name: string): Model => {
    const m = buildModel(schema, kind)
    m.connection = { id, name }
    return m
  }
  const finance = make(FINANCE, 'mysql', 'fin', 'Finance')
  const ops = make(OPS, 'mssql', 'ops', 'Ops')
  attachRemote(finance, 'fin', [link], new Map([['ops', { model: make(OPS, 'mssql', 'ops', 'Ops'), name: 'Ops' }]]))
  attachRemote(ops, 'ops', [link], new Map([['fin', { model: make(FINANCE, 'mysql', 'fin', 'Finance'), name: 'Finance' }]]))
  return { finance, ops }
}

describe('cross-database plans', () => {
  it('stays a single query when nothing remote is involved', () => {
    const r = translate('orders with total over 5', models().finance, new Map())
    expect(r.federated).toBeUndefined()
  })

  it('looks up shown columns from the other database after the main query', () => {
    const r = translate('orders with job', models().finance, new Map())
    expect(r.federated!.steps.map((s) => `${s.connectionName}:${s.role}`)).toEqual(['Finance:main', 'Ops:enrich'])
    const enrich = r.federated!.steps[1]
    expect(enrich.sql).toContain('SELECT j.[Id] AS [__key], j.[ClaimReference] AS [Job.ClaimReference]')
    expect(enrich.sql).toContain('WHERE j.[Id] IN ({{values}})')
    expect(enrich.enrich).toEqual({ sourceColumn: 'JobId', keyType: 'int', addedColumns: ['Job.ClaimReference'] })
  })

  it('turns filters on the other database into a key lookup that runs first', () => {
    const r = translate('orders where job status is closed', models().finance, new Map())
    const [keys, main] = r.federated!.steps
    expect(keys).toMatchObject({ role: 'keys', connectionName: 'Ops' })
    expect(keys.sql).toBe("SELECT DISTINCT TOP 5001 j.[Id]\nFROM [dbo].[Job] j\nWHERE j.[Status] = 'closed'")
    expect(main.sql).toContain('{{keys:1}}')
    expect(main.placeholders).toEqual([{ token: '{{keys:1}}', step: 1, column: 'o.`JobId`', negate: false, columnType: 'int' }])
  })

  it('plans "with"/"without" children that live in the other database', () => {
    const r = translate('jobs without orders', models().ops, new Map())
    const [keys, main] = r.federated!.steps
    expect(keys.sql).toContain('SELECT DISTINCT o.`JobId`')
    expect(keys.sql).toContain('o.`DeletedOn` IS NULL')
    expect(main.placeholders[0]).toMatchObject({ negate: true, column: 'j.[Id]' })
  })

  it('shows the plan as a readable script', () => {
    const r = translate('orders where job status is closed', models().finance, new Map())
    expect(r.sql).toContain('-- Step 1 · Ops: Job rows matching the filter')
    expect(r.sql).toContain('o.`JobId` IN (/* keys from step 1 */)')
  })

  it('explains what it cannot do across databases', () => {
    const r = translate('how many orders by job', models().finance, new Map())
    expect(r.notes.some((n) => n.includes("Grouping by a column in Ops isn't supported"))).toBe(true)
  })

  it('keeps a trailing date phrase on the main table after "with <table>"', () => {
    const withDate: SchemaTable[] = [{ ...OPS[0], columns: [...OPS[0].columns, col('CreatedDate', 'datetime')] }]
    const finance = buildModel([{ ...FINANCE[0], columns: [...FINANCE[0].columns, col('CreatedOn', 'datetime')] }], 'mysql')
    finance.connection = { id: 'fin', name: 'Finance' }
    attachRemote(finance, 'fin', [link], new Map([['ops', { model: buildModel(withDate, 'mssql'), name: 'Ops' }]]))
    const r = translate('orders with job created this year', finance, new Map())
    expect(r.federated!.steps[1].enrich!.addedColumns).toEqual(['Job.ClaimReference'])
    expect(r.federated!.steps[0].sql).toContain('o.`CreatedOn` >=')
  })

  it('marks remote tables in the diagram plan', () => {
    const plan = translate('orders with job', models().finance, new Map()).plan!
    expect(plan.parents[0]).toMatchObject({ name: 'Job', remote: 'Ops', caption: 'in Ops, via JobId' })
  })
})

describe('key lists', () => {
  it('writes literals for the column type and dialect', () => {
    expect(valueList(['1', '2', 'x'], 'int', 'mssql')).toBe('1, 2')
    expect(valueList(["o'brien"], 'nvarchar(50)', 'mssql')).toBe("N'o''brien'")
    expect(valueList(['a'], 'varchar(50)', 'mssql')).toBe("'a'")
    expect(valueList(['a'], 'char(36)', 'mysql')).toBe('')
  })

  it('keeps SQL valid when a step found nothing', () => {
    const p = { token: '{{keys:1}}', step: 1, column: 'o.JobId', negate: false, columnType: 'int' }
    expect(keyPredicate(p, [], 'mysql')).toBe('1 = 0')
    expect(keyPredicate({ ...p, negate: true }, [], 'mysql')).toBe('1 = 1')
    expect(keyPredicate(p, ['7'], 'mysql')).toBe('o.JobId IN (7)')
  })
})

describe('pickDisplayColumn', () => {
  it('prefers a reference over a generic name-like column', () => {
    expect(pickDisplayColumn(OPS[0].columns, 'Job')?.name).toBe('ClaimReference')
    expect(pickDisplayColumn([pk('int'), col('Name', 'varchar(10)'), col('AccountReference', 'varchar(10)')], 'Customer')?.name).toBe('Name')
    expect(pickDisplayColumn([pk('int'), col('CompanyName', 'varchar(10)'), col('OrderReference', 'varchar(10)')], 'Orders')?.name).toBe('OrderReference')
  })
})
