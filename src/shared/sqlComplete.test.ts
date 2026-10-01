import { describe, expect, it } from 'vitest'
import type { ColumnInfo, DbKind, SchemaTable } from './types'
import { buildModel } from './nl/model'
import { aliasFor, columnOptions, joinOptions, mentionedTables, resolveMentions, statementAt, statementRanges } from './sqlComplete'

function col(name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, dataType, nullable: true, isPrimaryKey: false, isIdentity: false, ...extra }
}

const pk = (name = 'Id'): ColumnInfo => col(name, 'int', { isPrimaryKey: true, nullable: false })
const fk = (name: string, table: string): ColumnInfo => col(name, 'int', { references: { schema: 'dbo', name: table, column: 'Id' } })

const SCHEMA: SchemaTable[] = [
  { schema: 'dbo', name: 'Customers', type: 'table', rowEstimate: 10, columns: [pk(), col('Name', 'nvarchar(200)')] },
  { schema: 'dbo', name: 'Orders', type: 'table', rowEstimate: 10, columns: [pk(), fk('CustomerId', 'Customers'), col('Name', 'nvarchar(50)')] },
  // No declared key: OrderId -> Orders.Id is inferred from the name.
  { schema: 'dbo', name: 'OrderLines', type: 'table', rowEstimate: 10, columns: [pk(), col('OrderId', 'int'), col('Unit Price', 'money')] },
  { schema: 'sales', name: 'Targets', type: 'table', rowEstimate: 10, columns: [pk(), fk('CustomerId', 'Customers')] }
]

const model = (kind: DbKind = 'mssql') => buildModel(SCHEMA, kind)
const resolve = (sql: string, kind: DbKind = 'mssql') => resolveMentions(mentionedTables(sql), model(kind))

describe('mentionedTables', () => {
  it('reads names, schemas and aliases after FROM and JOIN', () => {
    const found = mentionedTables('SELECT * FROM dbo.Customers c\nJOIN [Orders] AS o ON o.CustomerId = c.Id\nWHERE c.Id = 1')
    expect(found.map((m) => [m.schema, m.name, m.alias])).toEqual([['dbo', 'Customers', 'c'], [undefined, 'Orders', 'o']])
  })

  it('does not take a following keyword as the alias or skip the next join', () => {
    const found = mentionedTables('SELECT * FROM Customers\nJOIN Orders\nON 1 = 1\nLEFT JOIN OrderLines WHERE 1 = 1')
    expect(found.map((m) => [m.name, m.alias])).toEqual([['Customers', undefined], ['Orders', undefined], ['OrderLines', undefined]])
  })

  it('reads comma-separated FROM lists', () => {
    const found = mentionedTables('SELECT * FROM Customers c, Orders o, `OrderLines` WHERE 1 = 1')
    expect(found.map((m) => [m.name, m.alias])).toEqual([['Customers', 'c'], ['Orders', 'o'], ['OrderLines', undefined]])
  })

  it('ignores comments and strings', () => {
    expect(mentionedTables("SELECT 'from Orders' -- join OrderLines\nFROM Customers").map((m) => m.name)).toEqual(['Customers'])
  })
})

describe('statementAt', () => {
  it('limits to the statement around the cursor', () => {
    const sql = 'SELECT * FROM Orders;\nSELECT  FROM Customers;\nSELECT 1'
    const at = sql.indexOf('SELECT  ') + 7
    expect(statementAt(sql, at).text.trim()).toBe('SELECT  FROM Customers')
  })

  it('treats GO lines as boundaries', () => {
    const sql = 'SELECT * FROM Orders\nGO\nSELECT * FROM Customers'
    expect(statementAt(sql, sql.length).text.trim()).toBe('SELECT * FROM Customers')
  })
})

describe('columnOptions', () => {
  it('offers bare columns of the tables used, qualifying names they share', () => {
    const options = columnOptions(resolve('SELECT  FROM Customers c JOIN Orders o ON o.CustomerId = c.Id'), 'mssql')
    expect(options.find((o) => o.label === 'CustomerId')?.apply).toBeUndefined()
    expect(options.filter((o) => o.label === 'Name').map((o) => o.apply)).toEqual(['c.Name', 'o.Name'])
  })

  it('lists a table mentioned twice under the same alias once', () => {
    const options = columnOptions(resolve('SELECT * FROM Customers c WHERE c.Id IN (SELECT c.Id FROM Customers c)'), 'mssql')
    expect(options.filter((o) => o.label === 'Name')).toHaveLength(1)
  })

  it('quotes names that need it for the dialect', () => {
    expect(columnOptions(resolve('SELECT FROM OrderLines'), 'mssql').find((o) => o.label === 'Unit Price')?.apply).toBe('[Unit Price]')
    expect(columnOptions(resolve('SELECT FROM OrderLines', 'mysql'), 'mysql').find((o) => o.label === 'Unit Price')?.apply).toBe('`Unit Price`')
  })
})

describe('joinOptions', () => {
  it('follows keys to parents and children, declared before inferred', () => {
    const labels = joinOptions(model(), resolve('SELECT * FROM Orders o JOIN ')).map((o) => o.label)
    expect(labels).toEqual(['Customers c ON c.Id = o.CustomerId', 'OrderLines ol ON ol.OrderId = o.Id'])
  })

  it('schema-qualifies tables outside the default schema and skips tables already joined', () => {
    const labels = joinOptions(model(), resolve('SELECT * FROM Customers c JOIN Orders o ON o.CustomerId = c.Id JOIN ')).map((o) => o.label)
    expect(labels).toContain('sales.Targets t ON t.CustomerId = c.Id')
    expect(labels.some((l) => l.startsWith('Orders '))).toBe(false)
  })

  it('uses the table name when there is no alias', () => {
    expect(joinOptions(model(), resolve('SELECT * FROM Customers JOIN ')).map((o) => o.label)).toContain('Orders o ON o.CustomerId = Customers.Id')
  })
})

describe('aliasFor', () => {
  it('uses initials and avoids clashes and keywords', () => {
    expect(aliasFor('OrderLines', new Set())).toBe('ol')
    expect(aliasFor('Orders', new Set(['o']))).toBe('o2')
    expect(aliasFor('OrderNotes', new Set())).toBe('ord')
  })
})

describe('statementRanges', () => {
  const texts = (sql: string): string[] => statementRanges(sql).map((r) => sql.slice(r.from, r.to))

  it('splits on semicolons and GO lines, skipping empty ones', () => {
    expect(texts("SELECT 1;\n\n\nSELECT * FROM t WHERE a = 'x;y';\n;\nGO\nSELECT 2")).toEqual([
      'SELECT 1',
      "SELECT * FROM t WHERE a = 'x;y'",
      'SELECT 2'
    ])
  })

  it('leaves out surrounding comments but keeps a closing literal', () => {
    expect(texts("-- totals\nSELECT 'a' -- note\n/* done */")).toEqual(["SELECT 'a'"])
    expect(texts('-- only a comment;\n')).toEqual([])
  })
})
