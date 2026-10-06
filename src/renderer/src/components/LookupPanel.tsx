import { useEffect, useMemo, useRef, useState } from 'react'
import type { CellValue, ColumnInfo, ConnectionConfig } from '@shared/types'
import { LOOKUP_LIMIT } from '@shared/lookups'
import { displayValue, formatCount } from '../lib/format'
import { useLookupLabel, useLookupList, type ColumnLookup } from '../lib/lookups'
import { LoadingBar } from './DataGrid'
import { toast } from './Toast'

const sameKey = (a: CellValue, b: CellValue | undefined): boolean => b !== undefined && a !== null && b !== null && String(a).toLowerCase() === String(b).toLowerCase()

/**
 * The side panel for a lookup column: the table its values point into, with labels, searchable,
 * the current cell's value highlighted. Clicking a value sets the cell when the grid is editable.
 */
export function LookupPanel({ conn, column, lookup, targetRows, value, setBlocked, onPick, onSetUp, onShowRow, onClose }: {
  conn: ConnectionConfig
  /** The lookup table's row estimate; big tables are searched rather than listed. */
  targetRows?: number
  column: ColumnInfo
  lookup: ColumnLookup
  /** The active cell's value; undefined when no row is selected. */
  value: CellValue | undefined
  /** Why the cell can't be set from here, or null when it can. */
  setBlocked: string | null
  onPick(key: CellValue): void
  onSetUp(): void
  onShowRow?(): void
  onClose(): void
}) {
  const { link } = lookup
  const [search, setSearch] = useState('')
  const [all, setAll] = useState(false)
  useEffect(() => {
    setSearch('')
    setAll(false)
  }, [link.target.name, link.column])
  const list = useLookupList(conn, lookup, all, search, targetRows)
  const current = useLookupLabel(conn, lookup, value)

  const items = useMemo(() => {
    if (list.status !== 'ready') return []
    const needle = search.trim().toLowerCase()
    if (list.searched || !needle) return list.items
    return list.items.filter((i) => i.label.toLowerCase().includes(needle) || displayValue(i.key).toLowerCase().includes(needle))
  }, [list, search])

  // Bring the current value into view when the list (or the row) changes.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector('.lookup-item.current')?.scrollIntoView({ block: 'center' })
  }, [items, value])

  const pick = (key: CellValue): void => {
    if (setBlocked) {
      window.api.copy(displayValue(key))
      toast('Copied the key')
    } else {
      onPick(key)
    }
  }

  return (
    <aside className="inspector lookup-panel">
      <header>
        <span className="lookup-title" title={`${column.name} → ${link.target.name}.${link.key}`}>
          Lookup <span className="muted">{column.name} → {link.target.name}</span>
        </span>
        <span className="grow" />
        {onShowRow && <button className="ghost small" onClick={onShowRow} title="Show the whole row instead">Row details</button>}
        <button className="icon" onClick={onSetUp} title={lookup.manual ? 'Change or remove this lookup' : 'Choose the label columns, or narrow the list'}>⚙</button>
        <button className="icon" onClick={onClose} title="Close (Esc)">✕</button>
      </header>

      <div className="lookup-current">
        {value === undefined ? <span className="muted">Select a row to see its value here.</span>
          : value === null ? <span className="muted">This cell is NULL.</span>
            : (
              <>
                <strong>{current?.label || (current ? '(no label)' : '…')}</strong>
                <code title={displayValue(value)}>{displayValue(value)}</code>
              </>
            )}
      </div>

      <div className="lookup-tools">
        <input className="search" placeholder={`Search ${link.target.name}…`} value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSearch('')} />
        {link.narrowBy && (
          <label className="muted" title={`Only rows whose ${link.narrowBy} matches the values this column already uses`}>
            <input type="checkbox" checked={!all} onChange={(e) => setAll(!e.target.checked)} /> same {link.narrowBy} only
          </label>
        )}
      </div>

      <div className="lookup-list" ref={listRef}>
        {list.status === 'loading' && <LoadingBar label="Reading values…" overlay={false} />}
        {list.status === 'error' && <div className="conn-error">{list.error}</div>}
        {list.status === 'too-big' && (
          <div className="muted pad">{link.target.name} has about {formatCount(list.rows)} rows, too many to list. Search to find one.</div>
        )}
        {items.map((item, i) => (
          <button
            key={i}
            className={`lookup-item ${sameKey(item.key, value) ? 'current' : ''}`}
            title={setBlocked ? `${setBlocked}\nClick to copy the key` : `Set ${column.name} to ${item.label || displayValue(item.key)}`}
            onClick={() => pick(item.key)}
          >
            <span className="lookup-label">{item.label || <span className="muted">(no label)</span>}</span>
            <code className="lookup-key">{displayValue(item.key)}</code>
          </button>
        ))}
        {list.status === 'ready' && !items.length && <div className="muted pad">{search.trim() ? 'No matches' : 'No values'}</div>}
      </div>

      {list.status === 'ready' && (
        <div className="lookup-foot muted">
          {formatCount(items.length)} value{items.length === 1 ? '' : 's'}
          {list.truncated && ` (the first ${formatCount(LOOKUP_LIMIT)}; search to find others)`}
          {list.narrowed && ` · same ${link.narrowBy} as this column's values`}
          {setBlocked ? ` · ${setBlocked}` : ' · click one to set the cell'}
        </div>
      )}
    </aside>
  )
}
