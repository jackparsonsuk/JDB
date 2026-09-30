import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EditorView } from '@uiw/react-codemirror'
import { toggleComment } from '@codemirror/commands'
import { statementAt } from '@shared/sqlComplete'

/** The statement around the cursor, trimmed, with where it sits in the document. */
export function statementUnderCursor(view: EditorView): { text: string; from: number; to: number } | null {
  const doc = view.state.doc.toString()
  const { text, offset } = statementAt(doc, view.state.selection.main.head)
  const lead = text.length - text.trimStart().length
  const trimmed = text.trim()
  return trimmed ? { text: trimmed, from: offset + lead, to: offset + lead + trimmed.length } : null
}

/** The SQL editor's right-click menu. */
export function EditorMenu({ x, y, view, running, onRun, onFormat, onSave, onClose }: {
  x: number
  y: number
  view: EditorView
  running: boolean
  onRun(sql: string): void
  onFormat(): void
  onSave(): void
  onClose(): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  // Keep the menu on screen when opened near an edge.
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setPosition({ left: Math.min(x, window.innerWidth - el.offsetWidth - 8), top: Math.min(y, window.innerHeight - el.offsetHeight - 8) })
  }, [x, y])

  const range = view.state.selection.main
  const selected = range.empty ? '' : view.state.sliceDoc(range.from, range.to)
  const statement = statementUnderCursor(view)
  const all = view.state.doc.toString()

  const act = (run: () => void) => (): void => {
    onClose()
    run()
    view.focus()
  }
  const replaceSelection = (text: string): void => view.dispatch(view.state.replaceSelection(text))

  return (
    <div ref={ref} className="menu editor-menu" style={position} onMouseDown={(e) => e.stopPropagation()}>
      <button disabled={running || !selected.trim()} onClick={act(() => onRun(selected))}>Run selection<kbd>Ctrl+Enter</kbd></button>
      <button
        disabled={running || !statement}
        title={statement ? statement.text.slice(0, 300) : undefined}
        onClick={act(() => {
          if (!statement) return
          view.dispatch({ selection: { anchor: statement.from, head: statement.to } })
          onRun(statement.text)
        })}
      >
        Run statement at cursor<kbd>Ctrl+Shift+Enter</kbd>
      </button>
      <button disabled={running || !all.trim()} onClick={act(() => onRun(all))}>Run all</button>
      <div className="menu-sep" />
      <button disabled={!selected} onClick={act(() => { window.api.copy(selected); replaceSelection('') })}>Cut<kbd>Ctrl+X</kbd></button>
      <button disabled={!selected} onClick={act(() => window.api.copy(selected))}>Copy<kbd>Ctrl+C</kbd></button>
      <button onClick={act(() => window.api.pasteText().then((text) => { if (text) replaceSelection(text) }))}>Paste<kbd>Ctrl+V</kbd></button>
      <button onClick={act(() => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }))}>Select all<kbd>Ctrl+A</kbd></button>
      <div className="menu-sep" />
      <button onClick={act(() => toggleComment(view))}>Toggle comment<kbd>Ctrl+/</kbd></button>
      <button disabled={!all.trim()} onClick={act(onFormat)}>Format SQL<kbd>Shift+Alt+F</kbd></button>
      <button disabled={!all.trim()} onClick={act(onSave)}>Save query<kbd>Ctrl+S</kbd></button>
    </div>
  )
}
