import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { type EditorView, type Extension, keymap, Prec } from '@uiw/react-codemirror'
import { sql, MSSQL, MySQL } from '@codemirror/lang-sql'
import { acceptCompletion } from '@codemirror/autocomplete'
import type { HistoryEntry, QueryResult } from '@shared/types'
import { findWriteKeyword } from '@shared/sqlGuard'
import { useAppState, useCloseWarning, type Tab } from '../state'
import { formatCount, formatDuration } from '../lib/format'
import { useColorScheme } from '../lib/theme'
import { DataGrid, LoadingBar, type Selection } from './DataGrid'
import { RowInspector } from './RowInspector'
import { AskBar } from './AskBar'
import { runFederated, type StepRun } from '../lib/federated'
import type { TranslateResult } from '@shared/nl/translate'
import type { Model } from '@shared/nl/model'
import { localModel } from '../lib/useNl'
import { sqlAssist, sqlNamespace } from '../lib/sqlAssist'
import { runExport } from '../lib/exporting'
import { stagedChanges, useTransaction } from '../lib/useTransaction'
import { TransactionBar } from './TransactionBar'
import { toast } from './Toast'
import { snippetCompletions } from '../lib/snippets'
import { SaveQueryDialog } from './SaveQueryDialog'
import { WriteConfirmDialog } from './WriteConfirmDialog'
import { confirm } from './Confirm'

const emptySelection: Selection = { rows: new Set(), active: null }

/** `active`: the tab is showing in its pane; `focused`: and that pane has the keyboard. */
export function QueryView({ tab, active, focused }: { tab: Extract<Tab, { kind: 'query' }>; active: boolean; focused: boolean }) {
  const { connection, tables, loadTables, rememberTab, savedQueries, saveQuery, linkQueryTab, setTabUnsaved } = useAppState()
  const conn = connection(tab.connectionId)
  const scheme = useColorScheme()
  const [text, setText] = useState(tab.initialSql)
  const savedQuery = tab.savedId ? savedQueries.find((q) => q.id === tab.savedId) : undefined
  const unsaved = !!savedQuery && text !== savedQuery.sql
  const [saving, setSaving] = useState(false)
  /** A write waiting for the user to confirm it in WriteConfirmDialog. */
  const [pendingWrite, setPendingWrite] = useState<{ sql: string; keyword: string } | null>(null)
  const [saveDialog, setSaveDialog] = useState(false)
  useEffect(() => {
    setTabUnsaved(tab.id, unsaved)
  }, [tab.id, unsaved, setTabUnsaved])
  useEffect(() => () => setTabUnsaved(tab.id, false), [tab.id, setTabUnsaved])
  const firstText = useRef(true)
  useEffect(() => {
    if (firstText.current) firstText.current = false
    else rememberTab(tab.id, { sql: text })
  }, [tab.id, text, rememberTab])
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
  const txn = useTransaction(tab.connectionId)
  const staged = txn.tx ? stagedChanges(txn.tx).statements : 0
  // One warning per tab: an open transaction matters more than unsaved edits to a saved query.
  useCloseWarning(tab.id, txn.tx && conn
    ? `A transaction is open on ${conn.name}. Closing the tab rolls it back${staged ? `, discarding ${staged} staged change${staged === 1 ? '' : 's'}` : ''}.`
    : unsaved && savedQuery
      ? `Changes to the saved query "${savedQuery.name}" aren't saved.`
      : null)
  /** The run in flight, so Cancel can stop it on the server. */
  const runRef = useRef<{ id: string; controller: AbortController } | null>(null)

  const startRun = (): { id: string; signal: AbortSignal } => {
    const current = { id: crypto.randomUUID(), controller: new AbortController() }
    runRef.current = current
    setRunning(true)
    setRunStarted(Date.now())
    setError(null)
    return { id: current.id, signal: current.controller.signal }
  }

  const cancel = useCallback(() => {
    const current = runRef.current
    if (!current || current.controller.signal.aborted) return
    current.controller.abort()
    window.api.cancelQuery(current.id).catch(() => undefined)
  }, [])

  // Esc cancels from anywhere in the tab, as long as something is running.
  useEffect(() => {
    if (!running || !focused) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [running, focused, cancel])

  useEffect(() => {
    loadTables(tab.connectionId)
  }, [tab.connectionId, loadTables])

  // The full schema (columns and keys) feeds autocompletion once it has loaded; until then, table names only.
  const [model, setModel] = useState<Model | null>(null)
  useEffect(() => {
    if (!conn) return
    let live = true
    localModel(conn).then((m) => live && setModel(m), () => undefined)
    return () => { live = false }
  }, [conn])
  const tableList = tables[tab.connectionId]?.tables
  const language = useMemo(() => {
    const dialect = conn?.kind === 'mssql' ? MSSQL : MySQL
    const { schema, defaultSchema } = sqlNamespace(tableList ?? [], model)
    const extensions: Extension[] = [sql({ dialect, schema, defaultSchema, upperCaseKeywords: true })]
    if (model) extensions.push(dialect.language.data.of({ autocomplete: sqlAssist(model) }))
    if (conn) extensions.push(dialect.language.data.of({ autocomplete: snippetCompletions(savedQueries, conn.id) }))
    return extensions
  }, [conn?.kind, conn?.id, tableList, model, savedQueries])

  /** `confirmed`: the user has already agreed to this write in WriteConfirmDialog. */
  const execute = useCallback(async (sqlText: string, confirmed = false) => {
    const statement = sqlText.trim()
    if (!statement || !conn || running) return

    const keyword = findWriteKeyword(statement)
    // Writes on prod are staged in a transaction, so the commit is the confirmation.
    const stage = !!keyword && !conn.readOnly && conn.env === 'prod' && !txn.idRef.current
    if (keyword && !conn.readOnly && conn.env !== 'local' && !stage && !txn.idRef.current && !confirmed) {
      // Asks, saying how many rows it would touch; Run calls back here with confirmed.
      setPendingWrite({ sql: statement, keyword })
      return
    }

    const { id } = startRun()
    let transactionId = txn.idRef.current
    try {
      if (stage) transactionId = await txn.begin()
      const r = await window.api.runQuery(tab.connectionId, statement, id, transactionId ?? undefined)
      setResult(r)
      setResultIndex(Math.max(0, r.resultSets.length - 1))
      setSelection(emptySelection)
      if (transactionId) {
        txn.record({ sql: statement, write: !!keyword, rowsAffected: r.rowsAffected.reduce((a, b) => a + b, 0), durationMs: r.durationMs })
      }
    } catch (e) {
      let message = (e as Error).message
      if (transactionId) {
        txn.record({ sql: statement, write: !!keyword, rowsAffected: 0, durationMs: 0, error: message })
        if (!(await txn.stillOpen())) message += '\n\nThe server rolled back the transaction, so none of its changes were kept.'
      }
      setError(message)
      setResult(null)
    } finally {
      runRef.current = null
      setRunning(false)
    }
  }, [conn, running, tab.connectionId, txn])

  const commit = useCallback(async () => {
    if (!conn || !txn.tx) return
    const { statements, rows } = stagedChanges(txn.tx)
    if (conn.env === 'prod' && statements > 0) {
      const ok = await confirm({
        title: `Commit to ${conn.name}?`,
        message: <>This makes {statements} change{statements === 1 ? '' : 's'} permanent on <strong>production</strong>: {formatCount(rows)} row{rows === 1 ? '' : 's'} affected.</>,
        confirmLabel: 'Commit',
        cancelLabel: 'Not yet',
        tone: 'danger'
      })
      if (!ok) return
    }
    setError(null)
    try {
      await txn.commit()
      toast('Committed')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [conn, txn])

  const rollback = useCallback(async () => {
    setError(null)
    try {
      await txn.rollback()
      toast('Rolled back')
    } catch (e) {
      setError((e as Error).message)
    }
  }, [txn])

  const beginTransaction = useCallback(async () => {
    setError(null)
    try {
      await txn.begin()
    } catch (e) {
      setError((e as Error).message)
    }
  }, [txn])

  const runAsk = useCallback(async (translated: TranslateResult) => {
    const plan = translated.federated
    if (!plan) {
      setText(translated.sql ?? '')
      setStepRuns(null)
      execute(translated.sql ?? '')
      return
    }
    if (running) return
    const current = startRun()
    setStepRuns(null)
    try {
      const { result: merged, runs } = await runFederated(plan, (step) =>
        setStepLabel(`Step ${step.index} of ${plan.steps.length} · ${step.connectionName}: ${step.description}`), current)
      setResult(merged)
      setStepRuns(runs)
      setResultIndex(0)
      setSelection(emptySelection)
    } catch (e) {
      setError((e as Error).message)
      setResult(null)
    } finally {
      runRef.current = null
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

  /** Ctrl+S: updates the saved query this tab holds, or asks for a name for a new one. */
  const save = useCallback(async () => {
    if (!savedQuery || !unsaved) {
      setSaveDialog(true)
      return
    }
    setSaving(true)
    try {
      const { id, name, folder, description, connectionId } = savedQuery
      await saveQuery({ id, name, folder, description, connectionId, sql: text })
      toast(`Saved ${name}`)
    } catch (e) {
      toast(`Couldn't save: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }, [savedQuery, unsaved, saveQuery, text])

  const runKeymap = useMemo(
    () => Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: () => { run(); return true } },
      { key: 'F5', run: () => { run(); return true } },
      { key: 'Mod-s', run: () => { save(); return true } },
      // Tab accepts the highlighted completion like Enter; with no list open it indents as before.
      { key: 'Tab', run: acceptCompletion }
    ])),
    [run, save]
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
        {running ? (
          <button className="danger" onClick={cancel} title="Stop the query on the server (Esc)">■ Cancel</button>
        ) : (
          <button className="primary" onClick={run}>▶ Run</button>
        )}
        {!conn.readOnly && !txn.tx && (
          <button
            className="ghost"
            disabled={running}
            title="Run the next queries in a transaction, then commit or roll them back together"
            onClick={beginTransaction}
          >
            Begin transaction
          </button>
        )}
        <span className="muted hint">
          {running
            ? 'Esc cancels the running query'
            : !txn.tx && !conn.readOnly && conn.env === 'prod'
              ? 'Ctrl+Enter runs · writes on PROD are staged until you commit'
              : 'Ctrl+Enter runs the selection, or everything'}
        </span>
        <div className="toolbar-right">
          <button
            className={`ghost save-query-button ${unsaved ? 'unsaved' : ''}`}
            disabled={saving || !text.trim()}
            title={savedQuery
              ? unsaved ? `Save changes to "${savedQuery.name}" (Ctrl+S)` : `"${savedQuery.name}": rename it, move it or save a copy`
              : 'Save this query to open again or use as a snippet (Ctrl+S)'}
            onClick={save}
          >
            {savedQuery ? (unsaved ? 'Save' : 'Saved') : 'Save'}
          </button>
          <button className={`ghost ${showAsk ? 'on' : ''}`} title="Describe a query in plain English" onClick={() => setShowAsk((s) => !s)}>✦ Ask</button>
          <button className={`ghost ${showHistory ? 'on' : ''}`} onClick={() => setShowHistory((s) => !s)}>History</button>
        </div>
      </div>

      {txn.tx && (
        <TransactionBar
          tx={txn.tx}
          env={conn.env}
          busy={running}
          onCommit={commit}
          onRollback={rollback}
          onPick={(sqlText) => {
            setText(sqlText)
            viewRef.current?.focus()
          }}
        />
      )}

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
              extensions={[...language, runKeymap]}
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
                  {set && (
                    <button
                      className="result-export"
                      title="Save this result set to a file (Excel, CSV, JSON…)"
                      onClick={() => runExport(() => window.api.exportRows(set.columns, set.rows, conn.kind, `${conn.name} results`))}
                    >
                      Export
                    </button>
                  )}
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

      {saveDialog && (
        <SaveQueryDialog
          connection={conn}
          sql={text}
          existing={savedQuery}
          onClose={() => {
            setSaveDialog(false)
            viewRef.current?.focus()
          }}
          onSaved={(saved) => {
            setSaveDialog(false)
            linkQueryTab(tab.id, saved.id, saved.name)
            toast(`Saved ${saved.name}`)
            viewRef.current?.focus()
          }}
        />
      )}
      {pendingWrite && (
        <WriteConfirmDialog
          connection={conn}
          sql={pendingWrite.sql}
          keyword={pendingWrite.keyword}
          onCancel={() => {
            setPendingWrite(null)
            viewRef.current?.focus()
          }}
          onRun={() => {
            const { sql: statement } = pendingWrite
            setPendingWrite(null)
            execute(statement, true)
          }}
        />
      )}
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
