import { useState } from 'react'
import type { ConnectionConfig, TableInfo } from '@shared/types'
import { useAppState } from '../state'
import { fuzzyScore } from '../lib/fuzzy'
import { formatCount } from '../lib/format'

export function Sidebar({ onEdit, onNew }: { onEdit(c: ConnectionConfig): void; onNew(): void }) {
  const { connections } = useAppState()
  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <span className="brand">JDB</span>
        <button className="icon" title="New connection" onClick={onNew}>＋</button>
      </div>
      <div className="sidebar-list">
        {connections.map((c) => <ConnectionNode key={c.id} connection={c} onEdit={() => onEdit(c)} />)}
        {!connections.length && <div className="muted pad">No connections yet.</div>}
      </div>
      <div className="sidebar-foot muted">Ctrl+K to jump anywhere</div>
    </nav>
  )
}

function ConnectionNode({ connection, onEdit }: { connection: ConnectionConfig; onEdit(): void }) {
  const { tables, loadTables, forgetTables, openTable, openQuery } = useAppState()
  const [expanded, setExpanded] = useState(false)
  const [filter, setFilter] = useState('')
  const state = tables[connection.id]

  const toggle = (): void => {
    if (!expanded) loadTables(connection.id)
    setExpanded(!expanded)
  }

  const reconnect = async (): Promise<void> => {
    await window.api.disconnect(connection.id)
    forgetTables(connection.id)
    loadTables(connection.id, true)
  }

  const list = filterTables(state?.tables ?? [], filter)
  const schemas = new Set(list.map((t) => t.schema))
  const showSchema = schemas.size > 1

  return (
    <div className={`conn env-${connection.env}`}>
      <div className="conn-row" onClick={toggle}>
        <span className={`chevron ${expanded ? 'open' : ''}`}>›</span>
        <span className="env-dot" title={connection.env} />
        <span className="conn-name">{connection.name}</span>
        {connection.readOnly && <span className="lock" title="Read-only">🔒</span>}
        <span className="conn-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon small" title="Ask in plain English / new query (Ctrl+T)" onClick={() => openQuery(connection.id)}>✦</button>
          <button className="icon small" title="Reconnect and refresh" onClick={reconnect}>⟳</button>
          <button className="icon small" title="Edit connection" onClick={onEdit}>✎</button>
        </span>
      </div>

      {expanded && (
        <div className="conn-body">
          {state?.status === 'loading' && <div className="muted pad">Connecting…</div>}
          {state?.status === 'error' && (
            <div className="conn-error">
              <div>{state.error}</div>
              <div className="row-gap">
                <button onClick={() => loadTables(connection.id, true)}>Retry</button>
                <button onClick={onEdit}>Edit connection</button>
              </div>
            </div>
          )}
          {state?.status === 'ready' && (
            <>
              <input
                className="search"
                placeholder={`Filter ${state.tables.length} tables…`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="tables">
                {list.map((t) => (
                  <button
                    key={`${t.schema}.${t.name}`}
                    className="table-item"
                    onClick={() => openTable(connection.id, t)}
                    title={`${t.schema}.${t.name}${t.rowEstimate !== undefined ? ` · ~${formatCount(t.rowEstimate)} rows` : ''}`}
                  >
                    <span className="table-icon">{t.type === 'view' ? '◫' : '▦'}</span>
                    <span className="table-name">
                      {showSchema && <span className="muted">{t.schema}.</span>}
                      {t.name}
                    </span>
                    {t.rowEstimate !== undefined && <span className="table-rows">{compact(t.rowEstimate)}</span>}
                  </button>
                ))}
                {!list.length && <div className="muted pad">No matches</div>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function filterTables(tables: TableInfo[], filter: string): TableInfo[] {
  if (!filter.trim()) return tables
  return tables
    .map((t) => ({ t, score: fuzzyScore(filter, `${t.schema}.${t.name}`) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t)
}

function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
