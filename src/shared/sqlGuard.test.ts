import { describe, expect, it } from 'vitest'
import { findWriteKeyword } from './sqlGuard'

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
