import { describe, expect, it } from 'vitest'
import { addEvent, changedCells, compareRead, defaultWatchInterval, WATCH_EVENT_LIMIT, watchIntervals, watchText, type WatchEvent, type WatchRead } from './rowWatch'

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
    expect(watchText(events, (at) => `t${at}`, (v) => (v === null ? 'NULL' : String(v)))).toBe('t1  changed\n  Status: draft -> NULL\nt2  row gone')
  })
})
