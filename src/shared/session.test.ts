import { describe, expect, it } from 'vitest'
import { parseSession, parseWindowSessions, windowSessionsFile } from './session'
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

  it('keeps routine tabs and drops ones with an unknown kind', () => {
    const s = parseSession({
      tabs: [
        { kind: 'routine', pane: 0, connectionId: 'a', routine: { schema: 'dbo', name: 'SaveJob', kind: 'procedure' } },
        { kind: 'routine', pane: 0, connectionId: 'a', routine: { schema: 'dbo', name: 'Odd', kind: 'package' } }
      ],
      active: [0, null],
      focused: 0,
      ratio: 0.5
    }, conns)
    expect(s?.tabs).toEqual([{ kind: 'routine', pane: 0, connectionId: 'a', routine: { schema: 'dbo', name: 'SaveJob', kind: 'procedure' } }])
  })

  it('keeps search tabs with their value', () => {
    const s = parseSession({ tabs: [{ kind: 'search', pane: 0, connectionId: 'a', value: 'x@example.com' }, { kind: 'search', pane: 1, connectionId: 'b' }], active: [0, 1], focused: 0 }, conns)
    expect(s?.tabs).toEqual([
      { kind: 'search', pane: 0, connectionId: 'a', value: 'x@example.com' },
      { kind: 'search', pane: 1, connectionId: 'b', value: '' }
    ])
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

  it('keeps pinned tabs pinned', () => {
    const s = parseSession({
      tabs: [
        { kind: 'query', pane: 0, connectionId: 'a', title: 'Q', sql: '', pinned: true },
        { kind: 'query', pane: 0, connectionId: 'a', title: 'R', sql: '', pinned: 'yes' }
      ],
      active: [0, null]
    }, conns)
    expect(s?.tabs.map((t) => t.pinned)).toEqual([true, undefined])
  })
})

describe('window sessions', () => {
  const one = { tabs: [{ kind: 'query', pane: 0, connectionId: 'a', title: 'Query 1', sql: 'SELECT 1' }], active: [0, null], focused: 0, ratio: 0.5 }
  const two = { tabs: [{ kind: 'search', pane: 0, connectionId: 'b', value: 'x' }], active: [0, null], focused: 0, ratio: 0.5 }

  it('reads a single-window session from before windows as the main window', () => {
    expect(parseWindowSessions(one)).toEqual([{ key: 'main', session: one }])
    expect(parseWindowSessions(null)).toEqual([])
  })

  it('round-trips several windows with their bounds, dropping bad entries and bounds', () => {
    const windows = [
      { key: 'main', session: one, bounds: { x: 10, y: 20, width: 1400, height: 900, maximized: true } },
      { key: 'w2', session: two }
    ]
    const file = windowSessionsFile(windows)
    expect(parseWindowSessions(JSON.parse(JSON.stringify(file)))).toEqual(windows)
    expect(parseWindowSessions({ windows: [{ key: 'w3', session: two, bounds: { x: 'left' } }, { session: one }, 'junk'] })).toEqual([{ key: 'w3', session: two }])
  })

  it('keeps the first window at the top level, so older versions still reopen it', () => {
    const file = windowSessionsFile([{ key: 'main', session: one }, { key: 'w2', session: two }])
    expect(parseSession(file, conns)?.tabs).toEqual(one.tabs)
  })
})
