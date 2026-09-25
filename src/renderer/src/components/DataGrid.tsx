import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { CellValue, ColumnInfo, DbKind, FilterOp, TableRef } from '@shared/types'
import { COPY_FORMATS, displayValue, formatRows, type CopyFormat } from '../lib/format'
import { useOpenLink } from '../lib/openLink'
import type { OpenTarget } from '../state'
import { toast } from './Toast'

const ROW_HEIGHT = 26
const OVERSCAN = 12
const ROW_NUMBER_WIDTH = 52

export interface Selection {
  rows: Set<number>
  active: number | null
}

interface Props {
  columns: string[]
  rows: CellValue[][]
  /** Row number shown in the gutter for index 0, so paged results keep absolute numbering. */
  rowOffset?: number
  columnInfo?: Map<string, ColumnInfo>
  sort?: { column: string; dir: 'asc' | 'desc' }
  onSort?(column: string): void
  selection: Selection
  onSelectionChange(selection: Selection): void
  /** Where a foreign key cell's ↗ button goes; the button can also be dragged into a pane. */
  referenceTarget?(column: ColumnInfo, value: CellValue): OpenTarget
  /** Columns linked to another database: tooltip and env class for the jump button. */
  crossLinks?: Map<string, { title: string; env: string }>
  crossLinkTarget?(column: string, value: CellValue): OpenTarget | undefined
  onFilter?(column: string, op: FilterOp, value?: string): void
  copyTarget?: { kind: DbKind; table?: TableRef }
  /** Double-clicking a row, e.g. to open the record explorer. */
  onRowDoubleClick?(index: number): void
  /** While set, shows a progress bar and this message instead of "No rows". */
  loadingLabel?: string
}

interface MenuState {
  x: number
  y: number
  row: number
  column: number
}

export function DataGrid(props: Props) {
  const { columns, rows, columnInfo, selection, onSelectionChange } = props
  const link = useOpenLink()
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(600)
  const [widths, setWidths] = useState<number[]>([])
  const [menu, setMenu] = useState<MenuState | null>(null)

  // Size columns from their header and a sample of content whenever the column set changes.
  const columnKey = columns.join('\u0000')
  useEffect(() => {
    setWidths(columns.map((name, ci) => {
      let longest = name.length + 3
      for (let r = 0; r < Math.min(rows.length, 60); r++) {
        longest = Math.max(longest, displayValue(rows[r][ci]).length)
      }
      return Math.min(360, Math.max(70, longest * 7.4 + 20))
    }))
    // Content changes within the same columns shouldn't reset widths the user dragged.
  }, [columnKey])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setViewportHeight(el.clientHeight))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [rows])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)
  const totalWidth = ROW_NUMBER_WIDTH + widths.reduce((a, b) => a + b, 0)

  const selectedIndexes = useMemo(() => [...selection.rows].sort((a, b) => a - b), [selection.rows])

  const copy = (format: CopyFormat, indexes: number[]): void => {
    const text = formatRows(format, columns, indexes.map((i) => rows[i]), props.copyTarget)
    window.api.copy(text)
    toast(`Copied ${indexes.length} row${indexes.length === 1 ? '' : 's'} as ${format.toUpperCase()}`)
  }

  const selectRow = (index: number, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void => {
    if (event.shiftKey && selection.active !== null) {
      const [a, b] = [Math.min(selection.active, index), Math.max(selection.active, index)]
      onSelectionChange({ rows: new Set(Array.from({ length: b - a + 1 }, (_, i) => a + i)), active: selection.active })
    } else if (event.ctrlKey || event.metaKey) {
      const next = new Set(selection.rows)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      onSelectionChange({ rows: next, active: index })
    } else {
      onSelectionChange({ rows: new Set([index]), active: index })
    }
  }

  const scrollIntoView = (index: number): void => {
    const el = scrollRef.current
    if (!el) return
    const top = index * ROW_HEIGHT
    const headerHeight = ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight - headerHeight) {
      el.scrollTop = top + ROW_HEIGHT - el.clientHeight + headerHeight
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key.toLowerCase() === 'c' && selectedIndexes.length) {
      event.preventDefault()
      copy('tsv', selectedIndexes)
    } else if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      onSelectionChange({ rows: new Set(rows.map((_, i) => i)), active: selection.active ?? 0 })
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next = Math.min(rows.length - 1, Math.max(0, (selection.active ?? -1) + delta))
      if (next >= 0) {
        onSelectionChange({ rows: new Set([next]), active: next })
        scrollIntoView(next)
      }
    }
  }

  const startResize = (ci: number, event: ReactMouseEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = widths[ci]
    const move = (e: MouseEvent): void => {
      setWidths((prev) => prev.map((w, i) => (i === ci ? Math.max(50, startWidth + e.clientX - startX) : w)))
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const openMenu = (event: ReactMouseEvent, row: number, column: number): void => {
    event.preventDefault()
    if (!selection.rows.has(row)) onSelectionChange({ rows: new Set([row]), active: row })
    setMenu({ x: event.clientX, y: event.clientY, row, column })
  }

  const menuRows = menu && selection.rows.has(menu.row) ? selectedIndexes : menu ? [menu.row] : []
  const menuValue = menu ? rows[menu.row]?.[menu.column] : null
  const menuColumn = menu ? columns[menu.column] : ''

  return (
    <div className="grid-wrap">
      {props.loadingLabel && <LoadingBar label={props.loadingLabel} overlay={rows.length > 0} />}
      <div
        ref={scrollRef}
        className="grid-scroll"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <table className="grid" style={{ width: totalWidth }}>
          <colgroup>
            <col style={{ width: ROW_NUMBER_WIDTH }} />
            {widths.map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <thead>
            <tr>
              <th className="rownum">#</th>
              {columns.map((name, ci) => {
                const info = columnInfo?.get(name)
                const sorted = props.sort?.column === name ? props.sort.dir : null
                return (
                  <th
                    key={ci}
                    className={props.onSort ? 'sortable' : undefined}
                    title={info ? `${name}\n${info.dataType}${info.nullable ? ' null' : ' not null'}${info.references ? `\n→ ${info.references.schema}.${info.references.name}.${info.references.column}` : ''}` : name}
                    onClick={() => props.onSort?.(name)}
                  >
                    <span className="th-label">
                      {info?.isPrimaryKey && <span className="badge pk">PK</span>}
                      {info?.references && <span className="badge fk">FK</span>}
                      <span className="th-name">{name}</span>
                      {sorted && <span className="sort">{sorted === 'asc' ? '▲' : '▼'}</span>}
                    </span>
                    <span className="resize" onMouseDown={(e) => startResize(ci, e)} onClick={(e) => e.stopPropagation()} />
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {first > 0 && <tr style={{ height: first * ROW_HEIGHT }} />}
            {rows.slice(first, last).map((row, offset) => {
              const index = first + offset
              const selected = selection.rows.has(index)
              return (
                <tr
                  key={index}
                  className={`${selected ? 'selected' : ''} ${selection.active === index ? 'active' : ''}`}
                  onMouseDown={(e) => e.button === 0 && selectRow(index, e)}
                  onDoubleClick={() => props.onRowDoubleClick?.(index)}
                >
                  <td className="rownum">{(props.rowOffset ?? 0) + index + 1}</td>
                  {row.map((value, ci) => {
                    const info = columnInfo?.get(columns[ci])
                    return (
                      <td
                        key={ci}
                        className={cellClass(value)}
                        onContextMenu={(e) => openMenu(e, index, ci)}
                      >
                        {(() => {
                          const fk = info?.references && value !== null && props.referenceTarget ? props.referenceTarget(info, value) : null
                          const crossInfo = value !== null ? props.crossLinks?.get(columns[ci]) : undefined
                          const crossTarget = crossInfo ? props.crossLinkTarget?.(columns[ci], value) : undefined
                          const cross = crossInfo && crossTarget ? { ...crossInfo, target: crossTarget } : null
                          if (!fk && !cross) return displayValue(value)
                          return (
                            <span className="fk-cell">
                              <span className="fk-value">{displayValue(value)}</span>
                              <span className="fk-buttons">
                                {fk && (
                                  <button
                                    className="fk-jump"
                                    title={`Open ${info!.references!.name} where ${info!.references!.column} = ${displayValue(value)}\nShift+click or drag to open beside`}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    {...link(fk)}
                                  >
                                    ↗
                                  </button>
                                )}
                                {cross && (
                                  <button
                                    className={`fk-jump cross env-${cross.env}`}
                                    title={`${cross.title}\nShift+click or drag to open beside`}
                                    onMouseDown={(e) => e.stopPropagation()}
                                    {...link(cross.target)}
                                  >
                                    ⇗
                                  </button>
                                )}
                              </span>
                            </span>
                          )
                        })()}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {last < rows.length && <tr style={{ height: (rows.length - last) * ROW_HEIGHT }} />}
          </tbody>
        </table>
        {!rows.length && !props.loadingLabel && <div className="grid-empty">No rows</div>}
      </div>

      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button onClick={() => { window.api.copy(menuValue === null ? '' : String(menuValue)); toast('Copied value'); setMenu(null) }}>
            Copy value
          </button>
          <div className="menu-sep" />
          <div className="menu-label">Copy {menuRows.length} row{menuRows.length === 1 ? '' : 's'} as</div>
          {COPY_FORMATS.map(({ format, label }) => (
            <button key={format} onClick={() => { copy(format, menuRows); setMenu(null) }}>{label}</button>
          ))}
          {props.onFilter && (
            <>
              <div className="menu-sep" />
              {menuValue === null ? (
                <button onClick={() => { props.onFilter?.(menuColumn, 'is null'); setMenu(null) }}>
                  Filter: {menuColumn} is NULL
                </button>
              ) : (
                <>
                  <button onClick={() => { props.onFilter?.(menuColumn, '=', String(menuValue)); setMenu(null) }}>
                    Filter: {menuColumn} = {truncate(displayValue(menuValue))}
                  </button>
                  <button onClick={() => { props.onFilter?.(menuColumn, '!=', String(menuValue)); setMenu(null) }}>
                    Filter: {menuColumn} ≠ {truncate(displayValue(menuValue))}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function cellClass(value: CellValue): string {
  if (value === null) return 'null'
  if (typeof value === 'number') return 'num'
  if (typeof value === 'boolean') return 'bool'
  return ''
}

function truncate(text: string, max = 24): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Indeterminate progress bar; over existing rows it's a thin strip with a small label, otherwise centred. */
export function LoadingBar({ label, overlay }: { label: string; overlay: boolean }) {
  return (
    <div className={`loading ${overlay ? 'overlay' : ''}`} role="status">
      <div className="loading-track"><div className="loading-fill" /></div>
      <div className="loading-label">{label}</div>
    </div>
  )
}
