import { describe, expect, it } from 'vitest'
import { activate, addTab, closeTab, closeTabs, emptyPanes, focusedTabId, focusPane, isSplit, moveTab, reorderTab, setPinned, tabsIn, tabsToClose, type PaneId, type PaneTab, type Panes } from './panes'

const tab = (id: string, pane: PaneId = 0): PaneTab => ({ id, pane })
const build = (...tabs: PaneTab[]): Panes<PaneTab> => tabs.reduce(addTab, emptyPanes<PaneTab>())
const ids = (s: Panes<PaneTab>, pane: PaneId): string[] => tabsIn(s, pane).map((t) => t.id)

describe('panes', () => {
  it('opens tabs in the pane they name and focuses it', () => {
    const s = build(tab('a'), tab('b', 1))
    expect(isSplit(s)).toBe(true)
    expect(s.active).toEqual(['a', 'b'])
    expect(s.focused).toBe(1)
    expect(focusedTabId(s)).toBe('b')
  })

  it('moving a tab across splits the view and hands the old pane to a neighbour', () => {
    const s = moveTab(build(tab('a'), tab('b'), tab('c')), 'b', 1)
    expect(ids(s, 0)).toEqual(['a', 'c'])
    expect(ids(s, 1)).toEqual(['b'])
    expect(s.active).toEqual(['c', 'b'])
    expect(s.focused).toBe(1)
  })

  it('closing the last tab in the right pane collapses the split', () => {
    const s = closeTab(build(tab('a'), tab('b', 1)), 'b')
    expect(isSplit(s)).toBe(false)
    expect(s.active).toEqual(['a', null])
    expect(s.focused).toBe(0)
  })

  it('emptying the left pane slides the right pane over', () => {
    const s = closeTab(build(tab('a'), tab('b', 1), tab('c', 1)), 'a')
    expect(isSplit(s)).toBe(false)
    expect(ids(s, 0)).toEqual(['b', 'c'])
    expect(s.active).toEqual(['c', null])
    expect(s.focused).toBe(0)
  })

  it('moving the only left tab to the right keeps it on the left', () => {
    const s = moveTab(build(tab('a')), 'a', 1)
    expect(ids(s, 0)).toEqual(['a'])
    expect(isSplit(s)).toBe(false)
  })

  it('closing the active tab activates the next one in the same pane only', () => {
    const s = closeTab(activate(build(tab('a'), tab('b'), tab('x', 1), tab('c')), 'b'), 'b')
    expect(s.active).toEqual(['c', 'x'])
  })

  it('does not focus an empty pane', () => {
    const s = focusPane(build(tab('a')), 1)
    expect(s.focused).toBe(0)
  })
})

describe('pinning and bulk close', () => {
  it('moves a pinned tab ahead of the unpinned ones', () => {
    let s = setPinned(build(tab('a'), tab('b'), tab('c')), 'c', true)
    expect(ids(s, 0)).toEqual(['c', 'a', 'b'])
    s = setPinned(s, 'b', true)
    expect(ids(s, 0)).toEqual(['c', 'b', 'a'])
    s = setPinned(s, 'c', false)
    // Like a browser, an unpinned tab leads the unpinned ones.
    expect(ids(s, 0)).toEqual(['b', 'c', 'a'])
  })

  it('keeps a pinned tab pinned and in front when it moves pane', () => {
    const s = moveTab(setPinned(build(tab('a'), tab('d'), tab('b', 1), tab('c', 1)), 'a', true), 'a', 1)
    expect(ids(s, 0)).toEqual(['d'])
    expect(ids(s, 1)).toEqual(['a', 'b', 'c'])
    const t = moveTab(setPinned(build(tab('a'), tab('b'), tab('c', 1)), 'b', true), 'b', 1)
    expect(ids(t, 1)).toEqual(['b', 'c'])
  })

  it('works out which tabs each close command closes, skipping pinned ones and the other pane', () => {
    const s = setPinned(build(tab('a'), tab('b'), tab('c'), tab('d'), tab('x', 1)), 'a', true)
    expect(tabsToClose(s, 'c', 'others')).toEqual(['b', 'd'])
    expect(tabsToClose(s, 'b', 'right')).toEqual(['c', 'd'])
    expect(tabsToClose(s, 'c', 'all')).toEqual(['b', 'c', 'd'])
    expect(tabsToClose(s, 'a', 'all')).toEqual(['b', 'c', 'd'])
  })

  it('shows the kept tab after closing the others', () => {
    const s = closeTabs(build(tab('a'), tab('b'), tab('c')), ['a', 'c'], 'b')
    expect(ids(s, 0)).toEqual(['b'])
    expect(s.active[0]).toBe('b')
  })
})

describe('reorderTab', () => {
  it('moves a tab before another in its pane, or to the end', () => {
    const s = build(tab('a'), tab('b'), tab('c'))
    expect(ids(reorderTab(s, 'c', 0, 'a'), 0)).toEqual(['c', 'a', 'b'])
    expect(ids(reorderTab(s, 'a', 0, 'c'), 0)).toEqual(['b', 'a', 'c'])
    expect(ids(reorderTab(s, 'a', 0, null), 0)).toEqual(['b', 'c', 'a'])
    expect(reorderTab(s, 'a', 0, null).active[0]).toBe('a')
  })

  it('moves a tab into the other pane at a position, handing its old pane to a neighbour', () => {
    const s = reorderTab(build(tab('a'), tab('b'), tab('x', 1), tab('y', 1)), 'b', 1, 'y')
    expect(ids(s, 0)).toEqual(['a'])
    expect(ids(s, 1)).toEqual(['x', 'b', 'y'])
    expect(s.active).toEqual(['a', 'b'])
    expect(s.focused).toBe(1)
  })

  it('keeps an unpinned tab behind the pinned ones', () => {
    const s = reorderTab(setPinned(build(tab('a'), tab('b')), 'a', true), 'b', 0, 'a')
    expect(ids(s, 0)).toEqual(['a', 'b'])
  })
})
