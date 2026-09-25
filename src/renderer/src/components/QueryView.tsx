import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { type EditorView, keymap, Prec } from '@uiw/react-codemirror'
import { sql, MSSQL, MySQL } from '@codemirror/lang-sql'
import type { HistoryEntry, QueryResult } from '@shared/types'
import { findWriteKeyword } from '@shared/sqlGuard'
import { useAppState, type Tab } from '../state'
import { formatCount, formatDuration } from '../lib/format'
import { useColorScheme } from '../lib/useColorScheme'
import { DataGrid, LoadingBar, type Selection } from './DataGrid'
import { RowInspector } from './RowInspector'
import { AskBar } from './AskBar'
import { runFederated, type StepRun } from '../lib/federated'
import type { TranslateResult } from '@shared/nl/translate'

const emptySelection: Selection = { rows: new Set(), active: null }

export function QueryView({ tab, active }: { tab: Extract<Tab, { kind: 'query' }>; active: boolean }) {
  const { connection, tables, loadTables } = useAppState()
  const conn = connection(tab.connectionId)
  const scheme = useColorScheme()
  const [text, setText] = useState(tab.initialSql)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runStarted, setRunStarted] = useState(0)
  /** Cross-database runs: which step is running, and what each step did once finished. */
  const [stepLabel, setStepLabel] = useState<string | null>(null)
  const [stepRuns, setStepRuns] = useState<StepRun[] | null>(null)
  const [, setTick] = useState(0)

  // Re-render every 100ms while a query runs so the elapsed time counts up.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setTick((t) => t + 1), 100)
    return () => clearInterval(id)
  }, [running])
  const [resultIndex, setResultIndex] = useState(0)
  const [selection, setSelection] = useState<Selection>(emptySelection)
  const [editorHeight, setEditorHeight] = useState(220)
  const [showHistory, setShowHistory] = useState(false)
  const [showAsk, setShowAsk] = useState(!tab.initialSql)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    loadTables(tab.connectionId)
  }, [tab.connectionId, loadTables])

  // Table names feed autocompletion; both bare and schema-qualified names are offered.
  const schema = useMemo(() => {
    const out: Record<string, string[]> = {}
    for (const t of tables[tab.connectionId]?.tables ?? []) {
      out[t.name] = []
      out[`${t.schema}.${t.name}`] = []
    }
    return out
  }, [tables, tab.connectionId])

  const execute = useCallback(async (sqlText: string) => {
    const statement = sqlText.trim()
    if (!statement || !conn || running) return

    const keyword = findWriteKeyword(statement)
    if (keyword && !conn.readOnly && conn.env !== 'local') {
      const ok = window.confirm(`This query contains ${keyword} and will run against ${conn.name} (${conn.env.toUpperCase()}).\n\nRun it?`)
      if (!ok) return
    }

    setRunning(true)
    setRunStarted(Date.now())
    setError(null)
    try {
      const r = await window.api.runQuery(tab.connectionId, statement)
      setResult(r)
      setResultIndex(Math.max(0, r.resultSets.length - 1))
      setSelection(emptySelection)
    } catch (e) {
      setError((e as Error).message)
      setResult(null)
    } finally {
      setRunning(false)
    }
  }, [conn, running, tab.connectionId])

  const runAsk = useCallback(async (translated: TranslateResult) => {
    const plan = translated.federated
    if (!plan) {
      setText(translated.sql ?? '')
      setStepRuns(null)
      execute(translated.sql ?? '')
      return
    }
    if (running) return
    setRunning(true)
    setRunStarted(Date.now())
    setError(null)
    setStepRuns(null)
    try {
      const { result: merged, runs } = await runFederated(plan, (step) =>
        setStepLabel(`Step ${step.index} of ${plan.steps.length} · ${step.connectionName}: ${step.description}`))
      setResult(merged)
      setStepRuns(runs)
      setResultIndex(0)
      setSelection(emptySelection)
    } catch (e) {
      setError((e as Error).message)
      setResult(null)
    } finally {
      setRunning(false)
      setStepLabel(null)
    }
  }, [execute, running])

  /** Runs the editor selection if there is one, otherwise the whole editor. */
  const run = useCallback(() => {
    const view = viewRef.current
    const range = view?.state.selection.main
    const selected = view && range && !range.empty ? view.state.sliceDoc(range.from, range.to) : ''
    execute(selected || text)
  }, [execute, text])

  const runKeymap = useMemo(
    () => Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: () => { run(); return true } },
      { key: 'F5', run: () => { run(); return true } }
    ])),
    [run]
  )

  const startResize = (event: React.MouseEvent): void => {
    event.preventDefault()
    const startY = event.clientY
    const start = editorHeight
    const move = (e: MouseEvent): void => setEditorHeight(Math.max(80, Math.min(window.innerHeight - 200, start + e.clientY - startY)))
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  useEffect(() => {
    if (active && !showAsk) viewRef.current?.focus()
    // Only on tab activation; toggling the ask bar shouldn't steal focus.
  }, [active])

  if (!conn) return null
  const set = result?.resultSets[resultIndex]
  const activeRow = set && selection.active !== null ? set.rows[selection.active] : undefined

  return (
    <div className="view">
      <div className="toolbar">
        <button className="primary" onClick={run} disabled={running}>
          {running ? 'Running…' : '▶ Run'}
        </button>
        <span className="muted hint">Ctrl+Enter runs the selection, or everything</span>
        <div className="toolbar-right">
          <button className={`ghost ${showAsk ? 'on' : ''}`} title="Describe a query in plain English" onClick={() => setShowAsk((s) => !s)}>✦ Ask</button>
          <button className={`ghost ${showHistory ? 'on' : ''}`} onClick={() => setShowHistory((s) => !s)}>History</button>
        </div>
      </div>

      <div className="query-body">
        <div className="query-main">
          {showAsk && (
            <AskBar
              connection={conn}
              onRun={runAsk}
              onEdit={(generated) => {
                setText(generated)
                viewRef.current?.focus()
              }}
            />
          )}
          <div className="editor" style={{ height: editorHeight }}>
            <CodeMirror
              value={text}
              height="100%"
              theme={scheme}
              extensions={[sql({ dialect: conn.kind === 'mssql' ? MSSQL : MySQL, schema, upperCaseKeywords: true }), runKeymap]}
              onChange={setText}
              onCreateEditor={(view) => {
                viewRef.current = view
                if (!showAsk) view.focus()
              }}
              basicSetup={{ foldGutter: false, highlightActiveLine: true }}
            />
          </div>
          <div className="splitter" onMouseDown={startResize} />

          {error && <div className="error-bar">{error}</div>}
          {running && !result && (
            <div className="results running">
              <LoadingBar label={`${stepLabel ?? 'Running query'}… ${((Date.now() - runStarted) / 1000).toFixed(1)}s`} overlay={false} />
            </div>
          )}

          {result && (
            <div className="results">
              <div className="result-tabs">
                {result.resultSets.map((s, i) => (
                  <button key={i} className={i === resultIndex ? 'on' : ''} onClick={() => { setResultIndex(i); setSelection(emptySelection) }}>
                    Result {i + 1} <span className="muted">({formatCount(s.rows.length)})</span>
                  </button>
                ))}
                {stepRuns && (
                  <span className="step-runs" title={stepRuns.map((r) => `Step ${r.step.index} · ${r.step.connectionName}: ${r.step.description}`).join('\n')}>
                    {stepRuns.map((r) => (
                      <span key={r.step.index} className="step-run">
                        {r.step.connectionName} <span className="muted">{r.rows.toLocaleString()} · {formatDuration(r.durationMs)}</span>
                      </span>
                    ))}
                  </span>
                )}
                <span className="muted result-meta">
                  {formatDuration(result.durationMs)}
                  {result.resultSets.length === 0 && ` · ${result.rowsAffected.reduce((a, b) => a + b, 0)} rows affected`}
                </span>
              </div>
              {set ? (
                <div className="view-body">
                  <DataGrid
                    loadingLabel={running ? `${stepLabel ?? 'Running query'}… ${((Date.now() - runStarted) / 1000).toFixed(1)}s` : undefined}
                    columns={set.columns}
                    rows={set.rows}
                    selection={selection}
                    onSelectionChange={setSelection}
                    copyTarget={{ kind: conn.kind }}
                  />
                  {activeRow && (
                    <RowInspector kind={conn.kind} columns={set.columns} row={activeRow} onClose={() => setSelection(emptySelection)} />
                  )}
                </div>
              ) : (
                <div className="grid-empty">Query ran with no result set.</div>
              )}
            </div>
          )}
        </div>

        {showHistory && (
          <HistoryPanel
            connectionId={tab.connectionId}
            onPick={(sqlText) => {
              setText(sqlText)
              viewRef.current?.focus()
            }}
          />
        )}
      </div>
    </div>
  )
}

function HistoryPanel({ connectionId, onPick }: { connectionId: string; onPick(sql: string): void }) {
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [search, setSearch] = useState('')
  const [allConnections, setAllConnections] = useState(false)

  useEffect(() => {
    window.api.listHistory().then(setEntries)
  }, [])

  const needle = search.toLowerCase()
  const visible = entries.filter(
    (e) => (allConnections || e.connectionId === connectionId) && (!needle || e.sql.toLowerCase().includes(needle))
  )

  return (
    <aside className="history">
      <header>
        <input className="search" placeholder="Search history…" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        <label className="muted">
          <input type="checkbox" checked={allConnections} onChange={(e) => setAllConnections(e.target.checked)} /> all connections
        </label>
      </header>
      <div className="history-list">
        {visible.map((entry) => (
          <button key={entry.id} className={`history-item ${entry.error ? 'failed' : ''}`} onClick={() => onPick(entry.sql)} title={entry.error}>
            <code>{entry.sql.length > 300 ? `${entry.sql.slice(0, 300)}…` : entry.sql}</code>
            <span className="muted">
              {new Date(entry.ranAt).toLocaleString()} · {formatDuration(entry.durationMs)}{entry.error ? ' · failed' : ''}
            </span>
          </button>
        ))}
        {!visible.length && <div className="muted pad">Nothing yet.</div>}
      </div>
    </aside>
  )
}
