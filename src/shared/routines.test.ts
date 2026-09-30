import { describe, expect, it } from 'vitest'
import { callTemplate, findInSource, nameAt, routineUses, searchSources, stripLiterals } from './routines'
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
    const { matches: results, total } = searchSources([
      { schema: 'dbo', name: 'A', kind: 'procedure', definition: 'CREATE PROC A AS\n\tSELECT * FROM Orders\nSELECT 1 FROM orders' },
      { schema: 'dbo', name: 'B', kind: 'procedure', definition: 'CREATE PROC B AS SELECT 1 FROM Orders' },
      { schema: 'dbo', name: 'C', kind: 'procedure', definition: null }
    ], 'orders')
    expect(results.map((r) => [r.source.name, r.count, r.line])).toEqual([['A', 2, 2], ['B', 1, 1]])
    expect(total).toBe(2)
    const first = results[0]
    expect(first.snippet.slice(first.start, first.end)).toBe('Orders')
  })

  it('keeps the match visible on long lines', () => {
    const long = `${'x'.repeat(200)} needle ${'y'.repeat(200)}`
    const [hit] = searchSources([{ schema: 's', name: 'n', kind: 'function', definition: long }], 'NEEDLE').matches
    expect(hit.snippet.slice(hit.start, hit.end)).toBe('needle')
    expect(hit.snippet.length).toBeLessThan(100)
  })

  it('limits the matches but counts them all', () => {
    const sources = ['A', 'B', 'C'].map((name) => ({ schema: 'dbo', name, kind: 'procedure' as const, definition: 'SELECT 1' }))
    const result = searchSources(sources, 'select', 2)
    expect(result.matches).toHaveLength(2)
    expect(result.total).toBe(3)
  })
})

describe('findInSource', () => {
  it('ignores case and differences in spacing', () => {
    const text = 'SELECT *\n    FROM   dbo.Orders o'
    const hit = findInSource(text, 'from dbo.orders')!
    expect(text.slice(hit.from, hit.to)).toBe('FROM   dbo.Orders')
  })

  it('treats the search as plain text and reports misses', () => {
    expect(findInSource('a (b) c', '(b)')).toEqual({ from: 2, to: 5 })
    expect(findInSource('abc', 'x.y')).toBeNull()
    expect(findInSource('abc', '   ')).toBeNull()
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

describe('nameAt', () => {
  const at = (sql: string, word: string, kind: 'mssql' | 'mysql' = 'mssql', nth = 0) => {
    let pos = -1
    for (let i = 0; i <= nth; i++) pos = sql.indexOf(word, pos + 1)
    const hit = nameAt(sql, kind, pos + 1, tables, routines, kind === 'mssql' ? ['dbo'] : ['dbo'])
    return hit && { text: sql.slice(hit.from, hit.to), target: hit.target }
  }

  it('opens tables, preferring the default schema, and quoted names', () => {
    expect(at('SELECT * FROM Orders o', 'Orders')).toEqual({ text: 'Orders', target: { kind: 'table', table: { schema: 'dbo', name: 'Orders' } } })
    expect(at('SELECT * FROM [audit].[Orders]', 'Orders')?.target).toEqual({ kind: 'table', table: { schema: 'audit', name: 'Orders' } })
    expect(at('SELECT * FROM audit.Orders', 'audit')).toMatchObject({ text: 'audit.Orders', target: { table: { schema: 'audit' } } })
  })

  it('opens procedures and functions', () => {
    expect(at('EXEC dbo.LogChange @id = 1', 'LogChange')?.target).toEqual({ kind: 'routine', routine: { schema: 'dbo', name: 'LogChange', kind: 'procedure' } })
    expect(at('SELECT dbo.fnTotal(Id) FROM Orders', 'fnTotal')?.target).toMatchObject({ kind: 'routine', routine: { name: 'fnTotal' } })
  })

  it('follows aliases to their table, and alias.column to that column', () => {
    const sql = 'SELECT o.Status, l.Qty FROM Orders o JOIN OrderLines AS l ON l.OrderId = o.Id'
    expect(at(sql, 'o.')).toEqual({ text: 'o', target: { kind: 'table', table: { schema: 'dbo', name: 'Orders' } } })
    expect(at(sql, 'Qty')).toEqual({ text: 'l.Qty', target: { kind: 'table', table: { schema: 'dbo', name: 'OrderLines' }, column: 'Qty' } })
  })

  it('ignores strings, comments, variables and unknown names', () => {
    expect(at("SELECT 'Orders' -- Orders", 'Orders')).toBeNull()
    expect(at("SELECT 'x' -- Orders", 'Orders')).toBeNull()
    expect(at('SELECT @Orders', 'Orders')).toBeNull()
    expect(at('SELECT Nope FROM Orders', 'Nope')).toBeNull()
  })

  it('reads MySQL backticks', () => {
    expect(at('SELECT * FROM `Status`', 'Status', 'mysql')?.target).toMatchObject({ table: { name: 'Status' } })
  })
})
