import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from './types'
import { findLookup, guessNarrowBy, lookupFromReference, lookupItems, lookupKindsSql, lookupListSql, LOOKUP_LIMIT, LOOKUP_SAMPLE_ROWS, type LookupLink } from './lookups'
import { findWriteKeyword } from './sqlGuard'

const col = (name: string, dataType = 'char(36)', extra: Partial<ColumnInfo> = {}): ColumnInfo =>
  ({ name, dataType, nullable: true, isPrimaryKey: false, isIdentity: false, ...extra })

const link: LookupLink = {
  id: 'l1',
  connectionId: 'c1',
  table: { schema: 'shop', name: 'orders' },
  column: 'OrderStatusId',
  target: { schema: 'shop', name: 'lookups' },
  key: 'Id',
  labels: ['Label'],
  narrowBy: 'TypeId'
}
const types = new Map([['id', 'char(36)'], ['typeid', 'char(36)'], ['label', 'longtext']])

describe('findLookup', () => {
  const orders = { schema: 'shop', name: 'orders' }
  it("prefers the connection's own link, matching names case-insensitively", () => {
    const other = { ...link, id: 'l2', connectionId: 'c2', labels: ['Other'] }
    expect(findLookup([other, link], 'c1', { schema: 'SHOP', name: 'Orders' }, 'orderstatusid', () => true)?.id).toBe('l1')
  })

  it("borrows another connection's link when its target table is here too", () => {
    const found = findLookup([link], 'c9', orders, 'OrderStatusId', () => true)
    expect(found).toMatchObject({ id: 'l1', connectionId: 'c9' })
    expect(findLookup([link], 'c9', orders, 'OrderStatusId', () => false)).toBeUndefined()
  })
})

describe('guessNarrowBy', () => {
  it('finds the column that splits a shared lookup table into kinds', () => {
    expect(guessNarrowBy([col('Id'), col('TypeId'), col('Label', 'longtext')], 'Id')).toBe('TypeId')
    expect(guessNarrowBy([col('id'), col('lookup_type_id')], 'id')).toBe('lookup_type_id')
    expect(guessNarrowBy([col('Id'), col('Name')], 'Id')).toBeUndefined()
  })
})

describe('lookupFromReference', () => {
  it('turns a declared foreign key into a labelled lookup', () => {
    const fk = col('StatusId', 'int', { references: { schema: 'dbo', name: 'Statuses', column: 'Id' } })
    expect(lookupFromReference('c1', { schema: 'dbo', name: 'Jobs' }, fk, [col('Id', 'int', { isPrimaryKey: true }), col('Name', 'nvarchar(50)')]))
      .toMatchObject({ target: { schema: 'dbo', name: 'Statuses' }, key: 'Id', labels: ['Name'], narrowBy: undefined })
  })
})

describe('lookup SQL', () => {
  it('finds the kinds the column uses from a bounded sample', () => {
    expect(lookupKindsSql('mysql', { ...link, narrowBy: 'TypeId' })).toBe(
      `SELECT DISTINCT \`TypeId\` FROM \`shop\`.\`lookups\` WHERE \`Id\` IN (SELECT v FROM (SELECT \`OrderStatusId\` AS v FROM \`shop\`.\`orders\` WHERE \`OrderStatusId\` IS NOT NULL LIMIT ${LOOKUP_SAMPLE_ROWS}) s)`
    )
    expect(lookupKindsSql('mssql', { ...link, narrowBy: 'TypeId' })).toContain(`(SELECT TOP ${LOOKUP_SAMPLE_ROWS} [OrderStatusId] AS v FROM [shop].[orders]`)
  })

  it('lists the rows of those kinds, key first, ordered by label', () => {
    expect(lookupListSql('mysql', link, types, { kinds: ['t1'] })).toBe(
      `SELECT \`Id\`, \`Label\` FROM \`shop\`.\`lookups\` WHERE \`TypeId\` IN ('t1') ORDER BY \`Label\` LIMIT ${LOOKUP_LIMIT + 1}`
    )
    expect(lookupListSql('mssql', link, types, { keys: [5] })).toBe(
      `SELECT TOP ${LOOKUP_LIMIT + 1} [Id], [Label] FROM [shop].[lookups] WHERE [Id] IN (5) ORDER BY [Label]`
    )
    expect(lookupListSql('mysql', link, types, { kinds: [] })).toContain('WHERE 1 = 0')
    expect(lookupListSql('mysql', link, types)).not.toContain('WHERE')
    expect(lookupListSql('mysql', link, types, { search: 'x', unordered: true })).not.toContain('ORDER BY')
  })

  it('searches key and labels, escaping LIKE wildcards and quotes, and never writes', () => {
    const mysql = lookupListSql('mysql', link, types, { search: "50%_o'k\\; delete" })
    expect(mysql).toContain("CAST(`Label` AS char) LIKE '%50\\%\\_o''k; delete%'")
    expect(findWriteKeyword(mysql)).toBeNull()
    expect(lookupListSql('mssql', link, types, { search: 'a[b%' })).toContain("LIKE N'%a[[]b[%]%'")
  })

  it('joins label columns for display', () => {
    expect(lookupItems([['k', 'Draft', null, 'x']])).toEqual([{ key: 'k', label: 'Draft · x' }])
  })
})
