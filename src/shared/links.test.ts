import { describe, expect, it } from 'vitest'
import type { ColumnInfo, CrossLink, SchemaTable } from './types'
import { buildModel, applyCrossLinks } from './nl/model'
import { translate } from './nl/translate'
import { candidatesBetween, comparableValues, incomingLinks, keyKind, kindsCompatible, outgoingLinks } from './links'

const col = (name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo =>
  ({ name, dataType, nullable: true, isPrimaryKey: false, isIdentity: false, ...extra })
const pk = (dataType: string): ColumnInfo => col('Id', dataType, { isPrimaryKey: true, nullable: false })

// "Finance" (MySQL) references jobs and users that live in "Ops" (SQL Server), and vice versa.
const FINANCE: SchemaTable[] = [
  { schema: 'Finance', name: 'Orders', type: 'table', columns: [pk('char(36)'), col('JobId', 'int'), col('BusinessCMSId', 'int'), col('Notes', 'varchar(200)')] },
  // Same-database table named like the remote one: naming alone would wrongly link Orders.JobId here.
  { schema: 'Finance', name: 'Job', type: 'table', columns: [pk('int'), col('StateName', 'varchar(20)')] },
  { schema: 'Finance', name: 'Users', type: 'table', columns: [pk('varchar(255)'), col('UserName', 'varchar(100)')] }
]
const OPS: SchemaTable[] = [
  { schema: 'dbo', name: 'Job', type: 'table', columns: [pk('int'), col('CreatedByFinanceUserId', 'uniqueidentifier'), col('Reference', 'nvarchar(50)')] },
  { schema: 'dbo', name: 'Business', type: 'table', columns: [pk('int'), col('Name', 'nvarchar(100)')] },
  { schema: 'dbo', name: 'Job_Note', type: 'table', columns: [pk('int'), col('JobId', 'int', { references: { schema: 'dbo', name: 'Job', column: 'Id' } })] }
]

const finance = { connectionId: 'fin', name: 'Finance', model: buildModel(FINANCE, 'mysql') }
const ops = { connectionId: 'ops', name: 'Ops', model: buildModel(OPS, 'mssql') }

describe('keyKind and value filtering', () => {
  it('classifies key types', () => {
    expect(keyKind('int')).toBe('number')
    expect(keyKind('bigint')).toBe('number')
    expect(keyKind('uniqueidentifier')).toBe('guid')
    expect(keyKind('char(36)')).toBe('guid')
    expect(keyKind('nvarchar(50)')).toBe('text')
    expect(keyKind('datetime2')).toBeNull()
  })

  it('pairs numbers with numbers, and text with GUIDs', () => {
    expect(kindsCompatible('number', 'number')).toBe(true)
    expect(kindsCompatible('number', 'guid')).toBe(false)
    expect(kindsCompatible('guid', 'text')).toBe(true)
  })

  it('drops values that would cause a conversion error on the other side', () => {
    expect(comparableValues(['12', 'ABC', 7, null, '12'], 'number')).toEqual(['12', '7'])
    expect(comparableValues(['9f1c2b3a-0000-4000-8000-000000000001', 'nope'], 'guid')).toEqual(['9f1c2b3a-0000-4000-8000-000000000001'])
  })
})

describe('candidatesBetween', () => {
  const describeAll = (list: ReturnType<typeof candidatesBetween>) =>
    list.map((c) => `${c.from.table.name}.${c.from.column} -> ${c.to.table.name}.${c.to.column}`)

  it('finds references by name, including system-tagged ones', () => {
    expect(describeAll(candidatesBetween(finance, ops))).toEqual([
      'Orders.JobId -> Job.Id',
      'Orders.BusinessCMSId -> Business.Id'
    ])
  })

  it('strips audit words and the other connection name', () => {
    expect(describeAll(candidatesBetween(ops, finance))).toEqual(['Job.CreatedByFinanceUserId -> Users.Id'])
  })

  it('skips columns with a declared local foreign key', () => {
    expect(describeAll(candidatesBetween(ops, finance))).not.toContain('Job_Note.JobId -> Job.Id')
  })
})

describe('confirmed links', () => {
  const link: CrossLink = {
    id: 'l1',
    from: { connectionId: 'fin', table: { schema: 'Finance', name: 'Orders' }, column: 'JobId' },
    to: { connectionId: 'ops', table: { schema: 'dbo', name: 'Job' }, column: 'Id' },
    status: 'confirmed',
    source: 'auto'
  }

  it('are found from either end', () => {
    expect(outgoingLinks([link], 'fin', { schema: 'Finance', name: 'Orders' })).toEqual([link])
    expect(incomingLinks([link], 'ops', { schema: 'dbo', name: 'Job' })).toEqual([link])
    expect(outgoingLinks([{ ...link, status: 'dismissed' }], 'fin', { schema: 'Finance', name: 'Orders' })).toEqual([])
  })

  it('override a wrong local inference in the Ask engine', () => {
    // Without the link, naming infers Orders.JobId -> the local Job table.
    expect(buildModel(FINANCE, 'mysql').tables.find((t) => t.info.name === 'Job')!.children).toHaveLength(1)

    const model = applyCrossLinks(buildModel(FINANCE, 'mysql'), 'fin', [link])
    const orders = model.tables.find((t) => t.info.name === 'Orders')!
    expect(orders.columns.find((c) => c.info.name === 'JobId')!.ref).toBeUndefined()
    expect(model.tables.find((t) => t.info.name === 'Job')!.children).toHaveLength(0)
    expect(translate('job with orders', model, new Map()).sql).not.toContain('EXISTS')
  })
})

describe('same-connection guard', () => {
  it('never proposes links within one database', () => {
    expect(candidatesBetween(finance, finance)).toEqual([])
  })
})
