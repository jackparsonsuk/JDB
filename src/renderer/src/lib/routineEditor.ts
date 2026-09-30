import { Decoration, EditorView, GutterMarker, gutter } from '@codemirror/view'
import { RangeSetBuilder, type EditorState, type Extension } from '@codemirror/state'
import type { OutlineItem, OutlineKind } from '@shared/sqlLayout'

/** Outline kinds that change something or leave the routine, which get a gutter marker. */
export const EFFECT_KINDS: ReadonlySet<OutlineKind> = new Set(['write', 'temp', 'call', 'tx', 'error'])

const EFFECT_LABELS: Partial<Record<OutlineKind, string>> = {
  write: 'Writes to a table',
  temp: 'Writes to a temp table or table variable',
  call: 'Calls another routine or dynamic SQL',
  tx: 'Transaction control',
  error: 'Raises or handles an error'
}

class EffectMarker extends GutterMarker {
  constructor(readonly kind: OutlineKind, readonly label: string) {
    super()
  }

  eq(other: EffectMarker): boolean {
    return other.kind === this.kind && other.label === this.label
  }

  toDOM(): Node {
    const el = document.createElement('div')
    el.className = `cm-effect cm-effect-${this.kind}`
    el.title = `${EFFECT_LABELS[this.kind] ?? ''}: ${this.label}`
    return el
  }
}

/** The first effect on each line; a line with a write and a call shows the write. */
function byLine(items: OutlineItem[]): Map<number, OutlineItem> {
  const rank: OutlineKind[] = ['write', 'error', 'tx', 'temp', 'call']
  const out = new Map<number, OutlineItem>()
  for (const item of items) {
    if (!EFFECT_KINDS.has(item.kind)) continue
    const seen = out.get(item.line)
    if (!seen || rank.indexOf(item.kind) < rank.indexOf(seen.kind)) out.set(item.line, item)
  }
  return out
}

const tints = {
  write: Decoration.line({ class: 'cm-line-write' }),
  error: Decoration.line({ class: 'cm-line-error' })
}

/** A gutter of markers on lines that write, call or control transactions, and a faint tint on writes. */
export function effectMarkers(items: OutlineItem[]): Extension {
  const lines = byLine(items)
  const sorted = [...lines.entries()].sort((a, b) => a[0] - b[0])
  const markers = (state: EditorState) => {
    const builder = new RangeSetBuilder<GutterMarker>()
    for (const [line, item] of sorted) {
      if (line > state.doc.lines) break
      const at = state.doc.line(line).from
      builder.add(at, at, new EffectMarker(item.kind, item.label))
    }
    return builder.finish()
  }
  return [
    gutter({
      class: 'cm-effects',
      markers: (view) => markers(view.state),
      initialSpacer: () => new EffectMarker('write', '')
    }),
    EditorView.decorations.compute(['doc'], (state) => {
      const builder = new RangeSetBuilder<Decoration>()
      for (const [line, item] of sorted) {
        if (line > state.doc.lines) break
        const tint = item.kind === 'write' ? tints.write : item.kind === 'error' ? tints.error : null
        if (tint) {
          const at = state.doc.line(line).from
          builder.add(at, at, tint)
        }
      }
      return builder.finish()
    })
  ]
}
