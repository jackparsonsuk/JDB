import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { CellValue, ColumnInfo, DbKind, FilterOp, TableRef } from '@shared/types'
import { COPY_FORMATS, displayValue, formatRows, type CopyFormat } from '../lib/format'
import { useOpenLink } from '../lib/openLink'
import type { OpenTarget } from '../state'
import { toast } from './Toast'

const ROW_HEIGHT = 26
const OVERSCAN = 12
/** The row window moves in steps this big, so scrolling only re-renders every few rows. */
const ROW_BLOCK = 8
/** Columns this far either side of the viewport are rendered too, so horizontal scrolls don't flash. */
const COLUMN_OVERSCAN_PX = 600
const ROW_NUMBER_WIDTH = 52
/** Cells are at most 360px wide, so drawing more text than this only costs layout time. */
const MAX_CELL_CHARS = 300

interface GridWindow {
  firstRow: number
  lastRow: number
  firstColumn: number
  lastColumn: number
}

const sameWindow = (a: GridWindow, b: GridWindow): boolean =>
  a.firstRow === b.firstRow && a.lastRow === b.lastRow && a.firstColumn === b.firstColumn && a.lastColumn === b.lastColumn

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
  const [widths, setWidths] = useState<number[]>([])
  /** Rows and columns currently rendered; only changes when the viewport crosses a step. */
  const [view, setView] = useState<GridWindow>({ firstRow: 0, lastRow: 40, firstColumn: 0, lastColumn: 30 })
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

  /** Left edge of each column, after the row number gutter. */
  const offsets = useMemo(() => {
    const out: number[] = []
    let x = 0
    for (const w of widths) {
      out.push(x)
      x += w
    }
    return out
  }, [widths])

  const updateView = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const rowCount = rows.length
    const topBlock = Math.floor(el.scrollTop / ROW_HEIGHT / ROW_BLOCK) * ROW_BLOCK
    const bottomBlock = Math.ceil((el.scrollTop + el.clientHeight) / ROW_HEIGHT / ROW_BLOCK) * ROW_BLOCK
    const left = el.scrollLeft - ROW_NUMBER_WIDTH - COLUMN_OVERSCAN_PX
    const right = el.scrollLeft + el.clientWidth + COLUMN_OVERSCAN_PX
    let firstColumn = 0
    while (firstColumn < widths.length - 1 && offsets[firstColumn] + widths[firstColumn] < left) firstColumn++
    let lastColumn = firstColumn
    while (lastColumn < widths.length && offsets[lastColumn] < right) lastColumn++
    const next: GridWindow = {
      firstRow: Math.max(0, topBlock - OVERSCAN),
      lastRow: Math.min(rowCount, bottomBlock + OVERSCAN),
      firstColumn,
      lastColumn: widths.length === columns.length ? lastColumn : columns.length
    }
    setView((prev) => (sameWindow(prev, next) ? prev : next))
  }, [rows.length, widths, offsets, columns.length])

  useLayoutEffect(() => {
    updateView()
  }, [updateView])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const observer = new ResizeObserver(() => updateView())
    observer.observe(el)
    return () => observer.disconnect()
  }, [updateView])

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

  const first = Math.min(view.firstRow, rows.length)
  const last = Math.min(view.lastRow, rows.length)
  const contentWidth = widths.reduce((a, b) => a + b, 0)
  const totalWidth = ROW_NUMBER_WIDTH + contentWidth
  // Before widths are measured every column renders; afterwards only those near the viewport.
  const measured = widths.length === columns.length && columns.length > 0
  const firstColumn = measured ? Math.min(view.firstColumn, columns.length) : 0
  const lastColumn = measured ? Math.min(view.lastColumn, columns.length) : columns.length
  const leftPad = measured && firstColumn < widths.length ? offsets[firstColumn] : 0
  const rightPad = measured && lastColumn < widths.length ? contentWidth - offsets[lastColumn] : 0
  const visibleColumns = columns.slice(firstColumn, lastColumn)

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

  const handlers = useRef<RowHandlers>(null!)
  handlers.current = {
    selectRow,
    openMenu,
    onRowDoubleClick: props.onRowDoubleClick,
    referenceTarget: props.referenceTarget,
    crossLinkTarget: props.crossLinkTarget,
    link
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
        onScroll={updateView}
      >
        <table className="grid" style={{ width: totalWidth }}>
          <colgroup>
            <col style={{ width: ROW_NUMBER_WIDTH }} />
            {leftPad > 0 && <col style={{ width: leftPad }} />}
            {visibleColumns.map((_, i) => <col key={firstColumn + i} style={{ width: widths[firstColumn + i] }} />)}
            {rightPad > 0 && <col style={{ width: rightPad }} />}
          </colgroup>
          <thead>
            <tr>
              <th className="rownum">#</th>
              {leftPad > 0 && <th className="spacer" />}
              {visibleColumns.map((name, i) => {
                const ci = firstColumn + i
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
              {rightPad > 0 && <th className="spacer" />}
            </tr>
          </thead>
          <tbody>
            {first > 0 && <tr style={{ height: first * ROW_HEIGHT }} />}
            {rows.slice(first, last).map((row, offset) => {
              const index = first + offset
              return (
                <GridRow
                  key={index}
                  row={row}
                  index={index}
                  rowNumber={(props.rowOffset ?? 0) + index + 1}
                  selected={selection.rows.has(index)}
                  active={selection.active === index}
                  columns={columns}
                  firstColumn={firstColumn}
                  lastColumn={lastColumn}
                  leftPad={leftPad > 0}
                  rightPad={rightPad > 0}
                  columnInfo={columnInfo}
                  crossLinks={props.crossLinks}
                  handlers={handlers}
                />
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

/** Callbacks rows need; kept in a ref so they don't defeat GridRow's memo by changing each render. */
interface RowHandlers {
  selectRow(index: number, event: ReactMouseEvent): void
  openMenu(event: ReactMouseEvent, row: number, column: number): void
  onRowDoubleClick?(index: number): void
  referenceTarget?(column: ColumnInfo, value: CellValue): OpenTarget
  crossLinkTarget?(column: string, value: CellValue): OpenTarget | undefined
  link: ReturnType<typeof useOpenLink>
}

interface RowProps {
  row: CellValue[]
  index: number
  rowNumber: number
  selected: boolean
  active: boolean
  columns: string[]
  firstColumn: number
  lastColumn: number
  leftPad: boolean
  rightPad: boolean
  columnInfo?: Map<string, ColumnInfo>
  crossLinks?: Map<string, { title: string; env: string }>
  handlers: { current: RowHandlers }
}

/** One grid row. Memoised, so moving the scroll window only renders the rows that come into view. */
const GridRow = memo(function GridRow(props: RowProps) {
  const { row, index, columns, columnInfo, handlers } = props
  const h = handlers.current
  const cells = []
  for (let ci = props.firstColumn; ci < props.lastColumn; ci++) {
    const value = row[ci]
    const info = columnInfo?.get(columns[ci])
    cells.push(
      <td key={ci} className={cellClass(value)} onContextMenu={(e) => h.openMenu(e, index, ci)}>
        <CellContent value={value} column={columns[ci]} info={info} crossInfo={value !== null ? props.crossLinks?.get(columns[ci]) : undefined} handlers={h} />
      </td>
    )
  }
  return (
    <tr
      className={`${props.selected ? 'selected' : ''} ${props.active ? 'active' : ''}`}
      onMouseDown={(e) => e.button === 0 && h.selectRow(index, e)}
      onDoubleClick={() => h.onRowDoubleClick?.(index)}
    >
      <td className="rownum">{props.rowNumber}</td>
      {props.leftPad && <td className="spacer" />}
      {cells}
      {props.rightPad && <td className="spacer" />}
    </tr>
  )
})

function CellContent({ value, column, info, crossInfo, handlers }: {
  value: CellValue
  column: string
  info?: ColumnInfo
  crossInfo?: { title: string; env: string }
  handlers: RowHandlers
}) {
  const text = clip(displayValue(value))
  const fk = info?.references && value !== null && handlers.referenceTarget ? handlers.referenceTarget(info, value) : null
  const crossTarget = crossInfo ? handlers.crossLinkTarget?.(column, value) : undefined
  const cross = crossInfo && crossTarget ? { ...crossInfo, target: crossTarget } : null
  if (!fk && !cross) return <>{text}</>
  return (
    <span className="fk-cell">
      <span className="fk-value">{text}</span>
      <span className="fk-buttons">
        {fk && (
          <button
            className="fk-jump"
            title={`Open ${info!.references!.name} where ${info!.references!.column} = ${text}\nShift+click or drag to open beside`}
            onMouseDown={(e) => e.stopPropagation()}
            {...handlers.link(fk)}
          >
            ↗
          </button>
        )}
        {cross && (
          <button
            className={`fk-jump cross env-${cross.env}`}
            title={`${cross.title}\nShift+click or drag to open beside`}
            onMouseDown={(e) => e.stopPropagation()}
            {...handlers.link(cross.target)}
          >
            ⇗
          </button>
        )}
      </span>
    </span>
  )
}

function clip(text: string): string {
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text
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
