import { useEffect, useMemo, useRef } from 'react'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, hoverTooltip, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { DbKind, RoutineRef, TableDetails, TableInfo, TableRef } from '@shared/types'
import { ROUTINE_LABELS } from '@shared/routines'
import { describeCached } from './lookups'
import { formatCount } from './format'
import { otherPane, type PaneId } from '@shared/panes'
import { nameAt, type NameAt, type NameTarget } from '@shared/routines'
import { useAppState } from '../state'

/**
 * Ctrl+click (Cmd on a Mac) on a table, routine or alias in the editor opens it; Shift as well
 * opens it in the other pane. While Ctrl is held the name under the pointer is underlined.
 * `resolve` and `open` are read through refs, so the extension never needs rebuilding.
 */
export interface NameLinks {
  resolve(doc: string, pos: number): NameAt | null
  open(target: NameTarget, beside: boolean): void
  /** A table's columns and keys, for the hover card; read once per table and cached. */
  describe(table: TableRef): Promise<TableDetails>
  /** The table list's entry, for its type and row estimate. */
  info(table: TableRef): TableInfo | undefined
}

/** Columns listed on a hover card before "and N more"; wide tables have hundreds. */
const HOVER_COLUMNS = 40

const link = Decoration.mark({ class: 'cm-name-link' })

export function clickableNames(handlers: { current: NameLinks }): Extension {
  const plugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none
    private last: { x: number; y: number } | null = null
    private cache: { doc: string; pos: number; hit: NameAt | null } | null = null

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate): void {
      if (update.docChanged) this.clear()
    }

    hitAt(x: number, y: number): NameAt | null {
      const pos = this.view.posAtCoords({ x, y })
      if (pos === null) return null
      const doc = this.view.state.doc.toString()
      if (this.cache && this.cache.doc === doc && this.cache.pos === pos) return this.cache.hit
      const hit = handlers.current.resolve(doc, pos)
      this.cache = { doc, pos, hit }
      return hit
    }

    show(x: number, y: number): void {
      const hit = this.hitAt(x, y)
      const next = hit ? Decoration.set([link.range(hit.from, hit.to)]) : Decoration.none
      if (next.size === 0 && this.decorations.size === 0) return
      this.decorations = next
      this.view.contentDOM.classList.toggle('cm-names-armed', !!hit)
      // Decorations from a plugin are read on the next update; an empty dispatch triggers one.
      this.view.dispatch({})
    }

    clear(): void {
      if (this.decorations.size === 0) return
      this.decorations = Decoration.none
      this.view.contentDOM.classList.remove('cm-names-armed')
      queueMicrotask(() => this.view.dispatch({}))
    }

    move(event: MouseEvent): void {
      this.last = { x: event.clientX, y: event.clientY }
      if (event.ctrlKey || event.metaKey) this.show(event.clientX, event.clientY)
      else this.clear()
    }

    key(event: KeyboardEvent, down: boolean): void {
      if (event.key !== 'Control' && event.key !== 'Meta') return
      if (down && this.last) this.show(this.last.x, this.last.y)
      else if (!down) this.clear()
    }
  }, {
    decorations: (p) => p.decorations,
    eventHandlers: {
      mousemove(event) { this.move(event) },
      mouseleave() { this.clear() },
      keydown(event) { this.key(event, true) },
      keyup(event) { this.key(event, false) },
      blur() { this.clear() },
      mousedown(event) {
        if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return false
        const hit = this.hitAt(event.clientX, event.clientY)
        if (!hit) return false
        event.preventDefault()
        this.clear()
        handlers.current.open(hit.target, event.shiftKey)
        return true
      }
    }
  })
  // Hovering a table, alias or alias.column shows the table's columns; a routine says what it is.
  const hover = hoverTooltip(async (view, pos) => {
    const hit = handlers.current.resolve(view.state.doc.toString(), pos)
    if (!hit) return null
    const target = hit.target
    if (target.kind === 'routine') {
      return { pos: hit.from, end: hit.to, above: true, create: () => ({ dom: routineCard(target.routine) }) }
    }
    let details: TableDetails
    try {
      details = await handlers.current.describe(target.table)
    } catch {
      return null
    }
    const dom = tableCard(target.table, handlers.current.info(target.table), details, target.column)
    return { pos: hit.from, end: hit.to, above: true, create: () => ({ dom }) }
  }, { hoverTime: 350 })

  return [
    plugin,
    hover,
    EditorView.baseTheme({
      '.cm-name-link': { textDecoration: 'underline', textDecorationColor: 'var(--accent)', color: 'var(--accent)' },
      '.cm-names-armed': { cursor: 'pointer' }
    })
  ]
}

/**
 * Ctrl+click names for an editor on `connectionId`: tables open in a table tab (at the column,
 * for `alias.column`), routines in a routine tab, in `pane` or, with Shift, the other one.
 */
export function useClickableNames(connectionId: string, pane: PaneId, kind: DbKind | undefined, defaults: string[]): Extension {
  const { tables, routines, loadRoutines, open } = useAppState()
  useEffect(() => {
    loadRoutines(connectionId)
  }, [connectionId, loadRoutines])
  const handlers = useRef<NameLinks>(null!)
  handlers.current = {
    resolve: (doc, pos) => (kind ? nameAt(doc, kind, pos, tables[connectionId]?.tables ?? [], routines[connectionId]?.routines ?? [], defaults) : null),
    describe: (table) => describeCached(connectionId, table),
    info: (table) => tables[connectionId]?.tables.find((t) => t.schema.toLowerCase() === table.schema.toLowerCase() && t.name.toLowerCase() === table.name.toLowerCase()),
    open: (target, beside) => open(
      target.kind === 'table'
        ? { kind: 'table', connectionId, table: target.table, filters: [], ...(target.column && { column: target.column }) }
        : { kind: 'routine', connectionId, routine: target.routine },
      beside ? otherPane(pane) : pane
    )
  }
  return useMemo(() => clickableNames(handlers), [])
}

const el = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** The hover card for a table: its columns with types and keys, the hovered column marked. */
function tableCard(table: TableRef, info: TableInfo | undefined, details: TableDetails, column?: string): HTMLElement {
  const card = el('div', 'name-card')
  const head = el('div', 'name-card-head')
  head.append(el('span', 'name-card-icon', info?.type === 'view' ? '◫' : '▦'), el('span', 'name-card-schema', `${table.schema}.`), el('strong', '', table.name))
  const facts = [info?.type === 'view' ? 'view' : 'table', `${details.columns.length} column${details.columns.length === 1 ? '' : 's'}`]
  if (info?.rowEstimate !== undefined) facts.push(`~${formatCount(info.rowEstimate)} rows`)
  head.append(el('span', 'name-card-facts', facts.join(' · ')))
  card.append(head)

  const list = el('div', 'name-card-columns')
  const wanted = column?.toLowerCase()
  // The hovered column always shows, even past the cut-off.
  const shown = details.columns.filter((c, i) => i < HOVER_COLUMNS || c.name.toLowerCase() === wanted)
  for (const c of shown) {
    const row = el('div', `name-card-col${c.name.toLowerCase() === wanted ? ' on' : ''}`)
    const name = el('span', 'name-card-name', c.name)
    if (c.isPrimaryKey) name.prepend(el('span', 'name-card-badge pk', 'PK'))
    else if (c.references) name.prepend(el('span', 'name-card-badge fk', 'FK'))
    row.append(name, el('span', 'name-card-type', `${c.dataType}${c.nullable ? '' : ' not null'}`))
    if (c.references) row.title = `→ ${c.references.schema}.${c.references.name}.${c.references.column}`
    list.append(row)
  }
  card.append(list)
  const more = details.columns.length - shown.length
  card.append(el('div', 'name-card-foot', `${more > 0 ? `and ${more} more · ` : ''}Ctrl+click to open`))
  return card
}

function routineCard(routine: RoutineRef): HTMLElement {
  const card = el('div', 'name-card')
  const head = el('div', 'name-card-head')
  head.append(el('span', 'name-card-schema', `${routine.schema}.`), el('strong', '', routine.name), el('span', 'name-card-facts', ROUTINE_LABELS[routine.kind].singular))
  card.append(head, el('div', 'name-card-foot', 'Ctrl+click to open its source'))
  return card
}
