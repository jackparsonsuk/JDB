import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CellValue, ColumnFilter, ColumnInfo, FilterOp, RowsResult, TableDetails } from '@shared/types'
import { useAppState, type OpenTarget, type Tab } from '../state'
import { incomingLinks, outgoingLinks } from '@shared/links'
import { formatCount, selectSql } from '../lib/format'
import { DataGrid, type Selection } from './DataGrid'
import { RowInspector } from './RowInspector'
import { recordKey } from './RecordView'
import { toast } from './Toast'

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
  const { connection, openQuery, openRecord, links, tables } = useAppState()
  const conn = connection(tab.connectionId)
  const [details, setDetails] = useState<TableDetails | null>(null)
  const [filters, setFilters] = useState<ColumnFilter[]>(tab.initialFilters)
  const [sort, setSort] = useState<{ column: string; dir: 'asc' | 'desc' } | undefined>()
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

  useEffect(() => {
    window.api.describeTable(tab.connectionId, tab.table).then(setDetails).catch(() => setDetails(null))
  }, [tab.connectionId, tab.table])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
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
        setResult(r)
        setError(null)
        setSelection(emptySelection)
      })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [tab.connectionId, tab.table, filters, sort, page, pageSize, reloadKey])

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
  /** "Loading rows 101–200 of 37,392" using the last exact count, or the sidebar's estimate on first load. */
  const loadingLabel = (): string => {
    const known = result?.total ?? tables[tab.connectionId]?.tables.find((t) => t.schema === tab.table.schema && t.name === tab.table.name)?.rowEstimate
    const exact = result?.total !== undefined
    const from = page * pageSize + 1
    const to = known !== undefined ? Math.min(known, page * pageSize + pageSize) : page * pageSize + pageSize
    if (known === 0 && exact) return 'Loading…'
    return `Loading rows ${formatCount(from)}–${formatCount(Math.max(from, to))}${known !== undefined ? ` of ${exact ? '' : '~'}${formatCount(known)}` : ''}…`
  }
  const total = result?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const activeRow = selection.active !== null ? visibleRows[selection.active] : undefined
  const columnNames = result?.columns ?? details?.columns.map((c) => c.name) ?? []

  return (
    <div className="view">
      <div className="toolbar">
        <div className="toolbar-title">
          <span className="muted">{tab.table.schema}.</span>
          <strong>{tab.table.name}</strong>
          <span className="count">{loading ? 'loading…' : `${formatCount(total)} rows`}</span>
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
          <input
            className="search"
            placeholder="Find in page…"
            value={quickFind}
            onChange={(e) => setQuickFind(e.target.value)}
          />
          <button
            className="ghost"
            title="Open this view as SQL"
            onClick={() => openQuery(tab.connectionId, selectSql(conn.kind, tab.table, filters, sort?.column, sort?.dir, pageSize))}
          >
            SQL
          </button>
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

      <div className="view-body">
        <DataGrid
          loadingLabel={loading ? loadingLabel() : undefined}
          columns={columnNames}
          rows={visibleRows}
          rowOffset={quickFind ? 0 : page * pageSize}
          columnInfo={columnInfo}
          sort={sort}
          onSort={toggleSort}
          selection={selection}
          onSelectionChange={setSelection}
          referenceTarget={referenceTarget}
          crossLinks={crossLinks}
          onRowDoubleClick={canExplore ? explore : undefined}
          crossLinkTarget={crossLinkTarget}
          onFilter={addFilter}
          copyTarget={{ kind: conn.kind, table: tab.table }}
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

      <div className="statusbar">
        <div className="pager">
          <button className="ghost" disabled={page === 0} onClick={() => setPage(0)}>«</button>
          <button className="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>‹</button>
          <span>Page {page + 1} of {formatCount(pageCount)}</span>
          <button className="ghost" disabled={page + 1 >= pageCount} onClick={() => setPage((p) => p + 1)}>›</button>
          <button className="ghost" disabled={page + 1 >= pageCount} onClick={() => setPage(pageCount - 1)}>»</button>
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0) }}>
            {PAGE_SIZES.map((s) => <option key={s} value={s}>{s} / page</option>)}
          </select>
        </div>
        <span className="muted">
          {selection.rows.size > 1 ? `${selection.rows.size} rows selected · Ctrl+C copies for Excel` : 'Right-click a cell for copy and filter options'}
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
