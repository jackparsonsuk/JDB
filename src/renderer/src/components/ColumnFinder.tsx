import { useMemo, useState } from 'react'
import type { ColumnInfo } from '@shared/types'
import { fuzzyScore } from '../lib/fuzzy'

const MAX_MATCHES = 30

/** Type part of a column name to jump the grid to it, for wide tables. */
export function ColumnFinder({ columns, columnInfo, onPick }: {
  columns: string[]
  columnInfo?: Map<string, ColumnInfo>
  onPick(column: string): void
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [index, setIndex] = useState(0)

  const matches = useMemo(() => {
    const q = query.trim()
    if (!q) return columns.slice(0, MAX_MATCHES)
    return columns
      .map((name) => ({ name, score: fuzzyScore(q, name) }))
      .filter((m) => m.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHES)
      .map((m) => m.name)
  }, [columns, query])

  const pick = (name: string | undefined): void => {
    if (!name) return
    onPick(name)
    setOpen(false)
  }

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(matches.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      pick(matches[index])
    } else if (e.key === 'Escape') {
      setOpen(false)
      e.currentTarget.blur()
    }
  }

  return (
    <span className="column-finder">
      <input
        className="search"
        placeholder={`Find column (${columns.length})…`}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setIndex(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey}
      />
      {open && matches.length > 0 && (
        <div className="column-finder-list" onMouseDown={(e) => e.preventDefault()}>
          {matches.map((name, i) => {
            const info = columnInfo?.get(name)
            return (
              <button key={name} className={i === index ? 'on' : ''} onMouseEnter={() => setIndex(i)} onClick={() => pick(name)}>
                <span className="column-finder-name">
                  {info?.isPrimaryKey && <span className="badge pk">PK</span>}
                  {info?.references && <span className="badge fk">FK</span>}
                  {name}
                </span>
                <span className="muted">{info?.dataType}</span>
              </button>
            )
          })}
        </div>
      )}
    </span>
  )
}
