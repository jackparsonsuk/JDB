import { useMemo, useState } from 'react'
import type { DbKind } from '@shared/types'
import { bindParams, type ParamMode, type ParamValue, type QueryParam } from '@shared/params'

/** Last values, by lowercased parameter name, so running again starts from them. */
const STORE_KEY = 'jdb.queryParams'

function remembered(): Record<string, ParamValue> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, ParamValue>
  } catch {
    return {}
  }
}

function remember(values: Record<string, ParamValue>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...remembered(), ...values }))
  } catch {
    // Storage can be unavailable; the values just aren't remembered.
  }
}

const MODES: { mode: ParamMode; label: string; title: string }[] = [
  { mode: 'auto', label: 'Auto', title: "Written to suit the column it's compared with, or as a number or text" },
  { mode: 'text', label: 'Text', title: 'Always quoted' },
  { mode: 'number', label: 'Number', title: 'Written as it is; must be a number' },
  { mode: 'null', label: 'NULL', title: 'NULL (use IS NULL to compare with it)' },
  { mode: 'sql', label: 'SQL', title: 'Written in exactly as typed, e.g. GETDATE() or a list' }
]

/** Asks for each parameter's value before a query runs; `onRun` gets the SQL with them filled in. */
export function ParamDialog({ sql, kind, params, onRun, onCancel }: {
  sql: string
  kind: DbKind
  params: QueryParam[]
  onRun(bound: string): void
  onCancel(): void
}) {
  const [values, setValues] = useState<Record<string, ParamValue>>(() => {
    const last = remembered()
    return Object.fromEntries(params.map((p) => [p.name.toLowerCase(), last[p.name.toLowerCase()] ?? { text: '', mode: 'auto' }]))
  })
  const [showSql, setShowSql] = useState(false)
  const set = (name: string, change: Partial<ParamValue>): void =>
    setValues((v) => ({ ...v, [name.toLowerCase()]: { ...v[name.toLowerCase()], ...change } }))

  const bound = useMemo((): { sql: string } | { error: string } => {
    try {
      return { sql: bindParams(sql, kind, params, values) }
    } catch (e) {
      return { error: (e as Error).message }
    }
  }, [sql, kind, params, values])

  const run = (): void => {
    if (!('sql' in bound)) return
    remember(values)
    onRun(bound.sql)
  }

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div
        className="dialog param-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && !(e.target instanceof HTMLSelectElement)) {
            e.preventDefault()
            run()
          }
        }}
      >
        <h2>Query parameters</h2>
        <div className="param-rows">
          {params.map((p, i) => {
            const value = values[p.name.toLowerCase()]
            return (
              <div key={p.name} className="param-row">
                <label htmlFor={`param-${i}`} className="param-name" title={`Used ${p.at.length} time${p.at.length === 1 ? '' : 's'}`}>
                  {sql.slice(p.at[0].from, p.at[0].to)}
                  {p.column && <span className="muted">{p.column.name} · {p.column.dataType}</span>}
                  {p.list && <span className="muted">a list: separate values with commas</span>}
                </label>
                <input
                  id={`param-${i}`}
                  autoFocus={i === 0}
                  value={value.mode === 'null' ? '' : value.text}
                  disabled={value.mode === 'null'}
                  placeholder={value.mode === 'null' ? 'NULL' : ''}
                  onChange={(e) => set(p.name, { text: e.target.value })}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <select value={value.mode} onChange={(e) => set(p.name, { mode: e.target.value as ParamMode })}>
                  {MODES.map((m) => <option key={m.mode} value={m.mode} title={m.title}>{m.label}</option>)}
                </select>
              </div>
            )
          })}
        </div>
        {'error' in bound && <div className="status error">{bound.error}</div>}
        {showSql && 'sql' in bound && <pre className="param-preview">{bound.sql}</pre>}
        <div className="dialog-actions">
          <button className="primary" disabled={!('sql' in bound)} onClick={run}>▶ Run</button>
          <button className="ghost" onClick={() => setShowSql((s) => !s)}>{showSql ? 'Hide SQL' : 'Show SQL'}</button>
          <button className="ghost" onClick={onCancel} style={{ marginLeft: 'auto' }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
