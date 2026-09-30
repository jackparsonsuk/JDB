import { describe, expect, it } from 'vitest'
import { callTemplate, routineUses, searchSources, stripLiterals } from './routines'
import type { RoutineDefinition, RoutineRef, TableRef } from './types'

const tables: TableRef[] = [
  { schema: 'dbo', name: 'Orders' },
  { schema: 'dbo', name: 'OrderLines' },
  { schema: 'dbo', name: 'Status' },
  { schema: 'audit', name: 'Orders' },
  { schema: 'sales', name: 'Customers' }
]
const routines: RoutineRef[] = [
  { schema: 'dbo', name: 'SaveOrder', kind: 'procedure' },
  { schema: 'dbo', name: 'LogChange', kind: 'procedure' },
  { schema: 'dbo', name: 'fnTotal', kind: 'function' }
]
const self: RoutineRef = { schema: 'dbo', name: 'SaveOrder', kind: 'procedure' }

const summary = (sql: string, kind: 'mssql' | 'mysql' = 'mssql', me = self, list = tables) => {
  const uses = routineUses(sql, kind, me, list, routines)
  return {
    tables: uses.tables.map((u) => `${u.table.schema}.${u.table.name}:${u.reads ? 'r' : ''}${u.writes ? 'w' : ''}`),
    calls: uses.calls.map((c) => `${c.schema}.${c.name}`)
  }
}

describe('routineUses', () => {
  it('finds reads, writes and calls', () => {
    const sql = `CREATE PROCEDURE dbo.SaveOrder @Id int AS
      UPDATE [dbo].[Orders] SET Total = dbo.fnTotal(@Id) WHERE Id = @Id
      INSERT INTO audit.Orders (Id) SELECT o.Id FROM Orders o JOIN OrderLines l ON l.OrderId = o.Id
      EXEC dbo.LogChange @Id`
    expect(summary(sql)).toEqual({
      tables: ['audit.Orders:w', 'dbo.Orders:rw', 'dbo.OrderLines:r'],
      calls: ['dbo.fnTotal', 'dbo.LogChange']
    })
  })

  it('ignores names in comments and strings, and columns named like tables', () => {
    const sql = `-- reads dbo.Customers
      /* FROM sales.Customers */
      SELECT Status, 'FROM Orders' FROM dbo.OrderLines`
    expect(summary(sql).tables).toEqual(['dbo.OrderLines:r'])
  })

  it('treats DELETE FROM and MERGE targets as writes', () => {
    const sql = `DELETE FROM dbo.Status WHERE 1 = 0
      MERGE Orders AS t USING OrderLines AS s ON t.Id = s.OrderId WHEN MATCHED THEN DELETE;`
    expect(summary(sql).tables).toEqual(['dbo.Orders:w', 'dbo.Status:w', 'dbo.OrderLines:r'])
  })

  it('does not read a trigger header as a write', () => {
    const trigger: RoutineRef = { schema: 'dbo', name: 'trgOrders', kind: 'trigger' }
    const sql = `CREATE TRIGGER dbo.trgOrders ON dbo.Orders AFTER INSERT, UPDATE AS
      INSERT audit.Orders (Id) SELECT Id FROM inserted`
    expect(summary(sql, 'mssql', trigger).tables).toEqual(['audit.Orders:w'])
  })

  it('handles EXEC with a return value and skips itself', () => {
    expect(summary('EXEC @rc = dbo.LogChange 1; EXEC SaveOrder 2').calls).toEqual(['dbo.LogChange'])
  })

  it('reads MySQL backticks and CALL', () => {
    const mine: TableRef[] = [{ schema: 'shop', name: 'orders' }, { schema: 'shop', name: 'order_lines' }]
    const me: RoutineRef = { schema: 'shop', name: 'archive', kind: 'procedure' }
    const sql = "BEGIN\n  # FROM order_lines\n  UPDATE `orders` SET note = \"FROM order_lines\";\n  REPLACE INTO shop.order_lines SELECT * FROM `shop`.`orders`;\nEND"
    expect(routineUses(sql, 'mysql', me, mine, []).tables.map((u) => `${u.table.name}:${u.reads ? 'r' : ''}${u.writes ? 'w' : ''}`))
      .toEqual(['order_lines:w', 'orders:rw'])
  })
})

describe('stripLiterals', () => {
  it('keeps offsets and newlines', () => {
    const src = "a -- x\nb 'y''z' c"
    const out = stripLiterals(src, 'mssql')
    expect(out.length).toBe(src.length)
    expect(out.split('\n')[1].trim().split(/\s+/)).toEqual(['b', 'c'])
  })
})

describe('searchSources', () => {
  it('counts matches and shows the first line', () => {
    const results = searchSources([
      { schema: 'dbo', name: 'A', kind: 'procedure', definition: 'CREATE PROC A AS\n\tSELECT * FROM Orders\nSELECT 1 FROM orders' },
      { schema: 'dbo', name: 'B', kind: 'procedure', definition: 'CREATE PROC B AS SELECT 1 FROM Orders' },
      { schema: 'dbo', name: 'C', kind: 'procedure', definition: null }
    ], 'orders')
    expect(results.map((r) => [r.source.name, r.count, r.line])).toEqual([['A', 2, 2], ['B', 1, 1]])
    const first = results[0]
    expect(first.snippet.slice(first.start, first.end)).toBe('Orders')
  })

  it('keeps the match visible on long lines', () => {
    const long = `${'x'.repeat(200)} needle ${'y'.repeat(200)}`
    const [hit] = searchSources([{ schema: 's', name: 'n', kind: 'function', definition: long }], 'NEEDLE')
    expect(hit.snippet.slice(hit.start, hit.end)).toBe('needle')
    expect(hit.snippet.length).toBeLessThan(100)
  })
})

describe('callTemplate', () => {
  const def = (patch: Partial<RoutineDefinition>): RoutineDefinition => ({
    routine: { schema: 'dbo', name: 'SaveOrder', kind: 'procedure' },
    definition: null,
    parameters: [],
    ...patch
  })

  it('writes EXEC with outputs declared', () => {
    const sql = callTemplate('mssql', def({
      parameters: [{ name: '@Id', dataType: 'int', mode: 'IN' }, { name: '@Total', dataType: 'money', mode: 'OUT' }]
    }))!
    expect(sql).toContain('DECLARE @Total money')
    expect(sql).toMatch(/EXEC dbo\.SaveOrder\n {2}@Id = NULL,\s+-- int\n {2}@Total = @Total OUTPUT\s+-- money/)
    expect(sql).toContain('SELECT @Total')
  })

  it('selects from table-valued functions and calls MySQL procedures', () => {
    expect(callTemplate('mssql', def({ routine: { schema: 'dbo', name: 'Lines', kind: 'function' }, returns: 'TABLE' })))
      .toBe('SELECT TOP 100 *\nFROM dbo.Lines()')
    expect(callTemplate('mysql', def({ routine: { schema: 'shop', name: 'my proc', kind: 'procedure' }, parameters: [{ name: 'id', dataType: 'int', mode: 'IN' }] })))
      .toBe('CALL shop.`my proc`(\n  NULL /* IN id int */\n)')
  })

  it('has nothing for triggers', () => {
    expect(callTemplate('mssql', def({ routine: { schema: 'dbo', name: 't', kind: 'trigger' } }))).toBeNull()
  })
})
