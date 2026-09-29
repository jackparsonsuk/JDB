import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CellValue, ColumnFilter, ColumnInfo, FilterOp, RowsResult, TableDetails, TableSort } from '@shared/types'
import { useAppState, useCloseWarning, type OpenTarget, type Tab } from '../state'
import { incomingLinks, outgoingLinks } from '@shared/links'
import { formatCount, selectSql } from '../lib/format'
import { DataGrid, type Selection } from './DataGrid'
import { RowInspector } from './RowInspector'
import { recordKey } from './RecordView'
import { toast } from './Toast'
import { runExport } from '../lib/exporting'
import { useTableEdits } from '../lib/useTableEdits'
import { SaveChangesDialog } from './SaveChangesDialog'
import { ColumnFinder } from './ColumnFinder'

const PAGE_SIZES = [50, 100, 250, 500]
const OPS: { op: FilterOp; label: string; needsValue: boolean }[] = [
  { op: '=', label: '=', needsValue: true },
  { op: '!=', label: '≠', needsValue: true },
  { op: 'contains', label: 'contains', needsValue: true },
  { op: 'starts', label: 'starts with', needsValue: true },
  { op: '>', label: '>', needsValue: true },
  { op: '<', label: '<', needsValue: true },
  { op: 'is null', label: 'is null', needsValue: false },
  { op: 'not null', label: 'is not null', needsValue: false }
]

const emptySelection: Selection = { rows: new Set(), active: null }

/** `focused`: this tab is showing in the focused pane, so it owns the keyboard. */
export function TableView({ tab, focused }: { tab: Extract<Tab, { kind: 'table' }>; focused: boolean }) {
  const { connection, openQuery, openRecord, open, links, tables, rememberTab, schemaVersions } = useAppState()
  const schemaVersion = schemaVersions[tab.connectionId] ?? 0
  const conn = connection(tab.connectionId)
  const [details, setDetails] = useState<TableDetails | null>(null)
  const [filters, setFilters] = useState<ColumnFilter[]>(tab.initialFilters)
  const [sort, setSort] = useState<TableSort | undefined>(tab.initialSort)
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(100)
  const [result, setResult] = useState<RowsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection>(emptySelection)
  const [showInspector, setShowInspector] = useState(true)
  const [draft, setDraft] = useState<ColumnFilter | null>(null)
  const [quickFind, setQuickFind] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [exporting, setExporting] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [reviewing, setReviewing] = useState<string[] | null>(null)
  /** Set by the column finder, or by opening this table at a column from Ctrl+K. */
  const [focusColumn, setFocusColumn] = useState(tab.focusColumn)
  useEffect(() => {
    if (tab.focusColumn) setFocusColumn(tab.focusColumn)
  }, [tab.focusColumn])

  const firstRemember = useRef(true)
  useEffect(() => {
    if (firstRemember.current) firstRemember.current = false
    else rememberTab(tab.id, { filters, sort: sort ?? null })
  }, [tab.id, filters, sort, rememberTab])

  useEffect(() => {
    window.api.describeTable(tab.connectionId, tab.table).then(setDetails).catch(() => setDetails(null))
  }, [tab.connectionId, tab.table, schemaVersion])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const started = performance.now()
    window.api
      .fetchRows(tab.connectionId, {
        table: tab.table,
        limit: pageSize,
        offset: page * pageSize,
        orderBy: sort?.column,
        orderDir: sort?.dir,
        filters
      })
      .then((r) => {
        if (cancelled) return
        setTimings((t) => ({ ...t, rows: performance.now() - started }))
        setResult(r)
        setError(null)
        setSelection(emptySelection)
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [tab.connectionId, tab.table, filters, sort, page, pageSize, reloadKey, schemaVersion])

  /**
   * Rows matching the filters, counted separately from the page because a big table can take
   * seconds to count. undefined while counting; null if it took too long.
   */
  const [count, setCount] = useState<number | null | undefined>(undefined)
  /** How long the last page and count took, shown on hover to see where the time goes. */
  const [timings, setTimings] = useState<{ rows?: number; count?: number }>({})
  useEffect(() => {
    let cancelled = false
    setCount(undefined)
    const started = performance.now()
    window.api
      .countRows(tab.connectionId, tab.table, filters)
      .then((n) => {
        if (cancelled) return
        setTimings((t) => ({ ...t, count: performance.now() - started }))
        setCount(n)
      })
      .catch(() => !cancelled && setCount(null))
    return () => {
      cancelled = true
    }
  }, [tab.connectionId, tab.table, filters, reloadKey])

  const refresh = useCallback(() => setReloadKey((k) => k + 1), [])

  useEffect(() => {
    if (!focused) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F5') {
        e.preventDefault()
        refresh()
      } else if (e.key === 'Escape' && selection.active !== null) {
        setSelection(emptySelection)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focused, refresh, selection.active])

  const outgoing = useMemo(() => outgoingLinks(links, tab.connectionId, tab.table), [links, tab.connectionId, tab.table])
  const incoming = useMemo(() => incomingLinks(links, tab.connectionId, tab.table), [links, tab.connectionId, tab.table])
  const crossLinks = useMemo(() => new Map(outgoing.map((l) => {
    const target = connection(l.to.connectionId)
    return [l.from.column, { title: `Open in ${target?.name}: ${l.to.table.name} where ${l.to.column} = this value`, env: target?.env ?? 'local' }]
  })), [outgoing, connection])

  const explore = (index: number): void => {
    const r = visibleRows[index]
    const key = details && result && r ? recordKey(details, result.columns, r) : null
    if (key) openRecord(tab.connectionId, tab.table, key, tab.pane)
  }
  const canExplore = !!details?.columns.some((c) => c.isPrimaryKey)

  const crossLinkTarget = (column: string, value: CellValue): OpenTarget | undefined => {
    const link = outgoing.find((l) => l.from.column === column)
    return link && { kind: 'table', connectionId: link.to.connectionId, table: link.to.table, filters: [{ column: link.to.column, op: '=', value: String(value) }] }
  }

  const columnInfo = useMemo(
    () => new Map<string, ColumnInfo>(details?.columns.map((c) => [c.name, c]) ?? []),
    [details]
  )

  const visibleRows = useMemo(() => {
    if (!result) return []
    const needle = quickFind.trim().toLowerCase()
    if (!needle) return result.rows
    return result.rows.filter((row) => row.some((v) => v !== null && String(v).toLowerCase().includes(needle)))
  }, [result, quickFind])

  const columnNames = useMemo(() => result?.columns ?? details?.columns.map((c) => c.name) ?? [], [result, details])
  const edits = useTableEdits(conn?.kind ?? 'mssql', tab.table, columnNames, details, visibleRows)
  useCloseWarning(tab.id, edits.count ? `${edits.count} unsaved change${edits.count === 1 ? '' : 's'} to ${tab.table.name} will be lost.` : null)
  const isView = tables[tab.connectionId]?.tables.find((t) => t.schema === tab.table.schema && t.name === tab.table.name)?.type === 'view'
  /** Why the grid can't be edited, or null when it can. */
  const editBlocked = !conn ? 'Not connected'
    : conn.readOnly ? `${conn.name} is read-only. Turn off read-only in its connection settings to edit.`
    : isView ? "Views can't be edited here"
    : details && !details.columns.some((c) => c.isPrimaryKey) ? "This table has no primary key, so edited rows can't be matched safely"
    : null
  const canEditNow = editMode && !editBlocked && !!details

  const review = (): void => {
    try {
      setReviewing(edits.statements())
    } catch (e) {
      toast((e as Error).message)
    }
  }

  const applyFilters = (next: ColumnFilter[]): void => {
    setFilters(next)
    setPage(0)
  }

  const addFilter = (column: string, op: FilterOp, value?: string): void => applyFilters([...filters, { column, op, value }])

  const toggleSort = (column: string): void => {
    setSort((prev) =>
      prev?.column !== column ? { column, dir: 'asc' } : prev.dir === 'asc' ? { column, dir: 'desc' } : undefined
    )
    setPage(0)
  }

  const referenceTarget = (column: ColumnInfo, value: CellValue): OpenTarget => {
    const ref = column.references!
    return { kind: 'table', connectionId: tab.connectionId, table: { schema: ref.schema, name: ref.name }, filters: [{ column: ref.column, op: '=', value: String(value) }] }
  }

  if (!conn) return null
  /** The database's own row estimate, which only describes the unfiltered table. */
  const estimate = filters.length ? undefined : tables[tab.connectionId]?.tables.find((t) => t.schema === tab.table.schema && t.name === tab.table.name)?.rowEstimate
  // The last page also gives the total away, before (or instead of) the count.
  const total = typeof count === 'number' ? count : result && !result.hasMore ? page * pageSize + result.rows.length : undefined
  const countLabel = (): { text: string; title?: string } => {
    if (total !== undefined) return { text: `${formatCount(total)} rows` }
    if (estimate !== undefined) {
      return count === undefined
        ? { text: `~${formatCount(estimate)} rows`, title: 'Estimated; counting…' }
        : { text: `~${formatCount(estimate)} rows`, title: 'Too many to count quickly; this is the database estimate' }
    }
    if (count === undefined) return { text: 'counting rows…' }
    const seen = page * pageSize + (result?.rows.length ?? 0)
    return { text: `${formatCount(seen)}+ rows`, title: 'Too many to count quickly' }
  }

  /** "Loading rows 101–200 of 37,392" using the count if known, else the estimate. */
  const loadingLabel = (): string => {
    const known = total ?? estimate
    const exact = total !== undefined
    const from = page * pageSize + 1
    const to = known !== undefined ? Math.min(known, page * pageSize + pageSize) : page * pageSize + pageSize
    if (known === 0 && exact) return 'Loading…'
    return `Loading rows ${formatCount(from)}–${formatCount(Math.max(from, to))}${known !== undefined ? ` of ${exact ? '' : '~'}${formatCount(known)}` : ''}…`
  }
  const pageCount = total === undefined ? undefined : Math.max(1, Math.ceil(total / pageSize))
  const counted = countLabel()
  const seconds = (ms: number | undefined): string => (ms === undefined ? '…' : `${(ms / 1000).toFixed(2)}s`)
  const countTitle = [counted.title, `Page: ${seconds(timings.rows)} · Count: ${seconds(timings.count)}`].filter(Boolean).join('\n')
  const activeRow = selection.active !== null ? edits.rows[selection.active] : undefined

  return (
    <div className="view">
      <div className="toolbar">
        <div className="toolbar-title">
          <span className="muted">{tab.table.schema}.</span>
          <strong>{tab.table.name}</strong>
          <span className="count" title={countTitle}>{loading ? 'loading…' : counted.text}</span>
        </div>

        <div className="filters">
          {filters.map((f, i) => (
            <span key={i} className="chip">
              <span>{f.column}</span>
              <span className="muted">{OPS.find((o) => o.op === f.op)?.label}</span>
              {f.value !== undefined && OPS.find((o) => o.op === f.op)?.needsValue && <span>{f.value}</span>}
              <button className="icon small" onClick={() => applyFilters(filters.filter((_, j) => j !== i))}>✕</button>
            </span>
          ))}
          {draft ? (
            <FilterEditor
              draft={draft}
              columns={columnNames}
              onChange={setDraft}
              onApply={() => {
                addFilter(draft.column, draft.op, draft.value)
                setDraft(null)
              }}
              onCancel={() => setDraft(null)}
            />
          ) : (
            <button className="ghost" onClick={() => setDraft({ column: columnNames[0] ?? '', op: 'contains', value: '' })}>
              + Filter
            </button>
          )}
          {filters.length > 0 && <button className="ghost" onClick={() => applyFilters([])}>Clear</button>}
        </div>

        <div className="toolbar-right">
          <ColumnFinder columns={columnNames} columnInfo={columnInfo} onPick={(name) => setFocusColumn((f) => ({ name, seq: (f?.seq ?? 0) + 1 }))} />
          <input
            className="search"
            placeholder="Find in page…"
            value={quickFind}
            onChange={(e) => setQuickFind(e.target.value)}
          />
          <button
            className="ghost"
            title={conn.readOnly ? 'Columns, types, keys and indexes' : 'Columns, types, keys and indexes; add, change and drop columns'}
            onClick={() => open({ kind: 'design', connectionId: tab.connectionId, table: tab.table })}
          >
            Design
          </button>
          <button
            className="ghost"
            title="Open this view as SQL"
            onClick={() => openQuery(tab.connectionId, selectSql(conn.kind, tab.table, filters, sort?.column, sort?.dir, pageSize))}
          >
            SQL
          </button>
          <button
            className="ghost"
            title="Save every row matching the filters, in this order, to a file (Excel, CSV, JSON…)"
            disabled={exporting}
            onClick={async () => {
              setExporting(true)
              await runExport(() => window.api.exportTable(tab.connectionId, conn.kind, { table: tab.table, filters, orderBy: sort?.column, orderDir: sort?.dir }))
              setExporting(false)
            }}
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
          <button
            className={`ghost ${editMode ? 'on' : ''} ${editMode && conn.env === 'prod' ? 'prod-edit' : ''}`}
            disabled={!!editBlocked}
            title={editBlocked ?? (editMode ? 'Stop editing (staged changes are kept)' : 'Edit cells, add and delete rows. Nothing is saved until you review and save.')}
            onClick={() => setEditMode((m) => !m)}
          >
            ✎ Edit
          </button>
          {canEditNow && (
            <button
              className="ghost"
              title="Add a row; columns you leave unset get their defaults"
              onClick={() => {
                const index = edits.addRow()
                setSelection({ rows: new Set([index]), active: index })
              }}
            >
              + Row
            </button>
          )}
          <button className="ghost" title="Refresh (F5)" onClick={refresh}>⟳</button>
          <button
            className={`ghost ${showInspector ? 'on' : ''}`}
            title="Toggle row details"
            onClick={() => setShowInspector((s) => !s)}
          >
            ◧
          </button>
        </div>
      </div>

      {error && <div className="error-bar">{error}</div>}

      {edits.count > 0 && (
        <div className={`edit-bar env-${conn.env}`}>
          <span className="env-dot" />
          <strong>{edits.count} unsaved change{edits.count === 1 ? '' : 's'}</strong>
          <span className="muted">
            {editMode ? 'Double-click or F2 to edit · Del deletes rows · right-click for NULL and undo' : 'Turn on Edit to keep changing rows'}
          </span>
          <div className="toolbar-right">
            <button
              onClick={() => {
                if (window.confirm(`Discard ${edits.count} unsaved change${edits.count === 1 ? '' : 's'}?`)) edits.discard()
              }}
            >
              Discard
            </button>
            <button className="primary" onClick={review}>Review &amp; save…</button>
          </div>
        </div>
      )}

      <div className="view-body">
        <DataGrid
          loadingLabel={loading ? loadingLabel() : undefined}
          columns={columnNames}
          rows={edits.rows}
          scrollResetKey={visibleRows}
          marks={edits.marks}
          editing={canEditNow ? edits.grid : undefined}
          editHint={editBlocked ?? 'Turn on ✎ Edit in the toolbar to edit values, set NULL, or fill in a new GUID or now/today'}
          rowOffset={quickFind ? 0 : page * pageSize}
          columnInfo={columnInfo}
          sort={sort}
          onSort={toggleSort}
          selection={selection}
          onSelectionChange={setSelection}
          referenceTarget={referenceTarget}
          crossLinks={crossLinks}
          onRowDoubleClick={canExplore && !canEditNow ? explore : undefined}
          crossLinkTarget={crossLinkTarget}
          onFilter={addFilter}
          copyTarget={{ kind: conn.kind, table: tab.table }}
          focusColumn={focusColumn}
        />
        {showInspector && activeRow && (
          <RowInspector
            kind={conn.kind}
            table={tab.table}
            columns={columnNames}
            row={activeRow}
            columnInfo={columnInfo}
            referencedBy={details?.referencedBy}
            connectionId={tab.connectionId}
            cross={{ outgoing, incoming, connection }}
            onExplore={canExplore && selection.active !== null ? () => explore(selection.active!) : undefined}
            onClose={() => setSelection(emptySelection)}
          />
        )}
      </div>

      {reviewing && (
        <SaveChangesDialog
          connection={conn}
          statements={reviewing}
          onClose={() => setReviewing(null)}
          onSaved={(n) => {
            setReviewing(null)
            edits.discard()
            refresh()
            toast(`Saved ${n} change${n === 1 ? '' : 's'}`)
          }}
          onOpenSql={(sqlText) => {
            setReviewing(null)
            openQuery(tab.connectionId, sqlText)
          }}
        />
      )}

      <div className="statusbar">
        <div className="pager">
          <button className="ghost" disabled={page === 0} onClick={() => setPage(0)}>«</button>
          <button className="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹</button>
          <span>Page {page + 1}{pageCount !== undefined ? ` of ${formatCount(pageCount)}` : ''}</span>
          <button className="ghost" disabled={!result?.hasMore} onClick={() => setPage((p) => p + 1)}>›</button>
          <button
            className="ghost"
            disabled={pageCount === undefined || page + 1 >= pageCount}
            title={pageCount === undefined ? 'Waiting for the row count' : undefined}
            onClick={() => pageCount !== undefined && setPage(pageCount - 1)}
          >»</button>
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0) }}>
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s} / page</option>)}
          </select>
        </div>
        <span className="muted">
          {selection.rows.size > 1 ? `${selection.rows.size} rows selected · Ctrl+C copies for Excel` : canEditNow ? 'Right-click a cell to edit, set NULL, add a GUID or now/today' : 'Right-click a cell for copy and filter options'}
        </span>
        <button
          className="ghost"
          onClick={() => {
            if (!result) return
            window.api.copy(details ? details.columns.map((c) => `${c.name}\t${c.dataType}`).join('\n') : result.columns.join('\n'))
            toast('Copied column list')
          }}
        >
          Copy columns
        </button>
      </div>
    </div>
  )
}

function FilterEditor({ draft, columns, onChange, onApply, onCancel }: {
  draft: ColumnFilter
  columns: string[]
  onChange(filter: ColumnFilter): void
  onApply(): void
  onCancel(): void
}) {
  const needsValue = OPS.find((o) => o.op === draft.op)?.needsValue ?? true
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter') onApply()
    if (e.key === 'Escape') onCancel()
  }
  return (
    <span className="filter-editor" onKeyDown={onKey}>
      <select value={draft.column} onChange={(e) => onChange({ ...draft, column: e.target.value })}>
        {columns.map((c) => <option key={c}>{c}</option>)}
      </select>
      <select value={draft.op} onChange={(e) => onChange({ ...draft, op: e.target.value as FilterOp })}>
        {OPS.map((o) => <option key={o.op} value={o.op}>{o.label}</option>)}
      </select>
      {needsValue && (
        <input autoFocus value={draft.value ?? ''} onChange={(e) => onChange({ ...draft, value: e.target.value })} />
      )}
      <button onClick={onApply}>Apply</button>
      <button className="icon small" onClick={onCancel}>✕</button>
    </span>
  )
}
