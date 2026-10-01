import type { ColumnFilter, FilterOp, SavedSession, SavedTab, TableRef } from './types'

const FILTER_OPS: ReadonlySet<string> = new Set<FilterOp>(['=', '!=', 'contains', 'starts', '>', '<', 'is null', 'not null'])

/**
 * Checks a saved session read back from disk, which may be from an older version or hand-edited.
 * Tabs that are malformed or whose connection has since been deleted are dropped, and each pane's
 * active tab is re-pointed at what remains. Returns null when nothing is left to restore.
 */
export function parseSession(raw: unknown, connectionIds: ReadonlySet<string>): SavedSession | null {
  if (!isObject(raw) || !Array.isArray(raw.tabs)) return null
  const kept: { tab: SavedTab; from: number }[] = []
  raw.tabs.forEach((value, from) => {
    const tab = parseTab(value)
    if (!tab || !connectionIds.has(tab.connectionId)) return
    if (isObject(value) && value.pinned === true) tab.pinned = true
    kept.push({ tab, from })
  })
  if (!kept.length) return null

  const tabs = kept.map((k) => k.tab)
  const savedActive = Array.isArray(raw.active) ? raw.active : []
  const active = ([0, 1] as const).map((pane) => {
    const at = kept.findIndex((k) => k.from === savedActive[pane] && k.tab.pane === pane)
    return at >= 0 ? at : null
  }) as [number | null, number | null]
  const ratio = typeof raw.ratio === 'number' && Number.isFinite(raw.ratio) ? Math.max(0.2, Math.min(0.8, raw.ratio)) : 0.5
  return { tabs, active, focused: raw.focused === 1 ? 1 : 0, ratio }
}

function parseTab(value: unknown): SavedTab | null {
  if (!isObject(value) || typeof value.connectionId !== 'string') return null
  const pane = value.pane === 1 ? 1 : 0
  const connectionId = value.connectionId
  switch (value.kind) {
    case 'query':
      return {
        kind: 'query', pane, connectionId, title: typeof value.title === 'string' ? value.title : 'Query', sql: typeof value.sql === 'string' ? value.sql : '',
        ...(typeof value.savedId === 'string' && { savedId: value.savedId }),
        ...(typeof value.schema === 'string' && value.schema && { schema: value.schema })
      }
    case 'table': {
      const table = parseTableRef(value.table)
      if (!table) return null
      const sort = isObject(value.sort) && typeof value.sort.column === 'string'
        ? { column: value.sort.column, dir: value.sort.dir === 'desc' ? 'desc' as const : 'asc' as const }
        : undefined
      return { kind: 'table', pane, connectionId, table, filters: parseFilters(value.filters), ...(sort && { sort }) }
    }
    case 'record': {
      const table = parseTableRef(value.table)
      const key = parseFilters(value.key)
      return table && key.length ? { kind: 'record', pane, connectionId, table, key } : null
    }
    case 'design': {
      const table = parseTableRef(value.table)
      return table ? { kind: 'design', pane, connectionId, table } : null
    }
    case 'routine': {
      const ref = parseTableRef(value.routine)
      const kind = isObject(value.routine) ? value.routine.kind : undefined
      return ref && (kind === 'procedure' || kind === 'function' || kind === 'trigger')
        ? { kind: 'routine', pane, connectionId, routine: { ...ref, kind } }
        : null
    }
    case 'search':
      return { kind: 'search', pane, connectionId, value: typeof value.value === 'string' ? value.value : '' }
    default:
      return null
  }
}

function parseTableRef(value: unknown): TableRef | null {
  return isObject(value) && typeof value.schema === 'string' && typeof value.name === 'string'
    ? { schema: value.schema, name: value.name }
    : null
}

function parseFilters(value: unknown): ColumnFilter[] {
  if (!Array.isArray(value)) return []
  return value.filter((f): f is ColumnFilter => isObject(f) && typeof f.column === 'string' && typeof f.op === 'string' && FILTER_OPS.has(f.op))
    .map((f) => ({ column: f.column, op: f.op, ...(typeof f.value === 'string' && { value: f.value }) }))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Where a window was: its normal (unmaximised) bounds, and whether it was maximised. */
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
  maximized?: boolean
}

/** One window's tabs (an unchecked SavedSession, which its renderer parses) and where it was. */
export interface WindowSession {
  key: string
  bounds?: WindowBounds
  session: unknown
}

function parseBounds(value: unknown): WindowBounds | undefined {
  if (!isObject(value)) return undefined
  const { x, y, width, height } = value
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  return { x: x as number, y: y as number, width: width as number, height: height as number, ...(value.maximized === true && { maximized: true }) }
}

/** Each window's last session from session.json. Up to 1.8.0 the file held one window's session. */
export function parseWindowSessions(raw: unknown): WindowSession[] {
  if (!isObject(raw)) return []
  if (!Array.isArray(raw.windows)) return [{ key: 'main', session: raw }]
  return raw.windows.flatMap((w): WindowSession[] => {
    if (!isObject(w) || typeof w.key !== 'string') return []
    const bounds = parseBounds(w.bounds)
    return [{ key: w.key, session: w.session ?? null, ...(bounds && { bounds }) }]
  })
}

/**
 * What session.json holds for these windows. The first window's tabs also stay at the top level,
 * as 1.8.0 and earlier wrote them, so going back to an older version still reopens that window.
 */
export function windowSessionsFile(windows: WindowSession[]): Record<string, unknown> {
  const first = windows.find((w) => isObject(w.session))?.session as Record<string, unknown> | undefined
  return { ...first, windows }
}
