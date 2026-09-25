import { useEffect, useMemo, useState } from 'react'
import type { CellValue, ColumnFilter, RelatedCount, RowsResult, TableDetails, TableRef } from '@shared/types'
import { incomingLinks, outgoingLinks } from '@shared/links'
import { pickDateColumn, pickDisplayColumn } from '@shared/display'
import { useAppState, type Tab } from '../state'
import { displayValue, formatCount } from '../lib/format'
import { useOpenLink } from '../lib/openLink'
import { RowInspector } from './RowInspector'
import { LoadingBar } from './DataGrid'

const PREVIEW_ROWS = 5
/** Related counts are requested a few at a time so results appear as they finish. */
const COUNT_CHUNK = 4
const COUNT_LANES = 3

/** describeTable results are stable for a session; share them across explorer tabs. */
const describeCache = new Map<string, Promise<TableDetails>>()
function describe(connectionId: string, table: TableRef): Promise<TableDetails> {
  const key = `${connectionId}|${table.schema}.${table.name}`
  let found = describeCache.get(key)
  if (!found) {
    found = window.api.describeTable(connectionId, table)
    describeCache.set(key, found)
    found.catch(() => describeCache.delete(key))
  }
  return found
}

/** Primary-key filters identifying a row, or null when the table has no primary key. */
export function recordKey(details: TableDetails, columns: string[], row: CellValue[]): ColumnFilter[] | null {
  const pk = details.columns.filter((c) => c.isPrimaryKey)
  if (!pk.length) return null
  const key: ColumnFilter[] = []
  for (const c of pk) {
    const value = row[columns.indexOf(c.name)]
    if (value === null || value === undefined) return null
    key.push({ column: c.name, op: '=', value: String(value) })
  }
  return key
}

interface Parent {
  id: string
  label: string
  connectionId: string
  table: TableRef
  filter: ColumnFilter
  state: 'loading' | 'found' | 'missing' | 'error'
  summary?: string
  key?: ColumnFilter[] | null
}

interface Relation {
  id: string
  connectionId: string
  table: TableRef
  column: string
  value: string
  count?: RelatedCount
}

export function RecordView({ tab }: { tab: Extract<Tab, { kind: 'record' }> }) {
  const { connection, links } = useAppState()
  const link = useOpenLink()
  const conn = connection(tab.connectionId)
  const [details, setDetails] = useState<TableDetails | null>(null)
  const [record, setRecord] = useState<RowsResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [parents, setParents] = useState<Parent[]>([])
  const [relations, setRelations] = useState<Relation[]>([])
  const [showEmpty, setShowEmpty] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      describe(tab.connectionId, tab.table),
      window.api.fetchRows(tab.connectionId, { table: tab.table, limit: 1, offset: 0, filters: tab.key })
    ])
      .then(([d, r]) => {
        if (cancelled) return
        setDetails(d)
        setRecord(r)
      })
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [tab.connectionId, tab.table, tab.key])

  const row = record?.rows[0]
  const columns = record?.columns ?? []
  const valueOf = (column: string): CellValue => (row ? row[columns.indexOf(column)] ?? null : null)

  // Parents: records this one points at, locally (foreign keys) and in other databases (links).
  useEffect(() => {
    if (!details || !row) return
    let cancelled = false
    const list: Parent[] = []
    for (const c of details.columns) {
      const v = valueOf(c.name)
      if (!c.references || v === null) continue
      list.push({
        id: `fk:${c.name}`,
        label: c.name,
        connectionId: tab.connectionId,
        table: { schema: c.references.schema, name: c.references.name },
        filter: { column: c.references.column, op: '=', value: String(v) },
        state: 'loading'
      })
    }
    for (const l of outgoingLinks(links, tab.connectionId, tab.table)) {
      const v = valueOf(l.from.column)
      if (v === null) continue
      list.push({ id: `link:${l.id}`, label: l.from.column, connectionId: l.to.connectionId, table: l.to.table, filter: { column: l.to.column, op: '=', value: String(v) }, state: 'loading' })
    }
    setParents(list)

    list.forEach((p) => {
      Promise.all([describe(p.connectionId, p.table), window.api.fetchRows(p.connectionId, { table: p.table, limit: 1, offset: 0, filters: [p.filter] })])
        .then(([d, r]) => {
          if (cancelled) return
          const found = r.rows[0]
          const display = pickDisplayColumn(d.columns, p.table.name)
          const summary = found && display ? displayValue(found[r.columns.indexOf(display.name)]) : undefined
          const update: Partial<Parent> = found
            ? { state: 'found', summary, key: recordKey(d, r.columns, found) }
            : { state: 'missing' }
          setParents((prev) => prev.map((x) => (x.id === p.id ? { ...x, ...update } : x)))
        })
        .catch(() => !cancelled && setParents((prev) => prev.map((x) => (x.id === p.id ? { ...x, state: 'error' } : x))))
    })
    return () => {
      cancelled = true
    }
    // valueOf reads the loaded row; details/row identity changes are what matter here.
  }, [details, row, links, tab.connectionId, tab.table])

  // Related: records elsewhere that point at this one, counted per table and connection.
  useEffect(() => {
    if (!details || !row) return
    let cancelled = false
    const list: Relation[] = []
    for (const r of details.referencedBy) {
      const v = valueOf(r.referencedColumn)
      if (v !== null) list.push({ id: `ref:${r.table.schema}.${r.table.name}.${r.column}`, connectionId: tab.connectionId, table: r.table, column: r.column, value: String(v) })
    }
    for (const l of incomingLinks(links, tab.connectionId, tab.table)) {
      const v = valueOf(l.to.column)
      if (v !== null) list.push({ id: `link:${l.id}`, connectionId: l.from.connectionId, table: l.from.table, column: l.from.column, value: String(v) })
    }
    setRelations(list)

    const byConnection = new Map<string, Relation[]>()
    for (const r of list) byConnection.set(r.connectionId, [...(byConnection.get(r.connectionId) ?? []), r])
    for (const [connectionId, group] of byConnection) {
      const chunks: Relation[][] = []
      for (let i = 0; i < group.length; i += COUNT_CHUNK) chunks.push(group.slice(i, i + COUNT_CHUNK))
      let next = 0
      const lane = async (): Promise<void> => {
        while (!cancelled && next < chunks.length) {
          const chunk = chunks[next++]
          let counts: RelatedCount[]
          try {
            counts = await window.api.countRelated(connectionId, chunk.map((r) => ({ table: r.table, column: r.column, value: r.value })))
          } catch (e) {
            counts = chunk.map(() => ({ status: 'error', message: (e as Error).message }))
          }
          if (cancelled) return
          const byId = new Map(chunk.map((r, i) => [r.id, counts[i]]))
          setRelations((prev) => prev.map((r) => (byId.has(r.id) ? { ...r, count: byId.get(r.id) } : r)))
        }
      }
      for (let i = 0; i < COUNT_LANES; i++) lane()
    }
    return () => {
      cancelled = true
    }
  }, [details, row, links, tab.connectionId, tab.table])

  const countAnyway = async (r: Relation): Promise<void> => {
    setRelations((prev) => prev.map((x) => (x.id === r.id ? { ...x, count: undefined } : x)))
    const [count] = await window.api.countRelated(r.connectionId, [{ table: r.table, column: r.column, value: r.value, force: true }])
    setRelations((prev) => prev.map((x) => (x.id === r.id ? { ...x, count } : x)))
  }

  const sorted = useMemo(() => {
    const rank = (r: Relation): number =>
      !r.count ? 1 : r.count.status === 'ok' ? (r.count.count > 0 ? 0 : 3) : 2
    return [...relations].sort((a, b) => rank(a) - rank(b) || countOf(b) - countOf(a) || a.table.name.localeCompare(b.table.name))
  }, [relations])
  const withRows = sorted.filter((r) => !(r.count?.status === 'ok' && r.count.count === 0))
  const empty = sorted.filter((r) => r.count?.status === 'ok' && r.count.count === 0)
  const pending = relations.filter((r) => !r.count).length

  if (!conn) return null
  if (error) return <div className="view"><div className="error-bar">{error}</div></div>
  if (!record || !details) return <div className="view record"><LoadingBar label={`Loading ${tab.table.name}…`} overlay={false} /></div>
  if (!row) return <div className="view record"><div className="grid-empty">Record not found: {tab.key.map((k) => `${k.column} = ${k.value}`).join(', ')}</div></div>

  const display = pickDisplayColumn(details.columns, tab.table.name)
  const title = display ? displayValue(valueOf(display.name)) : ''

  return (
    <div className="view record">
      <div className="record-head">
        <div>
          <div className="muted small">{tab.table.schema}.{tab.table.name}</div>
          <h2>
            {tab.table.name} <span className="record-key">{tab.key.map((k) => k.value).join(' · ')}</span>
            {title && title !== 'NULL' && <span className="record-title">{title}</span>}
          </h2>
        </div>
        <span className="grow" />
        <button className="ghost" title="Shift+click or drag to open beside" {...link({ kind: 'table', connectionId: tab.connectionId, table: tab.table, filters: tab.key })}>Open in table</button>
      </div>

      <div className="record-body">
        <RowInspector kind={conn.kind} table={tab.table} columns={columns} row={row} columnInfo={new Map(details.columns.map((c) => [c.name, c]))} />

        <div className="record-main">
          <section>
            <div className="section-title">Belongs to ({parents.length})</div>
            {!parents.length && <div className="muted small pad">This record doesn't point at any others.</div>}
            <div className="parent-cards">
              {parents.map((p) => {
                const target = connection(p.connectionId)
                const remote = p.connectionId !== tab.connectionId
                return (
                  <button
                    key={p.id}
                    className={`parent-card ${remote ? `remote env-${target?.env}` : ''} ${p.state}`}
                    disabled={p.state !== 'found' || !p.key}
                    {...(p.key ? link({ kind: 'record', connectionId: p.connectionId, table: p.table, key: p.key }) : {})}
                    title={`${p.label} = ${p.filter.value}`}
                  >
                    <span className="parent-label">
                      {remote && <><span className="env-dot" /><span className="cross-conn">{target?.name}</span></>}
                      {p.table.name}
                      <span className="muted"> via {p.label}</span>
                    </span>
                    <span className="parent-summary">
                      {p.state === 'loading' ? '…' : p.state === 'missing' ? `no ${p.table.name} ${p.filter.value}` : p.state === 'error' ? "couldn't load" : p.summary ?? `#${p.filter.value}`}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          <section>
            <div className="section-title">
              Related records {pending > 0 && <span className="muted">· counting {pending}…</span>}
            </div>
            {!relations.length && <div className="muted small pad">Nothing references this record.</div>}
            {withRows.map((r) => (
              <RelationRow
                key={r.id}
                relation={r}
                local={r.connectionId === tab.connectionId}
                onCountAnyway={() => countAnyway(r)}
              />
            ))}
            {empty.length > 0 && (
              <button className="link small" onClick={() => setShowEmpty((s) => !s)}>
                {showEmpty ? 'Hide' : 'Show'} {empty.length} related table{empty.length === 1 ? '' : 's'} with no records
              </button>
            )}
            {showEmpty && empty.map((r) => <RelationRow key={r.id} relation={r} local={r.connectionId === tab.connectionId} onCountAnyway={() => countAnyway(r)} />)}
          </section>
        </div>
      </div>
    </div>
  )
}

function countOf(r: Relation): number {
  return r.count?.status === 'ok' ? r.count.count : -1
}

function RelationRow({ relation, local, onCountAnyway }: { relation: Relation; local: boolean; onCountAnyway(): void }) {
  const { connection } = useAppState()
  const link = useOpenLink()
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<{ details: TableDetails; rows: RowsResult } | null>(null)
  const target = connection(relation.connectionId)
  const filter: ColumnFilter = { column: relation.column, op: '=', value: relation.value }
  const c = relation.count

  useEffect(() => {
    if (!open || preview) return
    Promise.all([
      describe(relation.connectionId, relation.table),
      window.api.fetchRows(relation.connectionId, { table: relation.table, limit: PREVIEW_ROWS, offset: 0, filters: [filter] })
    ]).then(([details, rows]) => setPreview({ details, rows })).catch(() => undefined)
  }, [open])

  const hasRows = c?.status === 'ok' && c.count > 0
  const badge = !c ? '…'
    : c.status === 'ok' ? `${formatCount(c.count)}${c.capped ? '+' : ''}`
    : c.status === 'timeout' ? 'slow'
    : c.status === 'skipped' ? '?'
    : '!'

  return (
    <div className={`relation ${local ? '' : `remote env-${target?.env}`}`}>
      <div className="relation-row">
        <button className="relation-toggle" disabled={!hasRows} onClick={() => setOpen((o) => !o)}>{hasRows ? (open ? '▾' : '▸') : ''}</button>
        <span className="relation-name">
          {!local && <><span className="env-dot" /><span className="cross-conn">{target?.name}</span></>}
          {relation.table.name}<span className="muted">.{relation.column}</span>
        </span>
        <span className={`count-pill ${c?.status ?? 'pending'} ${hasRows ? 'has' : ''}`} title={c?.status === 'skipped' ? c.reason : c?.status === 'error' ? c.message : c?.status === 'timeout' ? 'Stopped after 8 seconds' : undefined}>{badge}</span>
        {(c?.status === 'skipped' || c?.status === 'timeout') && <button className="link small" onClick={onCountAnyway}>count anyway</button>}
        {hasRows && <button className="link small" {...link({ kind: 'table', connectionId: relation.connectionId, table: relation.table, filters: [filter] })}>open all</button>}
      </div>
      {open && (
        <div className="relation-preview">
          {!preview ? <div className="muted small">Loading…</div> : (() => {
            const pk = preview.details.columns.filter((col) => col.isPrimaryKey)
            const display = pickDisplayColumn(preview.details.columns, relation.table.name)
            const date = pickDateColumn(preview.details.columns)
            const shown = [...pk, ...(display ? [display] : []), ...(date ? [date] : [])]
            const idx = (name: string): number => preview.rows.columns.indexOf(name)
            return (
              <table>
                <thead><tr>{shown.map((col) => <th key={col.name}>{col.name}</th>)}</tr></thead>
                <tbody>
                  {preview.rows.rows.map((r, i) => {
                    const key = recordKey(preview.details, preview.rows.columns, r)
                    return (
                      <tr key={i} className={key ? 'clickable' : ''} {...(key ? link({ kind: 'record', connectionId: relation.connectionId, table: relation.table, key }) : {})}>
                        {shown.map((col) => <td key={col.name}>{displayValue(r[idx(col.name)])}</td>)}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )
          })()}
          {hasRows && c.count > PREVIEW_ROWS && <div className="muted small">Showing {PREVIEW_ROWS} of {formatCount(c.count)}{c.capped ? '+' : ''}. Use "open all" for the rest.</div>}
        </div>
      )}
    </div>
  )
}
