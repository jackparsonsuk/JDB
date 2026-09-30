import { useEffect, useMemo, useRef } from 'react'
import type { Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import type { DbKind } from '@shared/types'
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
}

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
  return [
    plugin,
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
    open: (target, beside) => open(
      target.kind === 'table'
        ? { kind: 'table', connectionId, table: target.table, filters: [], ...(target.column && { column: target.column }) }
        : { kind: 'routine', connectionId, routine: target.routine },
      beside ? otherPane(pane) : pane
    )
  }
  return useMemo(() => clickableNames(handlers), [])
}
