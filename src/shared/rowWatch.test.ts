import { describe, expect, it } from 'vitest'
import { addEvent, changedCells, CHILD_WATCH_ROWS, childWatchProblem, compareRead, compareRows, defaultWatchInterval, WATCH_EVENT_LIMIT, watchIntervals, watchText, type WatchEvent, type WatchRead } from './rowWatch'

const read = (row: WatchRead['row'], columns = ['Id', 'Status', 'Total']): WatchRead => ({ columns, row })

describe('compareRead', () => {
  it('reports nothing when the row is the same', () => {
    expect(compareRead(read([1, 'draft', 10]), false, read([1, 'draft', 10]), 5)).toBeNull()
  })

  it('treats a number and its text as the same value', () => {
    expect(compareRead(read([1, 'draft', 10]), false, read([1, 'draft', '10']), 5)).toBeNull()
  })

  it('lists the changed columns, before and after', () => {
    expect(compareRead(read([1, 'draft', 10]), false, read([1, 'sent', null]), 5)).toEqual({
      at: 5,
      kind: 'changed',
      cells: [{ column: 'Status', before: 'draft', after: 'sent' }, { column: 'Total', before: 10, after: null }]
    })
  })

  it('matches columns by name, whatever their case or order', () => {
    expect(changedCells(read([1, 'draft'], ['Id', 'Status']), read(['sent', 1], ['STATUS', 'id']))).toEqual([{ column: 'Status', before: 'draft', after: 'sent' }])
  })

  it('notices the row going, once', () => {
    expect(compareRead(read([1, 'draft', 10]), false, read(null), 5)).toEqual({ at: 5, kind: 'gone' })
    expect(compareRead(read([1, 'draft', 10]), true, read(null), 6)).toBeNull()
  })

  it('shows what differs when a row comes back', () => {
    expect(compareRead(read([1, 'draft', 10]), true, read([1, 'draft', 12]), 7)).toEqual({
      at: 7,
      kind: 'back',
      cells: [{ column: 'Total', before: 10, after: 12 }]
    })
  })
})

describe('compareRows', () => {
  const source = { table: 'OrderLines', column: 'OrderId' }
  const lines = (...rows: (string | number | null)[][]) => ({ columns: ['Id', 'OrderId', 'Qty', 'Note'], rows })

  it('reports nothing when the rows are the same, in any order', () => {
    expect(compareRows(lines([1, 9, 2, null], [2, 9, 1, 'x']), lines([2, 9, 1, 'x'], [1, 9, '2', null]), ['Id'], source, 5)).toEqual([])
  })

  it('lists rows added, removed and changed, by key', () => {
    const events = compareRows(lines([1, 9, 2, null], [2, 9, 1, 'x']), lines([2, 9, 3, 'x'], [3, 9, 1, null]), ['id'], source, 5)
    expect(events).toEqual([
      { at: 5, kind: 'removed', source, key: [1], values: [{ column: 'Id', value: 1 }, { column: 'OrderId', value: 9 }, { column: 'Qty', value: 2 }] },
      { at: 5, kind: 'rowChanged', source, key: [2], cells: [{ column: 'Qty', before: 1, after: 3 }] },
      { at: 5, kind: 'added', source, key: [3], values: [{ column: 'Id', value: 3 }, { column: 'OrderId', value: 9 }, { column: 'Qty', value: 1 }] }
    ])
  })

  it('matches composite keys, and a number key with its text', () => {
    const a = { columns: ['A', 'B', 'V'], rows: [[1, 'x', 'old']] }
    const b = { columns: ['A', 'B', 'V'], rows: [['1', 'x', 'new']] }
    expect(compareRows(a, b, ['A', 'B'], source, 1)).toEqual([{ at: 1, kind: 'rowChanged', source, key: [1, 'x'], cells: [{ column: 'V', before: 'old', after: 'new' }] }])
  })

  it('gives up without the key columns', () => {
    expect(compareRows(lines([1, 9, 2, null]), lines(), ['Missing'], source, 1)).toEqual([])
  })

  it('names the table and row in the timeline', () => {
    const events: WatchEvent[] = [{ at: 1, kind: 'added', source: { ...source, connection: 'Billing' }, key: [3], values: [{ column: 'Qty', value: 1 }] }]
    expect(watchText(events, (at) => `t${at}`, String)).toBe('t1  Billing: OrderLines 3 added\n  Qty: 1')
  })
})

describe('childWatchProblem', () => {
  it('only watches counted, small tables with a key', () => {
    expect(childWatchProblem({ status: 'ok', count: 3, capped: false }, true)).toBeNull()
    expect(childWatchProblem({ status: 'ok', count: 0, capped: false }, true)).toBeNull()
    expect(childWatchProblem(undefined, true)).toMatch(/counting/)
    expect(childWatchProblem({ status: 'ok', count: CHILD_WATCH_ROWS + 1, capped: false }, true)).toMatch(/more than/)
    expect(childWatchProblem({ status: 'ok', count: 1000, capped: true }, true)).toMatch(/more than/)
    expect(childWatchProblem({ status: 'skipped', reason: 'large and unindexed' }, true)).toBe('large and unindexed')
    expect(childWatchProblem({ status: 'timeout' }, true)).toMatch(/slow/)
    expect(childWatchProblem({ status: 'ok', count: 3, capped: false }, false)).toMatch(/primary key/)
  })
})

describe('intervals', () => {
  it('only offers fast reads on local connections', () => {
    expect(watchIntervals('relaxed')).toContain(1)
    expect(Math.min(...watchIntervals('confirm'))).toBe(5)
    expect(watchIntervals('protected')).toContain(defaultWatchInterval('protected'))
    expect(watchIntervals('relaxed')).toContain(defaultWatchInterval('relaxed'))
  })
})

describe('timeline', () => {
  it('keeps the newest events', () => {
    let events: WatchEvent[] = []
    for (let i = 0; i < WATCH_EVENT_LIMIT + 5; i++) events = addEvent(events, { at: i, kind: 'gone' })
    expect(events).toHaveLength(WATCH_EVENT_LIMIT)
    expect(events[0].at).toBe(WATCH_EVENT_LIMIT + 4)
  })

  it('writes the timeline oldest first', () => {
    const events: WatchEvent[] = [
      { at: 2, kind: 'gone' },
      { at: 1, kind: 'changed', cells: [{ column: 'Status', before: 'draft', after: null }] }
    ]
    expect(watchText(events, (at) => `t${at}`, (v) => (v === null ? 'NULL' : String(v)))).toBe('t1  row changed\n  Status: draft -> NULL\nt2  row gone')
  })
})
