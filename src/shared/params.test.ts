import { describe, expect, it } from 'vitest'
import type { ColumnInfo, SchemaTable } from './types'
import { buildModel } from './nl/model'
import { bindParams, findParams, paramLiteral, type ParamValue } from './params'

const col = (name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo =>
  ({ name, dataType, nullable: true, isPrimaryKey: false, isIdentity: false, ...extra })

const SCHEMA: SchemaTable[] = [
  { schema: 'dbo', name: 'Orders', type: 'table', rowEstimate: 10, columns: [col('Id', 'int', { isPrimaryKey: true }), col('Ref', 'varchar(20)'), col('Note', 'nvarchar(100)'), col('PlacedOn', 'datetime')] }
]
const model = buildModel(SCHEMA, 'mssql')
const names = (sql: string, kind: 'mssql' | 'mysql' = 'mssql') => findParams(sql, kind, model).map((p) => p.name)
const auto = (text: string): ParamValue => ({ text, mode: 'auto' })

describe('findParams', () => {
  it('finds :name and @name once each, skipping strings, comments, casts and @@ globals', () => {
    expect(names("SELECT * FROM Orders WHERE Id = :id AND Ref = @ref AND Note <> ':nope' -- :no\nAND Id = :ID")).toEqual(['id', 'ref'])
    expect(names('SELECT @@ROWCOUNT, geography::Point(1, 2, 4326), a.b')).toEqual([])
    expect(names("SELECT '12:30', x FROM t WHERE email = 'a@b.com'")).toEqual([])
  })

  it("leaves @name alone in scripts with variables of their own", () => {
    expect(names('DECLARE @id int = 5\nSELECT * FROM Orders WHERE Id = @id AND Ref = :ref')).toEqual(['ref'])
    expect(names('EXEC dbo.GetOrder @id = 5')).toEqual([])
    expect(names('SET @n := 1; SELECT @n, :other', 'mysql')).toEqual(['other'])
    expect(names('SELECT * FROM t WHERE a := 1', 'mysql')).toEqual([])
  })

  it('learns the column each is compared with, and IN lists', () => {
    const [ref, id] = findParams('SELECT * FROM Orders o WHERE o.[Ref] LIKE :ref AND Id IN (:id)', 'mssql', model)
    expect(ref).toMatchObject({ name: 'ref', list: false, column: { name: 'Ref' } })
    expect(id).toMatchObject({ name: 'id', list: true, column: { name: 'Id' } })
  })
})

describe('binding', () => {
  const [id, ref, note, placed] = findParams('SELECT * FROM Orders WHERE Id = :id AND Ref = :ref AND Note = :note AND PlacedOn > :placed', 'mssql', model)

  it('writes values to suit the column', () => {
    expect(paramLiteral('mssql', id, auto('467'))).toBe('467')
    expect(paramLiteral('mssql', ref, auto("O'Brien"))).toBe("'O''Brien'")
    expect(paramLiteral('mssql', note, auto('x'))).toBe("N'x'")
    expect(paramLiteral('mssql', placed, auto('2024-10-01'))).toBe("'20241001'")
    expect(() => paramLiteral('mssql', id, auto('abc'))).toThrow(/number column/)
  })

  it('follows an explicit mode, and splits IN lists', () => {
    expect(paramLiteral('mssql', ref, { text: '', mode: 'null' })).toBe('NULL')
    expect(paramLiteral('mssql', ref, { text: 'GETDATE()', mode: 'sql' })).toBe('GETDATE()')
    const [ids] = findParams('SELECT * FROM Orders WHERE Id IN (:ids)', 'mssql', model)
    expect(paramLiteral('mssql', ids, auto('1, 2,3'))).toBe('1, 2, 3')
    const [free] = findParams('SELECT :x', 'mysql')
    expect(paramLiteral('mysql', free, auto('42'))).toBe('42')
    expect(paramLiteral('mysql', free, auto('a\\b'))).toBe("'a\\\\b'")
  })

  it('replaces every occurrence', () => {
    const sql = 'SELECT * FROM Orders WHERE Id = :id OR Id = :id + 1'
    expect(bindParams(sql, 'mssql', findParams(sql, 'mssql', model), { id: auto('5') })).toBe('SELECT * FROM Orders WHERE Id = 5 OR Id = 5 + 1')
  })
})
