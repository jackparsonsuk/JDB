import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import type { SavedQuery } from '@shared/types'

/** How much of a saved query's SQL shows beside its completion. */
const PREVIEW_CHARS = 400

/**
 * Offers saved queries by name while typing in the SQL editor: those for any connection (snippets)
 * and those saved for this one. Picking one inserts its SQL in place of the typed name.
 */
export function snippetCompletions(queries: SavedQuery[], connectionId: string): CompletionSource {
  const usable = queries.filter((q) => !q.connectionId || q.connectionId === connectionId)
  return (context: CompletionContext): CompletionResult | null => {
    if (!usable.length) return null
    const word = context.matchBefore(/[\w$#@-]+/)
    // Only after a couple of letters, or when asked for (Ctrl+Space), so it doesn't crowd column names.
    if (!word || (word.to - word.from < 2 && !context.explicit)) return null
    return {
      from: word.from,
      options: usable.map((q) => ({
        label: q.name,
        detail: q.connectionId ? 'saved query' : 'snippet',
        type: 'text',
        // Below columns and tables with the same letters.
        boost: -20,
        info: () => {
          const el = document.createElement('div')
          el.className = 'snippet-info'
          if (q.description) {
            const note = document.createElement('div')
            note.className = 'snippet-note'
            note.textContent = q.description
            el.appendChild(note)
          }
          const pre = document.createElement('pre')
          pre.textContent = q.sql.length > PREVIEW_CHARS ? `${q.sql.slice(0, PREVIEW_CHARS)}…` : q.sql
          el.appendChild(pre)
          return el
        },
        // A name can have spaces ("Open jobs"), so replace as much of it as was typed, not just the last word.
        apply: (view, _completion, from, to) => {
          const line = view.state.doc.lineAt(to)
          const before = view.state.sliceDoc(line.from, to).toLowerCase()
          const name = q.name.toLowerCase()
          let start = from
          for (let n = Math.min(name.length, before.length); n > to - from; n--) {
            if (before.endsWith(name.slice(0, n)) && (n === before.length || /\s/.test(before[before.length - n - 1]))) {
              start = to - n
              break
            }
          }
          view.dispatch({ changes: { from: start, to, insert: q.sql }, selection: { anchor: start + q.sql.length } })
        }
      }))
    }
  }
}
