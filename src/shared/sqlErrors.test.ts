import { describe, expect, it } from 'vitest'
import type { ColumnInfo, SchemaTable } from './types'
import { buildModel } from './nl/model'
import { explainError, nearestNames } from './sqlErrors'

const col = (name: string, dataType = 'int'): ColumnInfo => ({ name, dataType, nullable: true, isPrimaryKey: name === 'Id', isIdentity: false })
const SCHEMA: SchemaTable[] = [
  { schema: 'shop', name: 'orders', type: 'table', rowEstimate: 10, columns: [col('Id'), col('OrderNumber'), col('OrderStatusId', 'char(36)')] },
  { schema: 'shop', name: 'customers', type: 'table', rowEstimate: 10, columns: [col('Id'), col('Name', 'varchar(50)')] }
]
const model = buildModel(SCHEMA, 'mysql')
const at = (sql: string, spot?: { from: number; to: number }) => spot && sql.slice(spot.from, spot.to)

describe('nearestNames', () => {
  it('ranks close names first and ignores far ones', () => {
    expect(nearestNames('OrderNumbr', ['OrderNumber', 'OrderStatusId', 'Id'])).toEqual(['OrderNumber'])
    expect(nearestNames('ordrs', ['orders', 'customers'])).toEqual(['orders'])
    expect(nearestNames('xyz', ['orders'])).toEqual([])
  })
})

describe('explainError', () => {
  it('finds an unknown column, qualified or not, and suggests the real one (MySQL)', () => {
    const sql = 'SELECT *\nFROM orders o\nWHERE o.OrderNumbr = 467'
    const help = explainError("Unknown column 'o.OrderNumbr' in 'where clause'", sql, model)
    expect(at(sql, help.spot)).toBe('OrderNumbr')
    expect(help.line).toBe(3)
    expect(help.unknown).toEqual({ kind: 'column', name: 'OrderNumbr', suggestions: ['OrderNumber'] })
  })

  it('reads SQL Server messages, bracketed names and the server line', () => {
    const sql = 'SELECT [OrderNumbr]\nFROM orders\nWHERE [OrderNumbr] > 1'
    const help = explainError("Invalid column name 'OrderNumbr'.", sql, model, 3)
    expect(help.spot).toEqual({ from: sql.lastIndexOf('OrderNumbr'), to: sql.lastIndexOf('OrderNumbr') + 10 })
    expect(help.unknown?.suggestions).toEqual(['OrderNumber'])
  })

  it('suggests tables for an unknown table', () => {
    const sql = 'SELECT * FROM ordrs'
    const mysql = explainError("Table 'shop.ordrs' doesn't exist", sql, model)
    expect(at(sql, mysql.spot)).toBe('ordrs')
    expect(mysql.unknown).toMatchObject({ kind: 'table', suggestions: ['orders'] })
    expect(at(sql, explainError("Invalid object name 'dbo.ordrs'.", sql, model).spot)).toBe('ordrs')
  })

  it('points at the text a syntax error is near', () => {
    const sql = 'SELECT *\nFROM orders\nWHER Id = 1'
    const help = explainError("You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near 'WHER Id = 1' at line 3", sql, model)
    expect(help.line).toBe(3)
    expect(at(sql, help.spot)).toBe('WHER')
    expect(at(sql, explainError("Incorrect syntax near 'Id'.", sql, model, 3).spot)).toBe('Id')
  })

  it('keeps just the line when nothing more is known', () => {
    expect(explainError('Arithmetic overflow error.', 'SELECT 1', model, 1)).toEqual({ line: 1 })
  })
})
