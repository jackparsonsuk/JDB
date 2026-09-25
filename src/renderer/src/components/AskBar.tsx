import { useState, type KeyboardEvent, type ReactElement } from 'react'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { sql, MSSQL, MySQL } from '@codemirror/lang-sql'
import type { DbKind } from '@shared/types'
import type { Span } from '@shared/nl/translate'
import { useNl } from '../lib/useNl'
import { useColorScheme } from '../lib/useColorScheme'

const EXAMPLES = [
  'invoices created after 12/12/2025',
  'orders this week sorted by total',
  'customers with documents',
  'how many orders by status',
  'latest 10 invoices'
]

interface Props {
  connectionId: string
  kind: DbKind
  /** Runs the generated SQL (and shows it in the editor). */
  onRun(sql: string): void
  /** Copies the generated SQL into the editor without running it. */
  onEdit(sql: string): void
}

export function AskBar({ connectionId, kind, onRun, onEdit }: Props) {
  const [text, setText] = useState('')
  const scheme = useColorScheme()
  const { result, loading, error } = useNl(connectionId, kind, text)
  const generated = result?.sql ?? ''

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && generated) {
      e.preventDefault()
      onRun(generated)
    }
  }

  return (
    <div className="ask">
      <div className="ask-left">
        <input
          className="ask-input"
          autoFocus
          placeholder={loading ? 'Reading schema…' : 'Describe what you want to see, e.g. invoices created this month'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
        />
        <div className="ask-reading">
          {error && <span className="nl-unknown">Couldn't read the schema: {error}</span>}
          {!text && !error && (
            <span className="muted">
              Try:{' '}
              {EXAMPLES.map((ex) => (
                <button key={ex} className="link ask-example" onClick={() => setText(ex)}>{ex}</button>
              ))}
            </span>
          )}
          {result && <Reading text={text} spans={result.spans} />}
        </div>
        {result && result.notes.length > 0 && (
          <ul className="ask-notes">
            {result.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}
      </div>

      <div className="ask-right">
        <div className="ask-sql">
          {generated ? (
            <CodeMirror
              value={generated}
              theme={scheme}
              editable={false}
              basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
              extensions={[sql({ dialect: kind === 'mssql' ? MSSQL : MySQL }), EditorView.lineWrapping]}
            />
          ) : (
            <div className="muted ask-placeholder">The SQL appears here as you type.</div>
          )}
        </div>
        <div className="ask-actions">
          <button className="primary" disabled={!generated} onClick={() => onRun(generated)}>▶ Run <kbd>Enter</kbd></button>
          <button disabled={!generated} onClick={() => onEdit(generated)}>Edit in editor</button>
        </div>
      </div>
    </div>
  )
}

const ROLE_LABELS: Record<Span['role'], string> = {
  table: 'table',
  column: 'column',
  value: 'value',
  date: 'date',
  keyword: 'instruction',
  filler: 'ignored',
  unknown: 'not understood'
}

/** Echoes the request with each word coloured by what it matched; hover for detail. */
function Reading({ text, spans }: { text: string; spans: Span[] }) {
  const parts: ReactElement[] = []
  let cursor = 0
  spans.forEach((span, i) => {
    if (span.start > cursor) parts.push(<span key={`gap${i}`}>{text.slice(cursor, span.start)}</span>)
    parts.push(
      <span key={i} className={`nl-${span.role}`} title={`${ROLE_LABELS[span.role]}${span.detail ? `: ${span.detail}` : ''}`}>
        {text.slice(span.start, span.end)}
      </span>
    )
    cursor = span.end
  })
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>)
  return <span className="ask-echo">{parts}</span>
}
