import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'

/** Marks where the last query error happened: the line, and the offending text when known. */
export interface ErrorMark {
  line: number
  from?: number
  to?: number
}

export const setErrorMark = StateEffect.define<ErrorMark | null>()

const lineDeco = Decoration.line({ class: 'cm-sql-error-line' })
const spotDeco = Decoration.mark({ class: 'cm-sql-error' })

const field = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    // Editing the text clears the mark: it described the SQL as it was.
    let next = tr.docChanged ? Decoration.none : marks
    for (const effect of tr.effects) {
      if (!effect.is(setErrorMark)) continue
      const mark = effect.value
      if (!mark || mark.line < 1 || mark.line > tr.state.doc.lines) {
        next = Decoration.none
        continue
      }
      const line = tr.state.doc.line(mark.line)
      const ranges: Range<Decoration>[] = [lineDeco.range(line.from)]
      if (mark.from !== undefined && mark.to !== undefined && mark.to > mark.from && mark.to <= tr.state.doc.length) ranges.push(spotDeco.range(mark.from, mark.to))
      next = Decoration.set(ranges, true)
    }
    return next
  },
  provide: (f) => EditorView.decorations.from(f)
})

export const errorMarks: Extension = [
  field,
  EditorView.baseTheme({
    '.cm-sql-error-line': { backgroundColor: 'color-mix(in srgb, var(--danger) 12%, transparent)' },
    '.cm-sql-error': { textDecoration: 'underline wavy var(--danger)', textUnderlineOffset: '3px' }
  })
]
