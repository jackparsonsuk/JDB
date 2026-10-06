import { useEffect, useMemo, useState } from 'react'
import type { CellValue, ColumnFilter, RelatedCount, RowsResult, TableDetails, TableRef } from '@shared/types'
import { CHILD_WATCH_TABLES, childWatchProblem, defaultWatchInterval, eventTitle, SHARED_MIN_INTERVAL, watchIntervals, watchText, type RowValue, type WatchEvent } from '@shared/rowWatch'
import { incomingLinks, outgoingLinks } from '@shared/links'
import { pickDateColumn, pickDisplayColumn } from '@shared/display'
import { useAppState, useTableList, type Tab } from '../state'
import { displayValue, formatCount } from '../lib/format'
import { useOpenLink } from '../lib/openLink'
import { useRowWatch, type RowWatch, type WatchChild } from '../lib/useRowWatch'
import { RowInspector } from './RowInspector'
import { LoadingBar } from './DataGrid'
import { toast } from './Toast'

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
  const { connection, links, safety } = useAppState()
  useTableList(tab.connectionId)
  const link = useOpenLink()
  const conn = connection(tab.connectionId)
  const level = conn ? safety(conn) : 'protected'
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

  // Until one is picked, the default follows the connection, whose environment may still be loading.
  const [picked, setEvery] = useState<number | null>(null)
  const every = picked ?? defaultWatchInterval(level)
  const initial = useMemo(() => (record && row ? { columns: record.columns, row } : null), [record, row])
  const [withRelated, setWithRelated] = useState(true)
  // Primary keys of related tables, read once watching starts.
  const [childKeys, setChildKeys] = useState<Record<string, ChildKeys>>({})
  const children = useMemo(
    () => (withRelated ? watchPlan(relations, childKeys, tab.connectionId, (id) => {
      const c = connection(id)
      return { name: c?.name, minInterval: c && safety(c) === 'relaxed' ? 0 : SHARED_MIN_INTERVAL }
    }) : { watched: [], skipped: [] }),
    [withRelated, relations, childKeys, tab.connectionId, connection, safety]
  )
  const watch = useRowWatch(tab.connectionId, tab.table, tab.key, initial, every, children.watched)
  useEffect(() => {
    if (!watch.watching || !withRelated) return
    for (const r of relations) {
      const k = tableKey(r.connectionId, r.table)
      if (k in childKeys || r.count?.status !== 'ok') continue
      setChildKeys((s) => (k in s ? s : { ...s, [k]: 'reading' }))
      describe(r.connectionId, r.table)
        .then((d) => setChildKeys((s) => ({ ...s, [k]: d.columns.filter((c) => c.isPrimaryKey).map((c) => c.name) })))
        .catch(() => setChildKeys((s) => ({ ...s, [k]: 'error' })))
    }
  }, [watch.watching, withRelated, relations, childKeys])
  // Asked to watch from elsewhere (the row inspector's Watch button).
  useEffect(() => {
    if (tab.watch) watch.start()
  }, [tab.watch?.seq])
  // The inspector shows the row as last read while watching; a gone row keeps its last values.
  const shown = watch.latest ?? initial
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
        <WatchControls watch={watch} interval={every} intervals={watchIntervals(level)} onInterval={setEvery} withRelated={withRelated} onWithRelated={setWithRelated} />
        <button className="ghost" title="Shift+click or drag to open beside" {...link({ kind: 'table', connectionId: tab.connectionId, table: tab.table, filters: tab.key })}>Open in table</button>
      </div>

      <div className="record-body">
        <RowInspector kind={conn.kind} table={tab.table} columns={shown?.columns ?? columns} row={shown?.row ?? row} columnInfo={new Map(details.columns.map((c) => [c.name, c]))} />

        <div className="record-main">
          {(watch.watching || watch.events.length > 0) && <WatchTimeline watch={watch} interval={every} plan={withRelated ? children : null} />}

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

const tableKey = (connectionId: string, table: TableRef): string => `${connectionId}|${table.schema}.${table.name}`

/** A related table's primary key columns, while or once read. */
type ChildKeys = string[] | 'reading' | 'error'

interface WatchPlan {
  watched: WatchChild[]
  skipped: { id: string; label: string; reason: string }[]
}

/**
 * Which related tables are watched with the row: counted, small, with a primary key, and only the
 * first CHILD_WATCH_TABLES. `keys` holds the primary keys read so far; a table whose key is still
 * being read is left out until it arrives.
 */
function watchPlan(relations: Relation[], keys: Record<string, ChildKeys>, ownConnection: string, target: (id: string) => { name?: string; minInterval: number }): WatchPlan {
  const plan: WatchPlan = { watched: [], skipped: [] }
  for (const r of relations) {
    const remote = r.connectionId !== ownConnection
    const { name, minInterval } = target(r.connectionId)
    const label = `${remote && name ? `${name}: ` : ''}${r.table.name}.${r.column}`
    const k = keys[tableKey(r.connectionId, r.table)]
    let reason = k === 'error' ? "couldn't read its columns" : childWatchProblem(r.count, !Array.isArray(k) || k.length > 0)
    // Its primary key is still being read, or hasn't been asked for yet.
    if (!reason && !Array.isArray(k)) continue
    if (!reason && plan.watched.length >= CHILD_WATCH_TABLES) reason = `only the first ${CHILD_WATCH_TABLES} related tables are watched`
    if (reason) {
      plan.skipped.push({ id: r.id, label, reason })
      continue
    }
    plan.watched.push({
      id: r.id,
      connectionId: r.connectionId,
      table: r.table,
      filter: { column: r.column, op: '=', value: r.value },
      keys: k as string[],
      source: { table: r.table.name, column: r.column, ...(remote && name ? { connection: name } : {}) },
      minInterval
    })
  }
  return plan
}

/** A watch interval as "30s" or "2m". */
const every = (s: number): string => (s < 60 ? `${s}s` : `${s / 60}m`)

function WatchControls({ watch, interval, intervals, onInterval, withRelated, onWithRelated }: {
  watch: RowWatch; interval: number; intervals: number[]; onInterval(seconds: number): void; withRelated: boolean; onWithRelated(on: boolean): void
}) {
  return (
    <div className="watch-controls">
      <label className="small" title="Also watch the related records listed below: rows added, removed and changed">
        <input type="checkbox" checked={withRelated} onChange={(e) => onWithRelated(e.target.checked)} /> related rows
      </label>
      <select value={interval} onChange={(e) => onInterval(Number(e.target.value))} title="How often the row is read again while watching">
        {intervals.map((s) => <option key={s} value={s}>every {every(s)}</option>)}
      </select>
      {watch.watching
        ? <button className="watching" onClick={watch.stop} title="Stop reading the row">◉ Watching</button>
        : <button className="ghost" onClick={watch.start} title="Read this row again every few seconds and list what changes, e.g. while you try something in another app">◎ Watch</button>}
    </div>
  )
}

const timeOf = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour12: false })

function WatchTimeline({ watch, interval, plan }: { watch: RowWatch; interval: number; plan: WatchPlan | null }) {
  const { events } = watch
  const [showSkipped, setShowSkipped] = useState(false)
  const copy = (): void => {
    navigator.clipboard.writeText(watchText(events, timeOf, displayValue))
    toast('Copied the changes')
  }
  return (
    <section className="watch">
      <div className="section-title watch-title">
        <span>Changes ({events.length})</span>
        <span className="grow" />
        {events.length > 0 && <button className="link small" onClick={copy}>copy</button>}
        {events.length > 0 && <button className="link small" onClick={watch.clear}>clear</button>}
      </div>
      <div className={`watch-status small ${watch.error ? 'error' : 'muted'}`}>
        {watch.error
          ? <>Couldn't read the row{watch.watching ? ', trying again' : ', so watching stopped'}: {watch.error}</>
          : watch.watching
            ? <>Reading the row every {every(interval)}{watch.checkedAt && <> · last read {timeOf(watch.checkedAt)}</>}. Changes made between two reads show as one.</>
            : <>Not watching. Press Watch to carry on.</>}
      </div>
      {plan && (plan.watched.length > 0 || plan.skipped.length > 0) && (
        <div className="watch-related small">
          {plan.watched.length > 0
            ? <>With {plan.watched.length} related table{plan.watched.length === 1 ? '' : 's'}: {plan.watched.map((c, i) => {
                const state = watch.children[c.id]
                const note = !state ? '' : 'rows' in state ? ` (${state.rows})` : 'error' in state ? " (couldn't read)" : ' (too many rows now, stopped)'
                return (
                  <span key={c.id} className={state && !('rows' in state) ? 'watch-child-problem' : undefined} title={state && 'error' in state ? state.error : undefined}>
                    {i > 0 && ', '}{c.source.connection ? `${c.source.connection}: ` : ''}{c.source.table}{note}
                  </span>
                )
              })}.</>
            : <>No related tables are watched.</>}
          {plan.skipped.length > 0 && <> <button className="link small" onClick={() => setShowSkipped((s) => !s)}>{showSkipped ? 'hide' : `${plan.skipped.length} not watched`}</button></>}
          {showSkipped && (
            <ul className="watch-skipped">
              {plan.skipped.map((s) => <li key={s.id}><span className="watch-column">{s.label}</span> <span className="muted">{s.reason}</span></li>)}
            </ul>
          )}
        </div>
      )}
      {watch.gone && <div className="watch-gone small">The row isn't there any more: it was deleted, or its key changed. The details show its last values.</div>}
      {!events.length && watch.watching && <div className="muted small pad">No changes yet.</div>}
      <ol className="watch-events">
        {events.map((e, i) => <WatchEventRow key={`${e.at}-${i}`} event={e} />)}
      </ol>
    </section>
  )
}

/** Values of an added or removed related row shown before "+N more". */
const ROW_VALUES_SHOWN = 8

function WatchEventRow({ event }: { event: WatchEvent }) {
  const [all, setAll] = useState(false)
  const value = (v: CellValue) => <span className={v === null ? 'null' : undefined}>{displayValue(v)}</span>
  const values = (list: RowValue[]) => (
    <div className="watch-values">
      {(all ? list : list.slice(0, ROW_VALUES_SHOWN)).map((v) => <span key={v.column}><span className="watch-column">{v.column}</span> {value(v.value)}</span>)}
      {!all && list.length > ROW_VALUES_SHOWN && <button className="link small" onClick={() => setAll(true)}>+{list.length - ROW_VALUES_SHOWN} more</button>}
    </div>
  )
  const related = event.kind === 'added' || event.kind === 'removed' || event.kind === 'rowChanged'
  return (
    <li className={`watch-event ${event.kind}${related ? ' related' : ''}`}>
      <span className="watch-time">{timeOf(event.at)}</span>
      <div className="watch-detail">
        <strong className="watch-what">{eventTitle(event, displayValue)}{event.kind === 'back' && !event.cells.length ? ', unchanged' : ''}</strong>
        {(event.kind === 'added' || event.kind === 'removed') && values(event.values)}
        {(event.kind === 'changed' || event.kind === 'back' || event.kind === 'rowChanged') && event.cells.map((c) => (
          <div key={c.column} className="watch-cell">
            <span className="watch-column">{c.column}</span>
            <span className="before">{value(c.before)}</span>
            <span className="muted">→</span>
            <span className="after">{value(c.after)}</span>
          </div>
        ))}
      </div>
    </li>
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
  const [previewError, setPreviewError] = useState<string | null>(null)
  const target = connection(relation.connectionId)
  const filter: ColumnFilter = { column: relation.column, op: '=', value: relation.value }
  const c = relation.count

  useEffect(() => {
    if (!open || preview) return
    setPreviewError(null)
    Promise.all([
      describe(relation.connectionId, relation.table),
      window.api.fetchRows(relation.connectionId, { table: relation.table, limit: PREVIEW_ROWS, offset: 0, filters: [filter] })
    ]).then(([details, rows]) => setPreview({ details, rows })).catch((e) => setPreviewError((e as Error).message))
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
        <button
          className="relation-toggle"
          disabled={!hasRows}
          title={hasRows ? (open ? 'Hide preview' : `Show the first ${PREVIEW_ROWS} rows`) : undefined}
          aria-expanded={hasRows ? open : undefined}
          onClick={() => setOpen((o) => !o)}
        >{hasRows ? (open ? '▾' : '▸') : ''}</button>
        <span className="relation-name">
          {!local && <><span className="env-dot" /><span className="cross-conn">{target?.name}</span></>}
          {relation.table.name}<span className="muted">.{relation.column}</span>
        </span>
        <span className={`count-pill ${c?.status ?? 'pending'} ${hasRows ? 'has' : ''}`} title={c?.status === 'skipped' ? c.reason : c?.status === 'error' ? c.message : c?.status === 'timeout' ? 'Took too long to count, so counting stopped' : undefined}>{badge}</span>
        {(c?.status === 'skipped' || c?.status === 'timeout') && <button className="link small" onClick={onCountAnyway}>count anyway</button>}
        {hasRows && <button className="link small" {...link({ kind: 'table', connectionId: relation.connectionId, table: relation.table, filters: [filter] })}>open all</button>}
      </div>
      {open && (
        <div className="relation-preview">
          {!preview ? (previewError ? <div className="conn-error">Couldn't read the rows: {previewError}</div> : <div className="muted small">Loading…</div>) : (() => {
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
