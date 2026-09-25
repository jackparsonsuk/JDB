import { describe, expect, it } from 'vitest'
import { activate, addTab, closeTab, emptyPanes, focusedTabId, focusPane, isSplit, moveTab, tabsIn, type PaneId, type PaneTab, type Panes } from './panes'

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
