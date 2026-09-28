import { describe, expect, it } from 'vitest'
import { parseSession } from './session'
import { restore } from './panes'

const conns = new Set(['a', 'b'])
const table = { schema: 'dbo', name: 'Jobs' }

describe('parseSession', () => {
  it('keeps valid tabs and their active panes', () => {
    const s = parseSession({
      tabs: [
        { kind: 'query', pane: 0, connectionId: 'a', title: 'Query 2', sql: 'SELECT 1' },
        { kind: 'table', pane: 1, connectionId: 'b', table, filters: [{ column: 'Id', op: '=', value: '5' }], sort: { column: 'Id', dir: 'desc' } }
      ],
      active: [0, 1],
      focused: 1,
      ratio: 0.3
    }, conns)
    expect(s).toEqual({
      tabs: [
        { kind: 'query', pane: 0, connectionId: 'a', title: 'Query 2', sql: 'SELECT 1' },
        { kind: 'table', pane: 1, connectionId: 'b', table, filters: [{ column: 'Id', op: '=', value: '5' }], sort: { column: 'Id', dir: 'desc' } }
      ],
      active: [0, 1],
      focused: 1,
      ratio: 0.3
    })
  })

  it('drops tabs for deleted connections and re-points the active index', () => {
    const s = parseSession({
      tabs: [
        { kind: 'query', pane: 0, connectionId: 'gone', title: 'Q', sql: '' },
        { kind: 'query', pane: 0, connectionId: 'a', title: 'Q', sql: '' }
      ],
      active: [1, null],
      focused: 0,
      ratio: 0.5
    }, conns)
    expect(s?.tabs).toHaveLength(1)
    expect(s?.active).toEqual([0, null])
  })

  it('drops malformed tabs and filters, and clamps the ratio', () => {
    const s = parseSession({
      tabs: [
        { kind: 'record', pane: 0, connectionId: 'a', table, key: [] },
        { kind: 'table', pane: 0, connectionId: 'a', table: { name: 'x' }, filters: [] },
        { kind: 'table', pane: 0, connectionId: 'a', table, filters: [{ column: 'Id', op: 'DROP' }, 'junk'] },
        { kind: 'mystery', connectionId: 'a' }
      ],
      ratio: 7
    }, conns)
    expect(s?.tabs).toEqual([{ kind: 'table', pane: 0, connectionId: 'a', table, filters: [] }])
    expect(s?.ratio).toBe(0.8)
  })

  it('returns null for junk or an empty session', () => {
    expect(parseSession(null, conns)).toBeNull()
    expect(parseSession({ tabs: 'no' }, conns)).toBeNull()
    expect(parseSession({ tabs: [{ kind: 'query', connectionId: 'gone' }] }, conns)).toBeNull()
  })

  it('restores into a layout that collapses a lone right pane', () => {
    const s = restore([{ id: 'x', pane: 1 as const }], [null, 'x'], 1)
    expect(s.tabs[0].pane).toBe(0)
    expect(s.active).toEqual(['x', null])
    expect(s.focused).toBe(0)
  })
})
