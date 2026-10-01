import { EditorView, gutter, GutterMarker } from '@codemirror/view'
import { Prec, RangeSet, StateField, type Extension } from '@codemirror/state'
import { statementRanges } from '@shared/sqlComplete'

/** A ▶ beside the first line of each statement; clicking it selects and runs that statement. */
class RunMarker extends GutterMarker {
  constructor(readonly from: number, readonly to: number) {
    super()
  }
  eq(other: RunMarker): boolean {
    return other.from === this.from && other.to === this.to
  }
  toDOM(): Node {
    const el = document.createElement('span')
    el.className = 'cm-run-marker'
    el.textContent = '▶'
    el.title = 'Run this statement'
    return el
  }
}

const markers = StateField.define<RangeSet<RunMarker>>({
  create: (state) => build(state.doc.toString(), (pos) => state.doc.lineAt(pos).from),
  update: (value, tr) => (tr.docChanged ? build(tr.state.doc.toString(), (pos) => tr.state.doc.lineAt(pos).from) : value)
})

function build(doc: string, lineStart: (pos: number) => number): RangeSet<RunMarker> {
  const out: { from: number; value: RunMarker }[] = []
  let lastLine = -1
  for (const s of statementRanges(doc)) {
    const line = lineStart(s.from)
    // Two statements on one line share the first's marker.
    if (line === lastLine) continue
    lastLine = line
    out.push({ from: line, value: new RunMarker(s.from, s.to) })
  }
  return RangeSet.of(out.map((m) => m.value.range(m.from)))
}

/** `run(sql, from)`: called with the statement's text and where it starts in the editor. */
export function runGutter(run: (sql: string, from: number) => void): Extension {
  return [
    markers,
    Prec.highest(gutter({
      class: 'cm-run-gutter',
      markers: (view) => view.state.field(markers),
      domEventHandlers: {
        mousedown(view: EditorView, line) {
          let hit: RunMarker | null = null
          view.state.field(markers).between(line.from, line.from, (_from, _to, value) => {
            hit = value
          })
          if (!hit) return false
          const { from, to } = hit as RunMarker
          view.dispatch({ selection: { anchor: from, head: to } })
          run(view.state.sliceDoc(from, to), from)
          return true
        }
      }
    }))
  ]
}
