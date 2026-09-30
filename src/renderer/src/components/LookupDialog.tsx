import { useEffect, useMemo, useState } from 'react'
import type { ColumnInfo, ConnectionConfig, TableInfo, TableRef } from '@shared/types'
import { defaultLabels, guessNarrowBy, type LookupLink } from '@shared/lookups'
import { deleteLookup, describeCached, saveLookup, type ColumnLookup } from '../lib/lookups'
import { toast } from './Toast'

const nameOf = (t: TableRef): string => `${t.schema}.${t.name}`

/** Finds a table by "schema.name", or by name alone when only one schema has it. */
function resolveTable(tables: TableInfo[], text: string): TableInfo | undefined {
  const wanted = text.trim().toLowerCase()
  if (!wanted) return undefined
  const exact = tables.find((t) => nameOf(t).toLowerCase() === wanted)
  if (exact) return exact
  const byName = tables.filter((t) => t.name.toLowerCase() === wanted)
  return byName.length === 1 ? byName[0] : undefined
}

/** Sets up which table a column's values are keys into, and what to show for them. */
export function LookupDialog({ conn, table, column, existing, tables, onClose }: {
  conn: ConnectionConfig
  table: TableRef
  column: ColumnInfo
  /** The lookup in use now: set up by hand, or from a declared foreign key. */
  existing?: ColumnLookup | null
  tables: TableInfo[]
  onClose(): void
}) {
  const start = existing?.link
  const [targetText, setTargetText] = useState(start ? nameOf(start.target) : '')
  const target = resolveTable(tables, targetText)
  const [columns, setColumns] = useState<ColumnInfo[] | null>(null)
  const [key, setKey] = useState(start?.key ?? '')
  const [labels, setLabels] = useState<string[]>(start?.labels ?? [])
  const [narrowBy, setNarrowBy] = useState(start?.narrowBy ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reading a new target fills in its key, label and kind column; the one already set up keeps its choices.
  const targetKey = target ? nameOf(target) : ''
  useEffect(() => {
    setColumns(null)
    if (!target) return
    let live = true
    describeCached(conn.id, target).then((d) => {
      if (!live) return
      setColumns(d.columns)
      if (start && nameOf(start.target).toLowerCase() === targetKey.toLowerCase()) return
      const keys = d.columns.filter((c) => c.isPrimaryKey)
      const k = keys.length === 1 ? keys[0].name : d.columns.find((c) => c.name.toLowerCase() === 'id')?.name ?? d.columns[0]?.name ?? ''
      setKey(k)
      setLabels(defaultLabels(d.columns, target.name))
      setNarrowBy(guessNarrowBy(d.columns, k) ?? '')
    }, (e) => live && setError((e as Error).message))
    return () => { live = false }
  }, [conn.id, targetKey])

  const options = useMemo(() => tables.filter((t) => !(t.schema === table.schema && t.name === table.name)).map(nameOf), [tables, table])
  const toggleLabel = (name: string): void => setLabels((l) => (l.includes(name) ? l.filter((x) => x !== name) : [...l, name]))

  const save = async (): Promise<void> => {
    if (!target || !columns || !key) return
    setSaving(true)
    try {
      const link: LookupLink = {
        id: existing?.manual ? existing.link.id : '',
        connectionId: conn.id,
        table,
        column: column.name,
        target: { schema: target.schema, name: target.name },
        key,
        labels,
        ...(narrowBy && { narrowBy })
      }
      await saveLookup(link)
      toast(`${column.name} now looks up ${target.name}`)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!existing?.manual) return
    setSaving(true)
    try {
      await deleteLookup(existing.link.id)
      toast(column.references ? `${column.name} is back to its foreign key` : `Removed the lookup for ${column.name}`)
      onClose()
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={() => !saving && onClose()}>
      <div
        className="dialog lookup-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !saving) onClose()
        }}
      >
        <h2>Look up {column.name}</h2>
        <p className="muted">Say which table {column.name}'s values are keys into and what to show for them. Selecting a {column.name} cell then lists that table's values in the side panel.</p>
        <div className="form">
          <label>
            Table
            <input autoFocus list="lookup-tables" value={targetText} onChange={(e) => setTargetText(e.target.value)} placeholder="e.g. lookups" />
            <datalist id="lookup-tables">{options.map((o) => <option key={o} value={o} />)}</datalist>
          </label>
          {targetText.trim() && !target && <div className="field-hint field-warn">No table called “{targetText.trim()}” on {conn.name}.</div>}
          {columns && (
            <>
              <label>
                Key column <span className="muted">(what {column.name} holds)</span>
                <select value={key} onChange={(e) => setKey(e.target.value)}>
                  {columns.map((c) => <option key={c.name} value={c.name}>{c.name} · {c.dataType}</option>)}
                </select>
              </label>
              <div className="lookup-dialog-labels">
                <span>Show <span className="muted">(label columns, joined with ·)</span></span>
                <div className="lookup-dialog-columns">
                  {columns.filter((c) => c.name !== key).map((c) => (
                    <label key={c.name} className="check">
                      <input type="checkbox" checked={labels.includes(c.name)} onChange={() => toggleLabel(c.name)} />
                      {c.name} <span className="muted">{c.dataType}</span>
                    </label>
                  ))}
                </div>
              </div>
              <label>
                Only the same kind <span className="muted">(for a table holding many kinds of lookup)</span>
                <select value={narrowBy} onChange={(e) => setNarrowBy(e.target.value)}>
                  <option value="">No, list every row</option>
                  {columns.filter((c) => c.name !== key).map((c) => <option key={c.name} value={c.name}>Same {c.name} as the column's values</option>)}
                </select>
              </label>
            </>
          )}
        </div>
        {error && <div className="status error">{error}</div>}
        <div className="dialog-actions">
          <button className="primary" disabled={saving || !target || !columns || !key} onClick={save}>Save lookup</button>
          {existing?.manual && <button className="danger" disabled={saving} onClick={remove}>Remove lookup</button>}
          <button className="ghost" disabled={saving} onClick={onClose} style={{ marginLeft: 'auto' }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
