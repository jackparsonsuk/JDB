import { describe, expect, it } from 'vitest'
import type { ColumnInfo, SchemaTable } from './types'
import { columnFits, SEARCH_LARGE_TABLE_ROWS, searchPlan, valueShape } from './valueSearch'

const GUID = '0b5a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b'

const col = (name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo =>
  ({ name, dataType, nullable: true, isPrimaryKey: false, isIdentity: false, ...extra })

const table = (name: string, columns: ColumnInfo[], rowEstimate = 100, type: 'table' | 'view' = 'table'): SchemaTable =>
  ({ schema: 'sales', name, type, rowEstimate, columns })

describe('valueShape', () => {
  it('recognises GUIDs, numbers, emails and other text', () => {
    expect(valueShape(` ${GUID} `)).toEqual({ kind: 'guid', value: GUID })
    expect(valueShape('1317')).toEqual({ kind: 'number', value: '1317' })
    expect(valueShape('someone@example.com')).toEqual({ kind: 'email', value: 'someone@example.com' })
    expect(valueShape('ORD-1317')).toEqual({ kind: 'text', value: 'ORD-1317' })
    expect(valueShape('   ')).toBeNull()
  })

  it('drops the quotes and braces a value was copied with', () => {
    expect(valueShape(`'${GUID}'`)).toEqual({ kind: 'guid', value: GUID })
    expect(valueShape(`N'${GUID}'`)).toEqual({ kind: 'guid', value: GUID })
    expect(valueShape(`{${GUID}}`)).toEqual({ kind: 'guid', value: GUID })
    expect(valueShape('"someone@example.com"')).toEqual({ kind: 'email', value: 'someone@example.com' })
  })
})

describe('columnFits', () => {
  const guid = valueShape(GUID)!
  it('looks for GUIDs in GUID-sized columns', () => {
    expect(columnFits(col('Id', 'char(36)'), guid)).toEqual({ likely: true })
    expect(columnFits(col('Id', 'uniqueidentifier'), guid)).toEqual({ likely: true })
    expect(columnFits(col('TenantId', 'varchar(64)'), guid)).toEqual({ likely: true })
    expect(columnFits(col('Description', 'varchar(64)'), guid)).toEqual({ likely: false })
    expect(columnFits(col('Code', 'varchar(20)'), guid)).toBeNull()
    expect(columnFits(col('Notes', 'longtext'), guid)).toBeNull()
    expect(columnFits(col('Total', 'int'), guid)).toBeNull()
  })

  it('only looks for numbers in id columns that can hold them', () => {
    const n = valueShape('1317')!
    expect(columnFits(col('OrderId', 'int'), n)).toEqual({ likely: true })
    expect(columnFits(col('Id', 'bigint', { isPrimaryKey: true }), n)).toEqual({ likely: true })
    expect(columnFits(col('Quantity', 'int'), n)).toBeNull()
    expect(columnFits(col('StatusId', 'tinyint'), n)).toBeNull()
    expect(columnFits(col('OrderId', 'varchar(36)'), n)).toBeNull()
    expect(columnFits(col('OrderId', 'int unsigned'), valueShape('-5')!)).toBeNull()
  })

  it('looks for emails in text columns long enough, likely when named like one', () => {
    const e = valueShape('someone@example.com')!
    expect(columnFits(col('Email', 'varchar(255)'), e)).toEqual({ likely: true })
    expect(columnFits(col('Notes', 'nvarchar(500)'), e)).toEqual({ likely: false })
    expect(columnFits(col('Email', 'varchar(10)'), e)).toBeNull()
    expect(columnFits(col('Email', 'nvarchar(max)'), e)).toBeNull()
  })
})

describe('searchPlan', () => {
  const schema = [
    table('Orders', [col('Id', 'char(36)', { isPrimaryKey: true }), col('CustomerId', 'char(36)'), col('Note', 'varchar(100)')]),
    table('OrderLines', [col('Id', 'char(36)', { isPrimaryKey: true }), col('OrderId', 'char(36)')]),
    table('AuditLog', [col('EntityId', 'char(36)'), col('Detail', 'varchar(100)')], SEARCH_LARGE_TABLE_ROWS + 1),
    table('OrderSummary', [col('OrderId', 'char(36)')], 10, 'view')
  ]
  const indexed = new Set(['Orders.Id', 'Orders.CustomerId', 'OrderLines.Id', 'OrderLines.OrderId'])
  const isIndexed = (t: { name: string }, c: string): boolean => indexed.has(`${t.name}.${c}`)

  it('searches indexed columns first, then small unindexed ones, and skips big unindexed ones', () => {
    const plan = searchPlan(GUID, [...schema, table('Notes', [col('RefId', 'char(36)')])], isIndexed)!
    expect(plan.columns.map((c) => `${c.table.name}.${c.column}`)).toEqual(['OrderLines.Id', 'OrderLines.OrderId', 'Orders.CustomerId', 'Orders.Id', 'Notes.RefId'])
    expect(plan.skipped.map((c) => `${c.table.name}.${c.column}`)).toEqual(['AuditLog.EntityId'])
  })

  it('leaves out views, and unindexed columns not named like the value', () => {
    const plan = searchPlan(GUID, schema, isIndexed)!
    expect(plan.columns.some((c) => c.table.name === 'OrderSummary')).toBe(false)
    // Orders.Note and AuditLog.Detail are varchar(100): wide enough, but not named like an id.
    expect(plan.unlikely).toBe(2)
  })

  it('returns nothing for an empty value', () => {
    expect(searchPlan('  ', schema, isIndexed)).toBeNull()
  })
})
