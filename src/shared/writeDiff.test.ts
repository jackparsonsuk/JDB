import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from './types'
import { DIFF_ROW_LIMIT, diffRows, rowsByKey, updateSnapshot } from './writeDiff'
import { findWriteKeyword } from './sqlGuard'

const col = (name: string, dataType = 'int'): ColumnInfo => ({ name, dataType, nullable: false, isPrimaryKey: true, isIdentity: false })

describe('updateSnapshot', () => {
  it('reads the rows an UPDATE will change, bounded, in each dialect', () => {
    expect(updateSnapshot("UPDATE dbo.Orders SET Status = 2 WHERE CustomerId = 5 AND Status = 'open';", 'mssql'))
      .toEqual({ tables: 'dbo.Orders', beforeSql: `SELECT TOP ${DIFF_ROW_LIMIT + 1} * FROM dbo.Orders WHERE CustomerId = 5 AND Status = 'open'` })
    expect(updateSnapshot('update `orders` o set o.total = 0 where o.id = 3', 'mysql'))
      .toEqual({ tables: '`orders` o', beforeSql: `SELECT * FROM \`orders\` o where o.id = 3 LIMIT ${DIFF_ROW_LIMIT + 1}` })
  })

  it('reads every row when there is no WHERE', () => {
    const s = updateSnapshot('UPDATE t SET a = 1', 'mysql')
    expect(s).toMatchObject({ beforeSql: `SELECT * FROM t LIMIT ${DIFF_ROW_LIMIT + 1}` })
  })

  it('never produces a write', () => {
    const s = updateSnapshot("UPDATE t SET note = 'delete me' WHERE id = 1", 'mysql')
    if ('unsupported' in s) throw new Error(s.unsupported)
    expect(findWriteKeyword(s.beforeSql)).toBeNull()
  })

  it("won't read joined, multi-table or non-UPDATE writes", () => {
    expect(updateSnapshot('UPDATE o SET o.Total = 0 FROM dbo.Orders o JOIN dbo.Lines l ON l.OrderId = o.Id', 'mssql')).toHaveProperty('unsupported')
    expect(updateSnapshot('UPDATE orders o JOIN lines l ON l.order_id = o.id SET o.total = 0', 'mysql')).toHaveProperty('unsupported')
    expect(updateSnapshot('UPDATE a, b SET a.x = b.x WHERE a.id = b.id', 'mysql')).toHaveProperty('unsupported')
    expect(updateSnapshot('DELETE FROM t WHERE id = 1', 'mysql')).toHaveProperty('unsupported')
    expect(updateSnapshot('UPDATE t SET a = 1; UPDATE t SET b = 2', 'mysql')).toHaveProperty('unsupported')
  })
})

describe('rowsByKey', () => {
  it('reads one key with IN and a composite key with ORs, using typed literals', () => {
    expect(rowsByKey('mysql', 't', [col('Id', 'char(36)')], [['a'], ["b'c"]])).toBe("SELECT * FROM t WHERE `Id` IN ('a', 'b''c')")
    expect(rowsByKey('mssql', 'dbo.T x', [col('A'), col('B', 'nvarchar(10)')], [[1, 'x'], [2, null]]))
      .toBe("SELECT * FROM dbo.T x WHERE ([A] = 1 AND [B] = N'x') OR ([A] = 2 AND [B] IS NULL)")
  })
})

describe('diffRows', () => {
  const keys = [col('Id')]
  it('pairs rows by key and lists only what changed', () => {
    const before = { columns: ['Id', 'Name', 'Active'], rows: [[1, 'a', 0], [2, 'b', 1], [3, 'c', 0]] }
    const after = { columns: ['id', 'name', 'active'], rows: [[2, 'b', 1], [1, 'a', 1]] }
    expect(diffRows(before, after, keys)).toEqual({
      keyColumns: ['Id'],
      changed: [{ key: [1], cells: [{ column: 'Active', before: 0, after: 1 }] }],
      unchanged: 1,
      missing: 1,
      columns: ['Active'],
      truncated: false
    })
  })

  it('treats values that print the same as unchanged', () => {
    const d = diffRows({ columns: ['Id', 'N'], rows: [[1, 5]] }, { columns: ['Id', 'N'], rows: [[1, '5']] }, keys)
    expect(d?.unchanged).toBe(1)
  })

  it('says when more rows matched than were read', () => {
    const rows = Array.from({ length: DIFF_ROW_LIMIT + 1 }, (_, i) => [i, 0])
    const d = diffRows({ columns: ['Id', 'X'], rows }, { columns: ['Id', 'X'], rows: rows.map(([id]) => [id, 1]) }, keys)
    expect(d?.truncated).toBe(true)
    expect(d?.changed).toHaveLength(DIFF_ROW_LIMIT)
  })

  it('gives up when the key columns are not in the result', () => {
    expect(diffRows({ columns: ['Name'], rows: [] }, { columns: ['Name'], rows: [] }, keys)).toBeNull()
  })
})
