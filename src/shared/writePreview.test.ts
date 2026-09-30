import { describe, expect, it } from 'vitest'
import { previewWrite } from './writePreview'
import { findWriteKeyword } from './sqlGuard'

const count = (sql: string, kind: 'mssql' | 'mysql' = 'mssql') => {
  const p = previewWrite(sql, kind)
  if ('unsupported' in p) throw new Error(`unsupported: ${p.unsupported}`)
  return p
}

describe('previewWrite', () => {
  it('counts an UPDATE by its WHERE', () => {
    const p = count("UPDATE dbo.Orders SET Status = 2 WHERE CustomerId = 5 AND Status = 'open'")
    expect(p).toEqual({ verb: 'update', target: 'dbo.Orders', countSql: "SELECT COUNT(*) FROM dbo.Orders WHERE CustomerId = 5 AND Status = 'open'", noWhere: false, approximate: false })
  })

  it("uses SQL Server's UPDATE ... FROM, and MySQL's joined UPDATE", () => {
    expect(count('UPDATE o SET o.Total = 0 FROM dbo.Orders o JOIN dbo.Lines l ON l.OrderId = o.Id WHERE l.Qty = 0').countSql)
      .toBe('SELECT COUNT(*) FROM dbo.Orders o JOIN dbo.Lines l ON l.OrderId = o.Id WHERE l.Qty = 0')
    const mysql = count('UPDATE orders o JOIN lines l ON l.order_id = o.id SET o.total = 0 WHERE l.qty = 0', 'mysql')
    expect(mysql.countSql).toBe('SELECT COUNT(*) FROM orders o JOIN lines l ON l.order_id = o.id WHERE l.qty = 0')
    expect(mysql.approximate).toBe(true)
  })

  it('flags a missing WHERE', () => {
    const p = count('update Orders set Archived = 1')
    expect(p.noWhere).toBe(true)
    expect(p.countSql).toBe('SELECT COUNT(*) FROM Orders')
  })

  it('counts the forms of DELETE', () => {
    expect(count('DELETE FROM dbo.Orders WHERE Id < 10').countSql).toBe('SELECT COUNT(*) FROM dbo.Orders WHERE Id < 10')
    expect(count('DELETE dbo.Orders WHERE Id < 10').countSql).toBe('SELECT COUNT(*) FROM dbo.Orders WHERE Id < 10')
    expect(count('DELETE o FROM dbo.Orders o JOIN dbo.Gone g ON g.Id = o.Id').countSql).toBe('SELECT COUNT(*) FROM dbo.Orders o JOIN dbo.Gone g ON g.Id = o.Id')
    expect(count('DELETE FROM dbo.Orders FROM dbo.Orders o JOIN x ON x.Id = o.Id WHERE x.Bad = 1').countSql).toBe('SELECT COUNT(*) FROM dbo.Orders o JOIN x ON x.Id = o.Id WHERE x.Bad = 1')
    expect(count('delete t1 from t1 join t2 on t2.id = t1.id where t2.x = 1', 'mysql').target).toBe('t1')
  })

  it('counts INSERT ... VALUES rows directly and INSERT ... SELECT by query', () => {
    expect(count("INSERT INTO t (a, b) VALUES (1, 'x'), (2, 'y,z'), (3, concat('a', 'b'))")).toMatchObject({ verb: 'insert', target: 't', rows: 3 })
    expect(count('INSERT INTO log (a) VALUES (1) ON DUPLICATE KEY UPDATE a = a + 1', 'mysql').rows).toBe(1)
    expect(count('INSERT INTO archive (Id) SELECT Id FROM dbo.Orders WHERE Old = 1').countSql)
      .toBe('SELECT COUNT(*) FROM (SELECT Id FROM dbo.Orders WHERE Old = 1) AS jdb_rows')
  })

  it('keeps comments and strings out of the way', () => {
    const p = count("-- tidy up\nDELETE FROM t /* old ones */ WHERE note = 'delete; me'")
    // A comment between clauses is left out of the count query; the semicolon in the string isn't a split.
    expect(p.countSql).toBe("SELECT COUNT(*) FROM t WHERE note = 'delete; me'")
  })

  it("explains what it can't count", () => {
    const reason = (sql: string, kind: 'mssql' | 'mysql' = 'mssql') => {
      const p = previewWrite(sql, kind)
      return 'unsupported' in p ? p.unsupported : 'counted'
    }
    expect(reason('UPDATE a SET x = 1; UPDATE b SET y = 2')).toMatch(/several statements/)
    expect(reason('UPDATE a SET x = 1 UPDATE b SET y = 2')).toMatch(/several statements/)
    expect(reason('UPDATE TOP (10) t SET x = 1')).toMatch(/TOP/)
    expect(reason('DELETE FROM t ORDER BY id LIMIT 5', 'mysql')).toMatch(/LIMIT|ORDER/)
    expect(reason('UPDATE t SET x = 1 OUTPUT inserted.x WHERE y = 2')).toMatch(/OUTPUT/)
    expect(reason('MERGE t USING s ON 1 = 1 WHEN MATCHED THEN DELETE;')).toMatch(/MERGE/)
    expect(reason('INSERT INTO t EXEC dbo.GetRows')).toMatch(/procedure/)
    expect(reason('EXEC dbo.Clean')).toMatch(/isn't a row change/)
  })

  it('builds count queries that pass the write guard', () => {
    for (const sql of [
      'UPDATE o SET o.Total = 0 FROM dbo.Orders o JOIN dbo.Lines l ON l.OrderId = o.Id WHERE l.Qty = 0',
      'DELETE FROM dbo.Orders WHERE Id IN (SELECT OrderId FROM dbo.Gone)',
      'INSERT INTO archive (Id) SELECT Id FROM dbo.Orders'
    ]) expect(findWriteKeyword(count(sql).countSql!)).toBeNull()
  })
})
