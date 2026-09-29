import { describe, expect, it } from 'vitest'
import { findImplicitCommit, findTransactionControl, findWriteKeyword } from './sqlGuard'

describe('findWriteKeyword', () => {
  it.each([
    ['SELECT * FROM Jobs', null],
    ['WITH c AS (SELECT 1 AS a) SELECT * FROM c', null],
    ["SELECT 'drop table' FROM Jobs", null],
    ['-- delete everything\nSELECT 1', null],
    ['/* update */ SELECT 1', null],
    ['SELECT * FROM [update]', null],
    ['UPDATE Jobs SET a = 1', 'UPDATE'],
    ['delete from Jobs', 'DELETE'],
    ['EXEC sp_who', 'EXEC'],
    ['SELECT * INTO #copy FROM Jobs', 'SELECT INTO']
  ])('%s -> %s', (sql, expected) => {
    expect(findWriteKeyword(sql)).toBe(expected)
  })

  it('does not let a T-SQL temp table name hide a following write', () => {
    expect(findWriteKeyword('SELECT * FROM #a; DELETE FROM Jobs')).toBe('DELETE')
  })
})

describe('findTransactionControl', () => {
  it.each([
    ['UPDATE Jobs SET a = 1', 'mssql', null],
    ['IF 1 = 1 BEGIN SELECT 1 END', 'mssql', null],
    ["SELECT 'commit' AS c", 'mssql', null],
    ['BEGIN TRAN; UPDATE Jobs SET a = 1', 'mssql', 'BEGIN TRAN'],
    ['commit transaction', 'mssql', 'COMMIT'],
    ['ROLLBACK', 'mysql', 'ROLLBACK'],
    ['START TRANSACTION', 'mysql', 'START TRANSACTION'],
    ['BEGIN;\nUPDATE a SET b = 1', 'mysql', 'BEGIN'],
    ['SET autocommit = 1', 'mysql', 'SET AUTOCOMMIT']
  ] as const)('%s (%s) -> %s', (sql, kind, expected) => {
    expect(findTransactionControl(sql, kind)).toBe(expected)
  })
})

describe('findImplicitCommit', () => {
  it.each([
    ['UPDATE a SET b = 1', null],
    ['CREATE TEMPORARY TABLE t (a INT)', null],
    ['DROP TEMPORARY TABLE t', null],
    ['ALTER TABLE a ADD c INT', 'ALTER'],
    ['truncate table a', 'TRUNCATE'],
    ['LOCK TABLES a WRITE', 'LOCK TABLES']
  ])('%s -> %s', (sql, expected) => {
    expect(findImplicitCommit(sql)).toBe(expected)
  })
})
