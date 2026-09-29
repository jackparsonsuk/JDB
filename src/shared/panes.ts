/**
 * Tab layout across the editor's two side-by-side panes. Pure so it can be tested; the renderer
 * keeps one of these in state. Pane 1 only exists while it has tabs, and pane 0 is never left
 * empty while pane 1 has some (its tabs slide over instead).
 */

export type PaneId = 0 | 1

export interface PaneTab {
  id: string
  pane: PaneId
  /** Pinned tabs come first in their pane and are skipped by the bulk close commands. */
  pinned?: boolean
}

/** Which tabs a bulk close command closes, relative to the tab it was chosen on. */
export type CloseScope = 'others' | 'right' | 'all'

export interface Panes<T extends PaneTab> {
  /** All tabs in opening order; each pane shows its own in that order. */
  tabs: T[]
  active: [string | null, string | null]
  focused: PaneId
}

export const otherPane = (pane: PaneId): PaneId => (pane === 0 ? 1 : 0)

export function emptyPanes<T extends PaneTab>(): Panes<T> {
  return { tabs: [], active: [null, null], focused: 0 }
}

export const isSplit = (s: Panes<PaneTab>): boolean => s.tabs.some((t) => t.pane === 1)

export const tabsIn = <T extends PaneTab>(s: Panes<T>, pane: PaneId): T[] => s.tabs.filter((t) => t.pane === pane)

/** The active tab of the focused pane: what keyboard shortcuts act on. */
export const focusedTabId = (s: Panes<PaneTab>): string | null => s.active[s.focused]

/** Adds a tab to the pane it names and makes it active and focused. */
export function addTab<T extends PaneTab>(s: Panes<T>, tab: T): Panes<T> {
  return normalise({ tabs: [...s.tabs, tab], active: withActive(s.active, tab.pane, tab.id), focused: tab.pane })
}

/** Rebuilds a layout from tabs and each pane's active tab, e.g. when restoring a saved session. */
export function restore<T extends PaneTab>(tabs: T[], active: [string | null, string | null], focused: PaneId): Panes<T> {
  return normalise({ tabs, active, focused })
}

export function activate<T extends PaneTab>(s: Panes<T>, id: string): Panes<T> {
  const tab = s.tabs.find((t) => t.id === id)
  if (!tab) return s
  return { ...s, active: withActive(s.active, tab.pane, id), focused: tab.pane }
}

export function focusPane<T extends PaneTab>(s: Panes<T>, pane: PaneId): Panes<T> {
  if (s.focused === pane || !tabsIn(s, pane).length) return s
  return { ...s, focused: pane }
}

/** Moves a tab to the end of another pane, activating it there. */
export function moveTab<T extends PaneTab>(s: Panes<T>, id: string, pane: PaneId): Panes<T> {
  const tab = s.tabs.find((t) => t.id === id)
  if (!tab || tab.pane === pane) return tab ? activate(s, id) : s
  const remaining = s.tabs.filter((t) => t.id !== id)
  const active = withActive(s.active, tab.pane, s.active[tab.pane] === id ? neighbour(s.tabs, tab) : s.active[tab.pane])
  return normalise({ tabs: [...remaining, { ...tab, pane }], active: withActive(active, pane, id), focused: pane })
}

/**
 * Moves a tab to sit before `beforeId` in `pane` (the end when null), e.g. when dragged along a
 * tab bar, and shows it there. Pinned tabs still stay ahead of unpinned ones.
 */
export function reorderTab<T extends PaneTab>(s: Panes<T>, id: string, pane: PaneId, beforeId: string | null): Panes<T> {
  const tab = s.tabs.find((t) => t.id === id)
  if (!tab || id === beforeId) return s
  const rest = s.tabs.filter((t) => t.id !== id)
  const at = beforeId === null ? -1 : rest.findIndex((t) => t.id === beforeId)
  const moving = { ...tab, pane }
  const tabs = at < 0 ? [...rest, moving] : [...rest.slice(0, at), moving, ...rest.slice(at)]
  const active = tab.pane !== pane && s.active[tab.pane] === id ? withActive(s.active, tab.pane, neighbour(s.tabs, tab)) : s.active
  return normalise({ tabs, active: withActive(active, pane, id), focused: pane })
}

export function closeTab<T extends PaneTab>(s: Panes<T>, id: string): Panes<T> {
  const tab = s.tabs.find((t) => t.id === id)
  if (!tab) return s
  const active = s.active[tab.pane] === id ? withActive(s.active, tab.pane, neighbour(s.tabs, tab)) : s.active
  return normalise({ tabs: s.tabs.filter((t) => t.id !== id), active, focused: s.focused })
}

export function setPinned<T extends PaneTab>(s: Panes<T>, id: string, pinned: boolean): Panes<T> {
  return normalise({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, pinned } : t)) })
}

/** The unpinned tabs in `id`'s pane that a bulk close would close; `id` itself is kept except for 'all'. */
export function tabsToClose(s: Panes<PaneTab>, id: string, scope: CloseScope): string[] {
  const tab = s.tabs.find((t) => t.id === id)
  if (!tab) return []
  const own = tabsIn(s, tab.pane)
  const index = own.findIndex((t) => t.id === id)
  return own
    .filter((t, i) => !t.pinned && (scope === 'all' || (t.id !== id && (scope === 'others' || i > index))))
    .map((t) => t.id)
}

/** Closes several tabs, then shows `keep` if it's still open. */
export function closeTabs<T extends PaneTab>(s: Panes<T>, ids: string[], keep?: string): Panes<T> {
  const closed = ids.reduce(closeTab, s)
  return keep ? activate(closed, keep) : closed
}

/** The tab that takes over when `tab` leaves its pane: the next one along, else the previous. */
function neighbour(tabs: PaneTab[], tab: PaneTab): string | null {
  const same = tabs.filter((t) => t.pane === tab.pane)
  const index = same.findIndex((t) => t.id === tab.id)
  const rest = same.filter((t) => t.id !== tab.id)
  return rest[Math.min(index, rest.length - 1)]?.id ?? null
}

function withActive(active: [string | null, string | null], pane: PaneId, id: string | null): [string | null, string | null] {
  return pane === 0 ? [id, active[1]] : [active[0], id]
}

/**
 * Collapses an empty pane, keeps pinned tabs ahead of the rest (a stable sort, so each group keeps
 * its order), and keeps each pane's active tab pointing at one of its own tabs.
 */
function normalise<T extends PaneTab>(s: Panes<T>): Panes<T> {
  let { active, focused } = s
  let tabs = [...s.tabs.filter((t) => t.pinned), ...s.tabs.filter((t) => !t.pinned)]
  if (!tabs.some((t) => t.pane === 0) && tabs.some((t) => t.pane === 1)) {
    tabs = tabs.map((t) => ({ ...t, pane: 0 }))
    active = [active[1], null]
    focused = 0
  }
  const fixed = ([0, 1] as const).map((pane) => {
    const own = tabs.filter((t) => t.pane === pane)
    return own.some((t) => t.id === active[pane]) ? active[pane] : own[own.length - 1]?.id ?? null
  }) as [string | null, string | null]
  if (!fixed[focused]) focused = 0
  return { tabs, active: fixed, focused }
}
