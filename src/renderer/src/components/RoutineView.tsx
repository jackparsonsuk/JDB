import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror'
import { EditorSelection, EditorState } from '@codemirror/state'
import { sql, MSSQL, MySQL } from '@codemirror/lang-sql'
import type { RoutineDefinition, RoutineKind, TableRef } from '@shared/types'
import { callTemplate, ROUTINE_LABELS, routineUses } from '@shared/routines'
import { useAppState, type Tab } from '../state'
import { useColorScheme } from '../lib/theme'
import { useOpenLink } from '../lib/openLink'
import { formatAgo, parseStamp } from '../lib/format'
import { LoadingBar } from './DataGrid'
import { toast } from './Toast'

/** A stored procedure, function or trigger: its source (read-only), parameters and what it touches. */
export function RoutineView({ tab }: { tab: Extract<Tab, { kind: 'routine' }> }) {
  const { connection, tables, loadTables, routines, loadRoutines, openQuery, schemaVersions } = useAppState()
  const conn = connection(tab.connectionId)
  const scheme = useColorScheme()
  const link = useOpenLink()
  const [def, setDef] = useState<RoutineDefinition | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const viewRef = useRef<EditorView | null>(null)
  const version = schemaVersions[tab.connectionId] ?? 0
  const { schema, name, kind } = tab.routine

  useEffect(() => {
    loadTables(tab.connectionId)
    loadRoutines(tab.connectionId)
  }, [tab.connectionId, loadTables, loadRoutines])

  useEffect(() => {
    let live = true
    setLoading(true)
    window.api.describeRoutine(tab.connectionId, { schema, name, kind })
      .then((d) => {
        if (!live) return
        setDef(d)
        setError(null)
      })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [tab.connectionId, schema, name, kind, reloadKey, version])

  const tableList = tables[tab.connectionId]?.tables
  const routineList = routines[tab.connectionId]?.routines
  const uses = useMemo(() => (def?.definition && conn
    ? routineUses(def.definition, conn.kind, tab.routine, tableList ?? [], routineList ?? [])
    : null), [def, conn, tab.routine, tableList, routineList])

  const extensions = useMemo<Extension[]>(() => [
    sql({ dialect: conn?.kind === 'mssql' ? MSSQL : MySQL, upperCaseKeywords: true }),
    EditorState.readOnly.of(true),
    EditorView.lineWrapping
  ], [conn?.kind])

  // Arriving from a source search: select the first match, which also highlights the others.
  const [editorReady, setEditorReady] = useState(false)
  useEffect(() => {
    const view = viewRef.current
    const text = def?.definition
    if (!tab.find || !view || !text || !editorReady) return
    const at = text.toLowerCase().indexOf(tab.find.text.toLowerCase())
    if (at < 0) return
    const end = at + tab.find.text.length
    // Let CodeMirror lay the document out first so scrolling lands in the right place.
    requestAnimationFrame(() => {
      view.dispatch({ selection: EditorSelection.single(at, end), effects: EditorView.scrollIntoView(at, { y: 'center' }) })
      view.focus()
    })
  }, [tab.find, def, editorReady])

  if (!conn) return null
  const label = ROUTINE_LABELS[kind]
  const info = def?.routine
  const lines = def?.definition ? def.definition.split('\n').length : 0
  const template = def ? callTemplate(conn.kind, def) : null
  const modified = formatAgo(info?.modified)
  const tableLink = (table: TableRef) => link({ kind: 'table', connectionId: conn.id, table, filters: [] })

  const copy = async (): Promise<void> => {
    if (!def?.definition) return
    await window.api.copy(def.definition)
    toast(`Copied ${name} (${lines.toLocaleString()} line${lines === 1 ? '' : 's'})`)
  }

  return (
    <div className="view routine">
      <div className="toolbar routine-toolbar">
        <span className={`kind-badge kind-${kind}`}>{label.short}</span>
        <span className="toolbar-title routine-title">
          <span className="muted">{schema}.</span>
          <strong>{name}</strong>
        </span>
        {info?.disabled && <span className="state-pill off" title="This trigger is disabled, so it doesn't fire">disabled</span>}
        {def && (
          <span className="routine-meta muted">
            {info?.detail && kind === 'function' && <span>{info.detail === 'table' ? 'table-valued' : 'scalar'}</span>}
            {modified && <span title={parseStamp(info?.modified)?.toLocaleString()}>changed {modified}</span>}
            {lines > 0 && <span>{lines.toLocaleString()} lines</span>}
          </span>
        )}
        <div className="toolbar-right">
          <button disabled={!def?.definition} onClick={copy} title="Copy the source">Copy</button>
          {template && (
            <button onClick={() => openQuery(conn.id, template)} title={`A query that ${kind === 'procedure' ? 'runs' : 'calls'} this ${label.singular}, with each parameter to fill in`}>
              Script call
            </button>
          )}
          <button disabled={!def?.definition} onClick={() => def?.definition && openQuery(conn.id, def.definition)} title="Open the source in a new query tab">
            Open as query
          </button>
          <button className="icon" title="Reload" onClick={() => setReloadKey((k) => k + 1)}>⟳</button>
        </div>
      </div>

      {error && <div className="error-bar">{error}</div>}
      {loading && !def && <LoadingBar label={`Reading ${name}…`} overlay={false} />}

      {def && (
        <div className="view-body routine-body">
          <div className="routine-source">
            {def.bodyOnly && (
              <div className="routine-note">
                Showing the body only. MySQL shows the full CREATE statement to the {label.singular}'s definer or to users with SHOW_ROUTINE.
              </div>
            )}
            {def.definition ? (
              <CodeMirror
                className="routine-editor"
                value={def.definition}
                height="100%"
                theme={scheme}
                editable
                extensions={extensions}
                onCreateEditor={(view) => {
                  viewRef.current = view
                  setEditorReady(true)
                }}
                basicSetup={{ foldGutter: true, highlightActiveLine: false, highlightActiveLineGutter: false, autocompletion: false }}
              />
            ) : (
              <HiddenSource kind={kind} dialect={conn.kind} />
            )}
          </div>

          <aside className="routine-side">
            {kind === 'trigger' && info?.parent && (
              <Section title="Fires on">
                <button className="use-row" {...tableLink(info.parent)} title={`Open ${info.parent.schema}.${info.parent.name} · drag to a pane`}>
                  <span className="use-icon">▦</span>
                  <span className="use-name"><span className="muted">{info.parent.schema}.</span>{info.parent.name}</span>
                </button>
                {info.detail && <div className="trigger-events">{info.detail.split(/,\s*|\s+(?=INSERT|UPDATE|DELETE)/).filter(Boolean).map((part) => <span key={part} className="event-chip">{part}</span>)}</div>}
              </Section>
            )}

            {kind !== 'trigger' && (
              <Section title="Parameters" count={def.parameters.length}>
                {def.parameters.length ? (
                  <div className="param-list">
                    {def.parameters.map((p) => (
                      <div key={p.name} className="param-row">
                        <span className="param-name">{p.name}</span>
                        <span className="param-type">{p.dataType}</span>
                        {p.mode !== 'IN' && <span className={`param-mode mode-${p.mode.toLowerCase()}`}>{p.mode === 'INOUT' && conn.kind === 'mssql' ? 'OUTPUT' : p.mode}</span>}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="side-empty">None</div>
                )}
              </Section>
            )}

            {def.returns && (
              <Section title="Returns">
                <div className="param-row"><span className="param-type strong">{def.returns === 'TABLE' ? 'a table' : def.returns}</span></div>
              </Section>
            )}

            {uses && (
              <Section title="Tables" count={uses.tables.length}>
                {uses.tables.length ? uses.tables.map((u) => (
                  <button key={`${u.table.schema}.${u.table.name}`} className="use-row" {...tableLink(u.table)} title={`Open ${u.table.schema}.${u.table.name} · Shift+click opens beside · drag to a pane`}>
                    <span className="use-icon">▦</span>
                    <span className="use-name"><span className="muted">{u.table.schema}.</span>{u.table.name}</span>
                    {u.writes && <span className="use-tag writes">writes</span>}
                    {u.reads && !u.writes && <span className="use-tag reads">reads</span>}
                  </button>
                )) : <div className="side-empty">No tables found in the source</div>}
              </Section>
            )}

            {uses && uses.calls.length > 0 && (
              <Section title="Calls" count={uses.calls.length}>
                {uses.calls.map((r) => (
                  <button key={`${r.schema}.${r.name}`} className="use-row" {...link({ kind: 'routine', connectionId: conn.id, routine: r })}>
                    <span className={`kind-dot kind-${r.kind}`} />
                    <span className="use-name"><span className="muted">{r.schema}.</span>{r.name}</span>
                  </button>
                ))}
              </Section>
            )}

            <Section title="Details">
              <dl className="routine-facts">
                <dt>Type</dt><dd>{label.singular}{info?.detail && kind === 'function' ? ` (${info.detail === 'table' ? 'table-valued' : 'scalar'})` : ''}</dd>
                {def.created && <><dt>Created</dt><dd>{parseStamp(def.created)?.toLocaleString() ?? def.created}</dd></>}
                {info?.modified && <><dt>{kind === 'trigger' && conn.kind === 'mysql' ? 'Created' : 'Changed'}</dt><dd>{parseStamp(info.modified)?.toLocaleString() ?? info.modified}</dd></>}
              </dl>
              {uses && <div className="side-hint muted">Tables and calls are read from the source, so dynamic SQL isn't covered.</div>}
            </Section>
          </aside>
        </div>
      )}
    </div>
  )
}

function Section({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="side-section">
      <h4>{title}{count !== undefined && count > 0 && <span className="side-count">{count}</span>}</h4>
      {children}
    </section>
  )
}

function HiddenSource({ kind, dialect }: { kind: RoutineKind; dialect: 'mssql' | 'mysql' }) {
  const noun = ROUTINE_LABELS[kind].singular
  return (
    <div className="hidden-source">
      <div className="hidden-card">
        <div className="hidden-icon">🔒</div>
        <h3>Source hidden</h3>
        <p>
          This login can see that the {noun} exists, but not its source.{' '}
          {dialect === 'mssql'
            ? <>SQL Server shows it to users with <code>VIEW DEFINITION</code> on the {noun}, its schema or the database.</>
            : <>MySQL shows it to the {noun}'s definer, or to users with <code>SHOW_ROUTINE</code>.</>}
        </p>
        {dialect === 'mssql' && <pre className="grant">GRANT VIEW DEFINITION TO [your login]</pre>}
      </div>
    </div>
  )
}
