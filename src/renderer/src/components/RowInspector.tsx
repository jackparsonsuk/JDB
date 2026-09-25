import { useState } from 'react'
import type { CellValue, ColumnFilter, ColumnInfo, CrossLink, DbKind, ReverseReference, TableRef } from '@shared/types'
import { displayValue, formatRows, quoteIdent, sqlLiteral } from '../lib/format'
import { toast } from './Toast'

interface Props {
  kind: DbKind
  table?: TableRef
  columns: string[]
  row: CellValue[]
  columnInfo?: Map<string, ColumnInfo>
  referencedBy?: ReverseReference[]
  onOpen?(table: TableRef, filters: ColumnFilter[]): void
  cross?: CrossLinkProps
  onClose(): void
}

export interface CrossLinkProps {
  /** Links whose reference column is in this table. */
  outgoing: CrossLink[]
  /** Links from other databases pointing at a key in this table. */
  incoming: CrossLink[]
  connection(id: string): { name: string; env: string } | undefined
  open(connectionId: string, table: TableRef, filters: ColumnFilter[]): void
}

/** Incoming links can be numerous (audit columns on dozens of tables); show a few, expandable. */
const INCOMING_PREVIEW = 6

/** Pretty-prints values that are JSON objects or arrays, which are common in text columns. */
function prettyJson(value: CellValue): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) return null
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2)
  } catch {
    return null
  }
}

export function RowInspector({ kind, table, columns, row, columnInfo, referencedBy, onOpen, cross, onClose }: Props) {
  const valueOf = (column: string): CellValue => row[columns.indexOf(column)]
  const copy = (text: string, what: string): void => {
    window.api.copy(text)
    toast(`Copied ${what}`)
  }

  const keyColumns = columns.filter((c) => columnInfo?.get(c)?.isPrimaryKey)
  const whereColumns = keyColumns.length ? keyColumns : columns
  const whereClause = whereColumns
    .map((c) => {
      const v = valueOf(c)
      return v === null ? `${quoteIdent(kind, c)} IS NULL` : `${quoteIdent(kind, c)} = ${sqlLiteral(v)}`
    })
    .join(' AND ')

  return (
    <aside className="inspector">
      <header>
        <span>Row details</span>
        <button className="icon" onClick={onClose} title="Close (Esc)">✕</button>
      </header>

      <div className="inspector-actions">
        <button onClick={() => copy(formatRows('json', columns, [row]).replace(/^\[\n|\n\]$/g, ''), 'row as JSON')}>JSON</button>
        <button onClick={() => copy(formatRows('insert', columns, [row], { kind, table }), 'INSERT')}>INSERT</button>
        <button onClick={() => copy(`WHERE ${whereClause}`, 'WHERE clause')}>WHERE</button>
      </div>

      <div className="inspector-fields">
        {columns.map((column, i) => {
          const info = columnInfo?.get(column)
          const value = row[i]
          const json = prettyJson(value)
          return (
            <div key={column} className="field">
              <div className="field-head">
                <span className="field-name">
                  {info?.isPrimaryKey && <span className="badge pk">PK</span>}
                  {column}
                </span>
                <span className="field-type">{info?.dataType}</span>
                <button className="icon small" title="Copy value" onClick={() => copy(value === null ? '' : String(value), column)}>⧉</button>
              </div>
              <div className={`field-value ${value === null ? 'null' : ''}`}>
                {json ? <pre>{json}</pre> : displayValue(value)}
              </div>
              {info?.references && value !== null && onOpen && (
                <button
                  className="link"
                  onClick={() => onOpen(
                    { schema: info.references!.schema, name: info.references!.name },
                    [{ column: info.references!.column, op: '=', value: String(value) }]
                  )}
                >
                  → {info.references.name}.{info.references.column}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {referencedBy && referencedBy.length > 0 && onOpen && (
        <div className="inspector-refs">
          <div className="section-title">Referenced by</div>
          {referencedBy.map((ref) => {
            const value = valueOf(ref.referencedColumn)
            return (
              <button
                key={`${ref.table.schema}.${ref.table.name}.${ref.column}`}
                className="ref"
                disabled={value === null || value === undefined}
                onClick={() => onOpen(ref.table, [{ column: ref.column, op: '=', value: String(value) }])}
              >
                <span>{ref.table.name}</span>
                <span className="muted">.{ref.column}</span>
              </button>
            )
          })}
        </div>
      )}

      {cross && (cross.outgoing.length > 0 || cross.incoming.length > 0) && (
        <CrossLinks cross={cross} valueOf={valueOf} />
      )}
    </aside>
  )
}

function CrossLinks({ cross, valueOf }: { cross: CrossLinkProps; valueOf(column: string): CellValue }) {
  const [showAll, setShowAll] = useState(false)
  const usable = (v: CellValue): v is string | number | boolean => v !== null && v !== undefined
  const outgoing = cross.outgoing.filter((l) => usable(valueOf(l.from.column)))
  const incoming = cross.incoming.filter((l) => usable(valueOf(l.to.column)))
  const shown = showAll ? incoming : incoming.slice(0, INCOMING_PREVIEW)

  const Target = ({ connectionId, label }: { connectionId: string; label: string }) => {
    const conn = cross.connection(connectionId)
    return (
      <>
        {/* The env class sits on both so they take the target connection's colour, not the current tab's. */}
        <span className={`env-dot env-${conn?.env ?? 'local'}`} />
        <span className={`cross-conn env-${conn?.env ?? 'local'}`}>{conn?.name}</span>
        <span>{label}</span>
      </>
    )
  }

  return (
    <div className="inspector-refs cross">
      <div className="section-title">Linked in other databases</div>
      {outgoing.map((l) => {
        const value = valueOf(l.from.column)
        return (
          <button key={l.id} className="ref cross-ref" onClick={() => cross.open(l.to.connectionId, l.to.table, [{ column: l.to.column, op: '=', value: String(value) }])}>
            <Target connectionId={l.to.connectionId} label={`${l.to.table.name} (${l.from.column} ${displayValue(value)})`} />
          </button>
        )
      })}
      {shown.map((l) => {
        const value = valueOf(l.to.column)
        return (
          <button key={l.id} className="ref cross-ref" onClick={() => cross.open(l.from.connectionId, l.from.table, [{ column: l.from.column, op: '=', value: String(value) }])}>
            <Target connectionId={l.from.connectionId} label={`${l.from.table.name}.${l.from.column}`} />
          </button>
        )
      })}
      {incoming.length > INCOMING_PREVIEW && (
        <button className="link small" onClick={() => setShowAll((s) => !s)}>
          {showAll ? 'show fewer' : `+${incoming.length - INCOMING_PREVIEW} more`}
        </button>
      )}
    </div>
  )
}
