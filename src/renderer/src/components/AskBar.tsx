import { useMemo, useState, type KeyboardEvent, type ReactElement } from 'react'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { sql, MSSQL, MySQL } from '@codemirror/lang-sql'
import type { ConnectionConfig } from '@shared/types'
import type { Span, TranslateResult } from '@shared/nl/translate'
import { linkedConnections, useNl } from '../lib/useNl'
import { useAppState } from '../state'
import { QueryDiagram } from './QueryDiagram'
import { useEditorTheme } from '../lib/editorTheme'

const VIEW_KEY = 'jdb.askView'

function savedView(): 'sql' | 'diagram' {
  try {
    return localStorage.getItem(VIEW_KEY) === 'diagram' ? 'diagram' : 'sql'
  } catch {
    return 'sql'
  }
}

const EXAMPLES = [
  'invoices created after 12/12/2025',
  'orders this week sorted by total',
  'customers with documents',
  'how many orders by status',
  'latest 10 invoices'
]

interface Props {
  connection: ConnectionConfig
  /** Runs the translated query: plain SQL, or a cross-database plan. */
  onRun(result: TranslateResult): void
  /** Copies the generated SQL into the editor without running it. */
  onEdit(sql: string): void
}

export function AskBar({ connection, onRun, onEdit }: Props) {
  const { links, connections, tables } = useAppState()
  const [text, setText] = useState('')
  const [view, setView] = useState<'sql' | 'diagram'>(savedView)
  const editorTheme = useEditorTheme()
  // Linked databases are only queried once connected this session, so asking never triggers a sign-in.
  const connected = useMemo(() => new Set(Object.entries(tables).filter(([, t]) => t.status === 'ready').map(([id]) => id)), [tables])
  const linked = useMemo(() => linkedConnections(connection.id, links, connections, connected), [connection.id, links, connections, connected])
  const { result, loading, error } = useNl(connection, linked.ready, text)
  const generated = result?.sql ?? ''
  const kind = connection.kind

  const chooseView = (next: 'sql' | 'diagram'): void => {
    setView(next)
    try {
      localStorage.setItem(VIEW_KEY, next)
    } catch {
      // Storage can be unavailable; the choice just won't persist.
    }
  }

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && result?.sql) {
      e.preventDefault()
      onRun(result)
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
        {linked.notConnected.length > 0 && (
          <div className="ask-linked muted small">
            Linked to {linked.notConnected.map((c) => c.name).join(', ')}. Open {linked.notConnected.length === 1 ? 'it' : 'them'} in the sidebar to ask across databases.
          </div>
        )}
        {linked.ready.length > 0 && (
          <div className="ask-linked small">🔗 Can also use linked tables in {linked.ready.map((c) => c.name).join(', ')}</div>
        )}
        {result && result.notes.length > 0 && (
          <ul className="ask-notes">
            {result.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}
      </div>

      <div className="ask-right">
        <div className="ask-view-tabs">
          <button className={view === 'sql' ? 'on' : ''} onClick={() => chooseView('sql')}>SQL</button>
          <button className={view === 'diagram' ? 'on' : ''} onClick={() => chooseView('diagram')}>Diagram</button>
        </div>
        {view === 'sql' ? (
          <div className="ask-sql">
            {generated ? (
              <CodeMirror
                value={generated}
                theme={editorTheme}
                editable={false}
                basicSetup={{ lineNumbers: false, foldGutter: false, highlightActiveLine: false }}
                extensions={[sql({ dialect: kind === 'mssql' ? MSSQL : MySQL }), EditorView.lineWrapping]}
              />
            ) : (
              <div className="muted ask-placeholder">The SQL appears here as you type.</div>
            )}
          </div>
        ) : (
          <div className="ask-diagram">
            {result?.plan ? (
              <QueryDiagram plan={result.plan} onSuggest={(phrase) => setText((t) => `${t.trimEnd()} ${phrase}`)} />
            ) : (
              <div className="muted ask-placeholder">Tables and how they connect appear here as you type.</div>
            )}
          </div>
        )}
        <div className="ask-actions">
          {result?.federated && <span className="muted small ask-steps">Runs as {result.federated.steps.length} steps across databases</span>}
          <button className="primary" disabled={!generated} onClick={() => result && onRun(result)}>▶ Run <kbd>Enter</kbd></button>
          <button
            disabled={!generated || !!result?.federated}
            title={result?.federated ? "Cross-database queries run as linked steps, so they can't be edited as one SQL statement yet" : undefined}
            onClick={() => onEdit(generated)}
          >
            Edit in editor
          </button>
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
