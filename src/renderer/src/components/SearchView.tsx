import { useEffect, useMemo, useRef, useState } from 'react'
import type { RelatedCount } from '@shared/types'
import { SEARCH_LARGE_TABLE_ROWS, SHAPE_LABELS, type SearchColumn, type SearchPlan } from '@shared/valueSearch'
import { useAppState, useTableList, type Tab } from '../state'
import { formatCount } from '../lib/format'
import { useOpenLink } from '../lib/openLink'
import { recordKey } from './RecordView'
import { toast } from './Toast'

/**
 * Lookups sent per request, and requests in flight at once, so results stream in. countRelated runs
 * up to four of a request's lookups together, so shared servers get one request at a time.
 */
const SEARCH_CHUNK = 4
const LOCAL_LANES = 3
const SHARED_LANES = 1

const columnId = (c: SearchColumn): string => `${c.table.schema}.${c.table.name}.${c.column}`

type Status = 'idle' | 'planning' | 'running' | 'stopped' | 'done'

/**
 * Find value: which tables and columns of a connection hold a value. The plan (which columns could
 * hold it) comes from the main process; the lookups run here through countRelated, so they stream
 * in and can be stopped.
 */
export function SearchView({ tab }: { tab: Extract<Tab, { kind: 'search' }> }) {
  const { connection, rememberTab, environment, safety } = useAppState()
  useTableList(tab.connectionId)
  const conn = connection(tab.connectionId)
  const [input, setInput] = useState(tab.value)
  const [searched, setSearched] = useState('')
  const [plan, setPlan] = useState<SearchPlan | null>(null)
  const [counts, setCounts] = useState<Record<string, RelatedCount>>({})
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)
  const [showEmpty, setShowEmpty] = useState(false)
  const runToken = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const lookup = async (token: number, value: string, columns: SearchColumn[], force = false): Promise<void> => {
    const chunks: SearchColumn[][] = []
    for (let i = 0; i < columns.length; i += SEARCH_CHUNK) chunks.push(columns.slice(i, i + SEARCH_CHUNK))
    let next = 0
    const lane = async (): Promise<void> => {
      while (runToken.current === token && next < chunks.length) {
        const chunk = chunks[next++]
        let results: RelatedCount[]
        try {
          results = await window.api.countRelated(tab.connectionId, chunk.map((c) => ({ table: c.table, column: c.column, value, force })))
        } catch (e) {
          results = chunk.map(() => ({ status: 'error', message: (e as Error).message }))
        }
        if (runToken.current !== token) return
        setCounts((prev) => {
          const out = { ...prev }
          chunk.forEach((c, i) => { out[columnId(c)] = results[i] })
          return out
        })
      }
    }
    const lanes = conn && safety(conn) === 'relaxed' ? LOCAL_LANES : SHARED_LANES
    await Promise.all(Array.from({ length: lanes }, lane))
  }

  const search = async (raw: string): Promise<void> => {
    const value = raw.trim()
    const token = ++runToken.current
    setCounts({})
    setError(null)
    setShowSkipped(false)
    if (!value) {
      setPlan(null)
      setStatus('idle')
      return
    }
    rememberTab(tab.id, { value })
    setSearched(value)
    setStatus('planning')
    try {
      const next = await window.api.planValueSearch(tab.connectionId, value)
      if (runToken.current !== token) return
      setPlan(next)
      setStatus('running')
      if (next) await lookup(token, next.shape.value, next.columns)
      if (runToken.current === token) setStatus('done')
    } catch (e) {
      if (runToken.current !== token) return
      setError((e as Error).message)
      setStatus('idle')
    }
  }

  const stop = (): void => {
    runToken.current++
    setStatus('stopped')
  }

  // Stop looking when the tab closes.
  useEffect(() => () => { runToken.current++ }, [])

  // Asked to search from elsewhere (a cell's right-click menu); a restored tab waits.
  useEffect(() => {
    if (!tab.run) {
      inputRef.current?.focus()
      return
    }
    setInput(tab.value)
    search(tab.value)
  }, [tab.run?.seq])

  /** Runs lookups for columns that were skipped or timed out, ignoring the size limit. */
  const searchAnyway = async (columns: SearchColumn[]): Promise<void> => {
    if (!plan) return
    const token = runToken.current
    setCounts((prev) => {
      const out = { ...prev }
      for (const c of columns) delete out[columnId(c)]
      return out
    })
    setPlan((p) => p && ({ ...p, columns: [...p.columns, ...columns.filter((c) => !p.columns.includes(c))], skipped: p.skipped.filter((c) => !columns.includes(c)) }))
    await lookup(token, plan.shape.value, columns, true)
  }

  const groups = useMemo(() => {
    const found: { column: SearchColumn; count: Extract<RelatedCount, { status: 'ok' }> }[] = []
    const problems: { column: SearchColumn; count: Exclude<RelatedCount, { status: 'ok' }> }[] = []
    const empty: SearchColumn[] = []
    let pending = 0
    for (const c of plan?.columns ?? []) {
      const count = counts[columnId(c)]
      if (!count) pending++
      else if (count.status !== 'ok') problems.push({ column: c, count })
      else if (count.count > 0) found.push({ column: c, count })
      else empty.push(c)
    }
    found.sort((a, b) => b.count.count - a.count.count || a.column.table.name.localeCompare(b.column.table.name))
    return { found, problems, empty, pending }
  }, [plan, counts])

  if (!conn) return null
  const total = plan?.columns.length ?? 0
  const done = total - groups.pending
  const busy = status === 'planning' || status === 'running'
  const env = environment(conn.env)

  return (
    <div className="view search-view">
      <form className="search-head" onSubmit={(e) => { e.preventDefault(); search(input) }}>
        <input
          ref={inputRef}
          className="search-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Paste a GUID, an email, an id…"
          spellCheck={false}
        />
        {busy
          ? <button type="button" onClick={stop}>Stop</button>
          : <button type="submit" className="primary" disabled={!input.trim()}>Find</button>}
        <span className="muted small">in {conn.name} ({env.name})</span>
      </form>

      <div className="search-body">
        {error && <div className="error-bar">{error}</div>}
        {status === 'idle' && !error && (
          <div className="muted small search-intro">
            Finds which tables hold a value, by exact match. Only columns that could hold it are read: GUID-sized columns for a GUID, id columns for a
            number, text columns for an email. Indexed columns are looked up first; unindexed ones only on tables under {formatCount(SEARCH_LARGE_TABLE_ROWS)} rows.
            Right-click a cell in any grid and choose <strong>Find this value everywhere</strong> to start from there.
          </div>
        )}
        {status === 'planning' && <div className="muted small">Working out which columns to look in…</div>}
        {plan === null && status === 'done' && <div className="muted small">Nothing to look for.</div>}

        {plan && (
          <>
            <div className="search-status small">
              Looking for {SHAPE_LABELS[plan.shape.kind] === 'email address' ? 'an' : 'a'} {SHAPE_LABELS[plan.shape.kind]} in {formatCount(total)} column{total === 1 ? '' : 's'}
              {' '}· {formatCount(done)} searched · <strong>{formatCount(groups.found.length)} found</strong>
              {status === 'running' && <span className="muted"> · searching…</span>}
              {status === 'stopped' && <span className="muted"> · stopped</span>}
              {status === 'running' && <div className="search-progress"><div style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>}
            </div>
            {plan.truncated && <div className="muted small">The schema has more matching columns than are searched at once; only the first {formatCount(total)} were.</div>}

            {groups.found.length > 0 && (
              <section>
                <div className="section-title">Found in</div>
                {groups.found.map(({ column, count }) => (
                  <FoundRow key={columnId(column)} connectionId={tab.connectionId} column={column} value={plan.shape.value} count={count} />
                ))}
              </section>
            )}
            {status === 'done' && groups.found.length === 0 && <div className="search-none">No matches for <code>{searched}</code> in the columns searched.</div>}

            {groups.problems.length > 0 && (
              <section>
                <div className="section-title">Couldn't search ({groups.problems.length})</div>
                {groups.problems.map(({ column, count }) => (
                  <div key={columnId(column)} className="search-row">
                    <span className="search-name">{column.table.name}<span className="muted">.{column.column}</span></span>
                    <span className="muted small">{count.status === 'timeout' ? 'too slow, stopped' : count.status === 'skipped' ? count.reason : count.message}</span>
                    {count.status !== 'error' && <button className="link small" onClick={() => searchAnyway([column])}>search anyway</button>}
                  </div>
                ))}
              </section>
            )}

            <div className="muted small search-notes">
              {groups.empty.length > 0 && <button className="link small" onClick={() => setShowEmpty((s) => !s)}>{showEmpty ? 'Hide' : 'Show'} {formatCount(groups.empty.length)} column{groups.empty.length === 1 ? '' : 's'} with no match</button>}
              {plan.skipped.length > 0 && (
                <span>
                  {formatCount(plan.skipped.length)} unindexed column{plan.skipped.length === 1 ? '' : 's'} on big tables not searched.{' '}
                  <button className="link small" onClick={() => setShowSkipped((s) => !s)}>{showSkipped ? 'hide' : 'show'}</button>
                </span>
              )}
              {plan.unlikely > 0 && <span>{formatCount(plan.unlikely)} other column{plan.unlikely === 1 ? '' : 's'} could hold it but aren't indexed or named like one, so weren't read.</span>}
            </div>
            {showEmpty && (
              <div className="search-list">
                {groups.empty.map((c) => <div key={columnId(c)} className="muted small">{c.table.name}.{c.column}</div>)}
              </div>
            )}
            {showSkipped && plan.skipped.length > 0 && (
              <div className="search-list">
                {plan.skipped.map((c) => (
                  <div key={columnId(c)} className="search-row">
                    <span className="search-name">{c.table.name}<span className="muted">.{c.column}</span></span>
                    <span className="muted small">~{formatCount(c.rowEstimate ?? 0)} rows, not indexed</span>
                    <button className="link small" onClick={() => searchAnyway([c])}>search anyway</button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function FoundRow({ connectionId, column, value, count }: { connectionId: string; column: SearchColumn; value: string; count: Extract<RelatedCount, { status: 'ok' }> }) {
  const { openRecord } = useAppState()
  const link = useOpenLink()
  const filter = { column: column.column, op: '=' as const, value }

  /** Finds the one matching row's primary key and opens it in the explorer. */
  const openOne = async (watch: boolean): Promise<void> => {
    try {
      const [details, rows] = await Promise.all([
        window.api.describeTable(connectionId, column.table),
        window.api.fetchRows(connectionId, { table: column.table, limit: 1, offset: 0, filters: [filter] })
      ])
      const key = rows.rows[0] ? recordKey(details, rows.columns, rows.rows[0]) : null
      if (key) openRecord(connectionId, column.table, key, undefined, watch)
      else toast(rows.rows[0] ? `${column.table.name} has no primary key, so the row can't be opened on its own` : 'The row has gone since', true)
    } catch (e) {
      toast((e as Error).message, true)
    }
  }

  return (
    <div className="search-row found">
      <span className="search-name">
        {column.table.schema && <span className="muted">{column.table.schema}.</span>}{column.table.name}<span className="muted">.</span><strong>{column.column}</strong>
        {column.isPrimaryKey && <span className="search-tag">PK</span>}
        {!column.indexed && <span className="search-tag dim" title="Read by scanning: the table is small enough">not indexed</span>}
      </span>
      <span className="muted small search-type">{column.dataType}</span>
      <span className="count-pill has">{formatCount(count.count)}{count.capped ? '+' : ''}</span>
      <button className="link small" title="Shift+click or drag to open beside" {...link({ kind: 'table', connectionId, table: column.table, filters: [filter] })}>open rows</button>
      {count.count === 1 && !count.capped && (
        <>
          <button className="link small" onClick={() => openOne(false)}>explore</button>
          <button className="link small" onClick={() => openOne(true)}>watch</button>
        </>
      )}
    </div>
  )
}
