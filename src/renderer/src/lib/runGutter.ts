import { Decoration, EditorView, gutter, GutterMarker, WidgetType, type DecorationSet } from '@codemirror/view'
import { Facet, Prec, RangeSet, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { statementRanges } from '@shared/sqlComplete'
import { findWriteKeyword } from '@shared/sqlGuard'
import { formatCount, formatDuration } from './format'

/** How the last run of a statement went, shown at the end of it. */
export type RunStatus =
  | { kind: 'running' }
  | { kind: 'done'; rows?: number; affected: number; durationMs: number }
  | { kind: 'error'; message: string; at?: number }
  | { kind: 'cancelled' }

/** Records a run of the SQL at `from`; `source` is the SQL as written, so an edited statement drops its note. */
export const setRunStatus = StateEffect.define<{ source: string; from: number; status: RunStatus }>()

/** What the gutter needs from the tab that changes while it's open. */
export const runGutterConfig = Facet.define<{ readOnly: boolean }, { readOnly: boolean }>({
  combine: (values) => values[values.length - 1] ?? { readOnly: false }
})

interface Statement {
  from: number
  to: number
  /** The write keyword it contains, if any. */
  write: string | null
}

interface Entry {
  from: number
  source: string
  status: RunStatus
}

/** Statement text without its closing semicolon, for matching a run to the statement it came from. */
const normal = (sql: string): string => sql.trim().replace(/;\s*$/, '').trim()

const statements = StateField.define<Statement[]>({
  create: (state) => split(state),
  update: (value, tr) => (tr.docChanged ? split(tr.state) : value)
})

function split(state: EditorState): Statement[] {
  const doc = state.doc.toString()
  return statementRanges(doc).map((s) => ({ ...s, write: findWriteKeyword(doc.slice(s.from, s.to)) }))
}

const statuses = StateField.define<Entry[]>({
  create: () => [],
  update(value, tr) {
    let out = tr.docChanged
      ? value.map((e) => ({
        ...e,
        from: tr.changes.mapPos(e.from, 1),
        status: e.status.kind === 'error' && e.status.at !== undefined ? { ...e.status, at: tr.changes.mapPos(e.status.at) } : e.status
      }))
      : value
    for (const effect of tr.effects) {
      if (!effect.is(setRunStatus)) continue
      // A run of exactly one statement (with or without comments around it) notes it there; a run of several notes nothing.
      const { from, source } = effect.value
      const inside = tr.state.field(statements).filter((s) => s.from >= from && s.to <= from + source.length)
      if (inside.length !== 1) continue
      const s = inside[0]
      out = [...out.filter((e) => e.from !== s.from), { from: s.from, source: normal(tr.state.sliceDoc(s.from, s.to)), status: effect.value.status }]
    }
    return out
  }
})

/** The status of each statement whose text is still what ran. */
function statusOf(state: EditorState, s: Statement): RunStatus | undefined {
  const entry = state.field(statuses).find((e) => e.from === s.from)
  return entry && entry.source === normal(state.sliceDoc(s.from, s.to)) ? entry.status : undefined
}

type MarkerKind = 'run' | 'write' | 'locked' | 'running'

class RunMarker extends GutterMarker {
  constructor(readonly kind: MarkerKind, readonly statement: Statement) {
    super()
  }
  eq(other: RunMarker): boolean {
    return other.kind === this.kind && other.statement.from === this.statement.from && other.statement.to === this.statement.to && other.statement.write === this.statement.write
  }
  toDOM(): Node {
    const el = document.createElement('span')
    el.className = `cm-run-marker ${this.kind}`
    const { write } = this.statement
    if (this.kind === 'running') {
      el.title = 'Running. Click to stop it (Esc)'
    } else if (this.kind === 'locked') {
      el.textContent = '🔒'
      el.title = `This ${write} can't run: the connection is read-only`
    } else {
      el.textContent = '▶'
      el.title = this.kind === 'write' ? `Run this ${write}. It changes data` : 'Run this statement'
    }
    return el
  }
}

function markerKind(state: EditorState, s: Statement): MarkerKind {
  if (statusOf(state, s)?.kind === 'running') return 'running'
  if (s.write) return state.facet(runGutterConfig).readOnly ? 'locked' : 'write'
  return 'run'
}

function markers(state: EditorState): RangeSet<RunMarker> {
  const out = []
  let lastLine = -1
  for (const s of state.field(statements)) {
    const line = state.doc.lineAt(s.from).from
    // Two statements on one line share the first's marker.
    if (line === lastLine) continue
    lastLine = line
    out.push(new RunMarker(markerKind(state, s), s).range(line))
  }
  return RangeSet.of(out)
}

/** The note after a statement saying how its last run went. */
class StatusWidget extends WidgetType {
  constructor(readonly status: RunStatus, readonly from: number) {
    super()
  }
  eq(other: StatusWidget): boolean {
    return JSON.stringify(other.status) === JSON.stringify(this.status) && other.from === this.from
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('span')
    const s = this.status
    if (s.kind === 'done') {
      el.className = 'cm-run-status ok'
      const what = s.rows !== undefined ? `${formatCount(s.rows)} row${s.rows === 1 ? '' : 's'}` : `${formatCount(s.affected)} affected`
      el.textContent = `✓ ${what} · ${formatDuration(s.durationMs)}`
    } else if (s.kind === 'error') {
      el.className = 'cm-run-status err'
      const first = s.message.split('\n')[0]
      el.textContent = `✕ ${first.length > 70 ? `${first.slice(0, 70)}…` : first}`
      el.title = `${s.message}\n\nClick to go to where it failed`
      el.onmousedown = (e) => {
        e.preventDefault()
        const at = s.at ?? this.from
        view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) })
        view.focus()
      }
    } else if (s.kind === 'cancelled') {
      el.className = 'cm-run-status'
      el.textContent = '■ Stopped'
    } else {
      el.className = 'cm-run-status'
      el.textContent = 'Running…'
    }
    return el
  }
  ignoreEvent(): boolean {
    return false
  }
}

const notes = EditorView.decorations.compute([statements, statuses], (state): DecorationSet => {
  const out = []
  for (const s of state.field(statements)) {
    const status = statusOf(state, s)
    // Sits after the closing semicolon when there is one.
    const end = state.sliceDoc(s.to, s.to + 1) === ';' ? s.to + 1 : s.to
    if (status) out.push(Decoration.widget({ widget: new StatusWidget(status, s.from), side: 1 }).range(end))
  }
  return Decoration.set(out, true)
})

/**
 * A ▶ beside the first line of each statement: amber for one that writes, a lock when the connection
 * is read-only, and a spinner that stops the run while it runs. `run(sql, from)` gets the statement's
 * text and where it starts in the editor.
 */
export function runGutter(run: (sql: string, from: number) => void, cancel: () => void): Extension {
  return [
    statements,
    statuses,
    notes,
    Prec.highest(gutter({
      class: 'cm-run-gutter',
      markers: (view) => markers(view.state),
      domEventHandlers: {
        mousedown(view, line) {
          let hit: RunMarker | null = null
          markers(view.state).between(line.from, line.from, (_from, _to, value) => {
            hit = value
          })
          const marker = hit as RunMarker | null
          if (!marker) return false
          if (marker.kind === 'running') cancel()
          else if (marker.kind !== 'locked') {
            const { from, to } = marker.statement
            view.dispatch({ selection: { anchor: from, head: to } })
            run(view.state.sliceDoc(from, to), from)
          }
          return true
        }
      }
    }))
  ]
}
