import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from './types'
import { canHoldGuid, changeSql, columnLiteral, dateKind, isEditableColumn, momentText, newGuid, parseInput } from './edits'

const column = (name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name, dataType, nullable: true, isPrimaryKey: false, isIdentity: false, ...extra
})

const columns = [
  column('Id', 'int', { isPrimaryKey: true, isIdentity: true, nullable: false }),
  column('Name', 'nvarchar(100)'),
  column('Code', 'varchar(10)'),
  column('CreatedAt', 'datetime'),
  column('Active', 'bit')
]
const table = { schema: 'dbo', name: 'Jobs' }

describe('columnLiteral', () => {
  it.each([
    ['mssql', 'nvarchar(50)', "O'Brien", "N'O''Brien'"],
    ['mssql', 'varchar(50)', 'abc', "'abc'"],
    ['mssql', 'int', 42, '42'],
    ['mssql', 'bigint', '9007199254740993', '9007199254740993'],
    ['mssql', 'bit', true, '1'],
    ['mssql', 'datetime', '2024-03-05T10:20:30.000Z', "'2024-03-05T10:20:30.000'"],
    ['mssql', 'datetime', '2024-03-05', "'20240305'"],
    ['mssql', 'datetime2', '2024-03-05 10:20', "'2024-03-05T10:20:00'"],
    ['mssql', 'datetimeoffset', '2024-03-05T10:20:30.000Z', "'2024-03-05T10:20:30.000Z'"],
    ['mysql', 'varchar(50)', 'a\\b\'c', "'a\\\\b''c'"],
    ['mysql', 'int(11) unsigned', '7', '7'],
    ['mysql', 'datetime', '2024-03-05 10:20:30', "'2024-03-05 10:20:30'"]
  ] as const)('%s %s %s -> %s', (kind, type, value, expected) => {
    expect(columnLiteral(kind, type, value)).toBe(expected)
  })

  it('writes NULL', () => {
    expect(columnLiteral('mssql', 'int', null)).toBe('NULL')
  })

  it('quotes a non-numeric string for a numeric column rather than inlining it', () => {
    expect(columnLiteral('mssql', 'int', '1; DROP TABLE x')).toBe("'1; DROP TABLE x'")
  })
})

describe('parseInput', () => {
  it('reads numbers, keeping digits that would lose precision', () => {
    expect(parseInput(column('A', 'int'), ' 12 ')).toEqual({ value: 12 })
    expect(parseInput(column('A', 'bigint'), '9007199254740993')).toEqual({ value: '9007199254740993' })
    expect(parseInput(column('A', 'decimal(10,2)'), 'abc')).toHaveProperty('error')
  })

  it('treats empty input as NULL except in text columns', () => {
    expect(parseInput(column('A', 'int'), '')).toEqual({ value: null })
    expect(parseInput(column('A', 'datetime'), '')).toEqual({ value: null })
    expect(parseInput(column('A', 'nvarchar(10)'), '')).toEqual({ value: '' })
    expect(parseInput(column('A', 'int', { nullable: false }), '')).toHaveProperty('error')
  })

  it('reads bits', () => {
    expect(parseInput(column('A', 'bit'), 'true')).toEqual({ value: true })
    expect(parseInput(column('A', 'bit'), '0')).toEqual({ value: false })
    expect(parseInput(column('A', 'bit'), 'maybe')).toHaveProperty('error')
  })
})

describe('isEditableColumn', () => {
  it('excludes identity, binary and rowversion columns', () => {
    expect(isEditableColumn('mssql', column('A', 'nvarchar(10)'))).toBe(true)
    expect(isEditableColumn('mssql', column('A', 'int', { isIdentity: true }))).toBe(false)
    expect(isEditableColumn('mssql', column('A', 'varbinary(max)'))).toBe(false)
    expect(isEditableColumn('mssql', column('A', 'timestamp'))).toBe(false)
    expect(isEditableColumn('mysql', column('A', 'timestamp'))).toBe(true)
  })
})

describe('changeSql', () => {
  it('updates by primary key', () => {
    expect(changeSql('mssql', table, columns, { kind: 'update', key: { Id: 5 }, set: { Name: 'New', Active: false } }))
      .toBe("UPDATE [dbo].[Jobs] SET [Name] = N'New', [Active] = 0 WHERE [Id] = 5;")
  })

  it('deletes by primary key', () => {
    expect(changeSql('mysql', table, columns, { kind: 'delete', key: { Id: 5 } })).toBe('DELETE FROM `dbo`.`Jobs` WHERE `Id` = 5;')
  })

  it('inserts only the columns that were set, so defaults apply to the rest', () => {
    expect(changeSql('mssql', table, columns, { kind: 'insert', values: { Code: 'A1', CreatedAt: '2024-01-02' } }))
      .toBe("INSERT INTO [dbo].[Jobs] ([Code], [CreatedAt]) VALUES ('A1', '20240102');")
    expect(changeSql('mssql', table, columns, { kind: 'insert', values: {} })).toBe('INSERT INTO [dbo].[Jobs] DEFAULT VALUES;')
    expect(changeSql('mysql', table, columns, { kind: 'insert', values: {} })).toBe('INSERT INTO `dbo`.`Jobs` () VALUES ();')
  })

  it('refuses to match rows without a key', () => {
    expect(() => changeSql('mssql', table, columns, { kind: 'delete', key: {} })).toThrow(/primary key/)
  })
})

describe('GUID and date helpers', () => {
  it('knows which columns can hold a GUID', () => {
    expect(canHoldGuid('uniqueidentifier')).toBe(true)
    expect(canHoldGuid('char(36)')).toBe(true)
    expect(canHoldGuid('nvarchar(max)')).toBe(true)
    expect(canHoldGuid('varchar(20)')).toBe(false)
    expect(canHoldGuid('int')).toBe(false)
  })

  it('writes a moment in the form the column stores', () => {
    const at = new Date(Date.UTC(2026, 8, 29, 7, 5, 3, 42))
    expect(momentText('date', at, true)).toBe('2026-09-29')
    expect(momentText('time(7)', at, true)).toBe('07:05:03')
    expect(momentText('datetime', at, true)).toBe('2026-09-29 07:05:03')
    expect(momentText('datetime2(7)', at, true)).toBe('2026-09-29 07:05:03.042')
    expect(momentText('datetime(6)', at, true)).toBe('2026-09-29 07:05:03.042')
    expect(momentText('datetimeoffset(7)', at, true)).toBe('2026-09-29 07:05:03.042 +00:00')
    expect(dateKind('varchar(10)')).toBeNull()
  })

  it('makes GUIDs in each dialect\'s usual case', () => {
    expect(newGuid('mssql')).toMatch(/^[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}$/)
    expect(newGuid('mysql')).toMatch(/^[0-9a-f]{8}-/)
  })
})
