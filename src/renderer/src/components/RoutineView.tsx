import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useClickableNames } from '../lib/clickableNames'
import CodeMirror, { EditorView, type Extension } from '@uiw/react-codemirror'
import { EditorSelection, EditorState } from '@codemirror/state'
import { sql, MSSQL, MySQL } from '@codemirror/lang-sql'
import type { ConnectionConfig, RoutineDefinition, RoutineKind, TableRef } from '@shared/types'
import { callTemplate, findInSource, ROUTINE_LABELS, routineUses, type RoutineUses } from '@shared/routines'
import { layoutSql, type OutlineItem } from '@shared/sqlLayout'
import { useAppState, type Tab } from '../state'
import { useColorScheme } from '../lib/theme'
import { useAppearance } from '../lib/appearance'
import { useOpenLink } from '../lib/openLink'
import { formatAgo, parseStamp } from '../lib/format'
import { EFFECT_KINDS, effectMarkers } from '../lib/routineEditor'
import { LoadingBar } from './DataGrid'
import { toast } from './Toast'

const FORMAT_KEY = 'jdb.routine.formatted'
const SIDE_KEY = 'jdb.routine.side'

function readSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Only a view preference; the default is fine.
  }
}

type Side = 'outline' | 'overview'

/** A stored procedure, function or trigger: its source (read-only), an outline of it, and what it touches. */
export function RoutineView({ tab }: { tab: Extract<Tab, { kind: 'routine' }> }) {
  const { connection, tables, loadTables, routines, loadRoutines, openQuery, schemaVersions } = useAppState()
  const conn = connection(tab.connectionId)
  const scheme = useColorScheme()
  const [def, setDef] = useState<RoutineDefinition | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [formatted, setFormattedState] = useState(() => readSetting(FORMAT_KEY, '1') === '1')
  const [side, setSideState] = useState<Side>(() => (readSetting(SIDE_KEY, 'outline') === 'overview' ? 'overview' : 'outline'))
  const [cursorLine, setCursorLine] = useState(1)
  const viewRef = useRef<EditorView | null>(null)
  const version = schemaVersions[tab.connectionId] ?? 0
  const { schema, name, kind } = tab.routine

  const setFormatted = (next: boolean): void => {
    setFormattedState(next)
    writeSetting(FORMAT_KEY, next ? '1' : '0')
  }
  const setSide = (next: Side): void => {
    setSideState(next)
    writeSetting(SIDE_KEY, next)
  }

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

  const { lowerKeywords } = useAppearance()
  const layout = useMemo(() => (def?.definition && conn ? layoutSql(def.definition, conn.kind, formatted, !!lowerKeywords) : null), [def, conn, formatted, lowerKeywords])
  // Ctrl+click a table or routine in the source to open it; unqualified names are this routine's schema's (or dbo's).
  const nameDefaults = useMemo(() => (conn?.kind === 'mssql' ? [schema, 'dbo'] : [schema]), [conn?.kind, schema])
  const names = useClickableNames(tab.connectionId, tab.pane, conn?.kind, nameDefaults)
  const shown = layout?.text ?? def?.definition ?? null

  const extensions = useMemo<Extension[]>(() => [
    sql({ dialect: conn?.kind === 'mssql' ? MSSQL : MySQL, upperCaseKeywords: true }),
    EditorState.readOnly.of(true),
    EditorView.lineWrapping,
    names,
    effectMarkers(layout?.outline ?? []),
    EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) setCursorLine(update.state.doc.lineAt(update.state.selection.main.head).number)
    })
  ], [conn?.kind, layout, names])

  const jumpTo = useCallback((line: number) => {
    const view = viewRef.current
    if (!view || line > view.state.doc.lines) return
    const target = view.state.doc.line(line)
    view.dispatch({ selection: EditorSelection.single(target.from, target.to), effects: EditorView.scrollIntoView(target.from, { y: 'center' }) })
    view.focus()
  }, [])

  // Arriving from a source search: select the first match, which also highlights the others.
  const [editorReady, setEditorReady] = useState(false)
  useEffect(() => {
    const view = viewRef.current
    if (!tab.find || !view || !shown || !editorReady) return
    // Formatting changes spacing, so match whatever whitespace sits between the words.
    const hit = findInSource(shown, tab.find.text)
    if (!hit) return
    const { from: at, to: end } = hit
    // Let CodeMirror lay the document out first so scrolling lands in the right place.
    requestAnimationFrame(() => {
      view.dispatch({ selection: EditorSelection.single(at, end), effects: EditorView.scrollIntoView(at, { y: 'center' }) })
      view.focus()
    })
    // Only when asked (tab.find changes), not every time the view switches layout.
  }, [tab.find, def, editorReady])

  if (!conn) return null
  const label = ROUTINE_LABELS[kind]
  const info = def?.routine
  const lines = shown ? shown.split('\n').length : 0
  const template = def ? callTemplate(conn.kind, def) : null
  const modified = formatAgo(info?.modified)
  const outline = layout?.outline ?? []

  const copy = async (): Promise<void> => {
    if (!shown) return
    await window.api.copy(shown)
    toast(`Copied ${name}${layout?.formatted ? ' (formatted)' : ''}`)
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
          {def?.definition && (
            <div className="segmented" role="tablist" title="Formatted lays the source out for reading; only spacing and keyword case change">
              <button role="tab" className={formatted ? 'on' : ''} onClick={() => setFormatted(true)}>Formatted</button>
              <button role="tab" className={!formatted ? 'on' : ''} onClick={() => setFormatted(false)}>As written</button>
            </div>
          )}
          <button disabled={!shown} onClick={copy} title="Copy the source as shown">Copy</button>
          {template && (
            <button onClick={() => openQuery(conn.id, template)} title={`A query that ${kind === 'procedure' ? 'runs' : 'calls'} this ${label.singular}, with each parameter to fill in`}>
              Script call
            </button>
          )}
          <button disabled={!shown} onClick={() => shown && openQuery(conn.id, shown)} title="Open the source as shown in a new query tab">
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
            {layout?.problem && <div className="routine-note">{layout.problem}</div>}
            {shown ? (
              <CodeMirror
                className="routine-editor"
                value={shown}
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
            <div className="side-tabs" role="tablist">
              <button role="tab" className={side === 'outline' && shown ? 'on' : ''} onClick={() => setSide('outline')} disabled={!shown}>
                Outline {outline.length > 0 && <span className="side-count">{outline.length}</span>}
              </button>
              <button role="tab" className={side === 'overview' || !shown ? 'on' : ''} onClick={() => setSide('overview')}>Overview</button>
            </div>
            <div className="side-scroll">
              {side === 'outline' && shown
                ? <Outline items={outline} cursorLine={cursorLine} onJump={jumpTo} />
                : <Overview def={def} conn={conn} uses={uses} />}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}

const OUTLINE_ICONS: Record<OutlineItem['kind'], string> = {
  control: '◆',
  read: '○',
  write: '●',
  temp: '◐',
  call: '↗',
  tx: '⇄',
  error: '!',
  return: '↩',
  cursor: '⟳',
  comment: '#'
}

/** The routine's structure: control flow, statements and headings, clickable to jump to them. */
function Outline({ items, cursorLine, onJump }: { items: OutlineItem[]; cursorLine: number; onJump(line: number): void }) {
  const [changesOnly, setChangesOnly] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const counts = useMemo(() => {
    const c = { write: 0, call: 0, tx: 0 }
    for (const item of items) {
      if (item.kind === 'write' || item.kind === 'temp') c.write++
      else if (item.kind === 'call') c.call++
      else if (item.kind === 'tx') c.tx++
    }
    return c
  }, [items])
  const visible = changesOnly ? items.filter((i) => EFFECT_KINDS.has(i.kind)) : items
  // The entry the cursor is in: the last one starting at or above its line.
  let active = -1
  for (let i = 0; i < visible.length; i++) if (visible[i].line <= cursorLine) active = i

  useEffect(() => {
    const el = listRef.current?.querySelector('.outline-row.on')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!items.length) return <div className="side-empty pad-side">Nothing to outline.</div>
  const parts = [
    counts.write && `${counts.write} write${counts.write === 1 ? '' : 's'}`,
    counts.call && `${counts.call} call${counts.call === 1 ? '' : 's'}`,
    counts.tx && `${counts.tx} transaction step${counts.tx === 1 ? '' : 's'}`
  ].filter(Boolean)

  return (
    <div className="outline">
      <div className="outline-head">
        <span className="outline-summary">{parts.length ? parts.join(' · ') : 'Reads only'}</span>
        <div className="segmented small">
          <button className={!changesOnly ? 'on' : ''} onClick={() => setChangesOnly(false)}>All</button>
          <button className={changesOnly ? 'on' : ''} onClick={() => setChangesOnly(true)} title="Only lines that write, call, raise errors or control transactions">Changes</button>
        </div>
      </div>
      <div className="outline-list" ref={listRef}>
        {visible.map((item, i) => {
          const [verb, ...rest] = item.kind === 'comment' ? [item.label] : item.label.split(' ')
          return (
            <button
              key={`${item.line}:${i}`}
              className={`outline-row kind-${item.kind} ${i === active ? 'on' : ''}`}
              style={{ paddingLeft: 10 + Math.min(item.depth, 8) * 14 }}
              onClick={() => onJump(item.line)}
              title={`Line ${item.line}: ${item.label}`}
            >
              {Array.from({ length: Math.min(item.depth, 8) }, (_, d) => <span key={d} className="outline-guide" style={{ left: 16 + d * 14 }} />)}
              <span className="outline-icon">{OUTLINE_ICONS[item.kind]}</span>
              <span className="outline-label">
                {item.kind === 'comment' ? verb : <><span className="outline-verb">{verb}</span>{rest.length > 0 && ` ${rest.join(' ')}`}</>}
              </span>
              <span className="outline-line">{item.line}</span>
            </button>
          )
        })}
        {!visible.length && <div className="side-empty pad-side">Nothing here writes, calls or controls transactions.</div>}
      </div>
    </div>
  )
}

function Overview({ def, conn, uses }: { def: RoutineDefinition; conn: ConnectionConfig; uses: RoutineUses | null }) {
  const link = useOpenLink()
  const info = def.routine
  const kind = info.kind
  const label = ROUTINE_LABELS[kind]
  const tableLink = (table: TableRef) => link({ kind: 'table', connectionId: conn.id, table, filters: [] })
  return (
    <>
      {kind === 'trigger' && info.parent && (
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
          <dt>Type</dt><dd>{label.singular}{info.detail && kind === 'function' ? ` (${info.detail === 'table' ? 'table-valued' : 'scalar'})` : ''}</dd>
          {def.created && <><dt>Created</dt><dd>{parseStamp(def.created)?.toLocaleString() ?? def.created}</dd></>}
          {info.modified && <><dt>{kind === 'trigger' && conn.kind === 'mysql' ? 'Created' : 'Changed'}</dt><dd>{parseStamp(info.modified)?.toLocaleString() ?? info.modified}</dd></>}
        </dl>
        {uses && <div className="side-hint muted">Tables and calls are read from the source, so dynamic SQL isn't covered. Ctrl+click a name in the source to open it (Shift as well: beside).</div>}
      </Section>
    </>
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
