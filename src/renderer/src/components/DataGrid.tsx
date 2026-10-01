import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { CellValue, ColumnInfo, ColumnSummary, DbKind, FilterOp, TableRef } from '@shared/types'
import { canHoldGuid, dateKind, momentText, newGuid } from '@shared/edits'
import { cellStats, formatStat } from '@shared/stats'
import { COPY_FORMATS, displayValue, formatRows, type CopyFormat } from '../lib/format'
import { useOpenLink } from '../lib/openLink'
import type { OpenTarget } from '../state'
import { toast } from './Toast'
import { useAppearance, useRowHeight } from '../lib/appearance'
import { formatCell, type CellFormat } from '@shared/cellFormat'

/** Row height for the chosen density (Settings); set by DataGrid on each render, read live by its handlers. */
let ROW_HEIGHT = 26
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

/** How a row differs from the database while edits are unsaved; `cells` are the changed columns. */
export interface RowMark {
  state: 'updated' | 'deleted' | 'inserted'
  cells?: Set<number>
}

/** Cell editing. Values are staged by the owner and saved separately. */
export interface GridEditing {
  canEdit(row: number, column: number): boolean
  /** What the cell editor starts with. */
  inputText(row: number, column: number): string
  /** Stages typed text; returns an error to show instead, e.g. text in a number column. */
  commit(row: number, column: number, text: string): string | null
  setNull(row: number, column: number): string | null
  deleteRows(rows: number[]): void
  /** Drops staged edits to these rows, and removes them if they are new. */
  revertRows(rows: number[]): void
}

interface Props {
  columns: string[]
  rows: CellValue[][]
  /** Scrolls back to the top when this changes; defaults to `rows`. */
  scrollResetKey?: unknown
  marks?: Map<number, RowMark>
  editing?: GridEditing
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
  /** Scrolls to and highlights this column; `seq` lets the same column be asked for again. */
  focusColumn?: { name: string; seq: number }
  /** Shown at the top of the cell menu while editing is off: why, or how to turn it on. */
  editHint?: string
  /** Summarises a column over every row the view matches (not just this page), on the server; null if too slow. */
  summarizeAll?(column: string): Promise<ColumnSummary | null>
  /** While set, shows a progress bar and this message instead of "No rows". */
  loadingLabel?: string
  /** Told the column of the clicked cell (null when none), e.g. to show its lookup values. */
  onActiveColumnChange?(column: string | null): void
  /** Extra items for a column header's right-click menu, such as setting up a lookup. */
  columnMenu?(column: string): { label: string; run(): void }[]
}

interface MenuState {
  x: number
  y: number
  row: number
  column: number
}

export function DataGrid(props: Props) {
  // A new density re-creates the grid, so its scroll window is worked out afresh at the new height.
  const rowHeight = useRowHeight()
  ROW_HEIGHT = rowHeight
  return <Grid key={rowHeight} {...props} />
}

function Grid(props: Props) {
  const { columns, rows, columnInfo, selection, onSelectionChange } = props
  const link = useOpenLink()
  // How dates, NULLs and numbers show (Settings); the values themselves stay as read.
  const { dateFormat, hideFractions, localTime, nullText, thousands } = useAppearance()
  const cellFormat = useMemo<CellFormat>(() => ({ dateFormat, hideFractions, localTime, nullText, thousands }), [dateFormat, hideFractions, localTime, nullText, thousands])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState<number[]>([])
  /** Rows and columns currently rendered; only changes when the viewport crosses a step. */
  const [view, setView] = useState<GridWindow>({ firstRow: 0, lastRow: 40, firstColumn: 0, lastColumn: 30 })
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; column: string } | null>(null)

  // Size columns from their header and a sample of content whenever the column set changes.
  const columnKey = columns.join('\u0000')
  useEffect(() => {
    setWidths(columns.map((name, ci) => {
      let longest = name.length + 3
      for (let r = 0; r < Math.min(rows.length, 60); r++) {
        longest = Math.max(longest, formatCell(rows[r][ci], name, cellFormat).length)
      }
      return Math.min(360, Math.max(70, longest * 7.4 + 20))
    }))
    // Content changes within the same columns shouldn't reset widths the user dragged.
  }, [columnKey])

  /** The column of the last clicked cell: highlighted, and summarised for the selected rows. */
  const [activeColumn, setActiveColumn] = useState<number | null>(null)
  useEffect(() => setActiveColumn(null), [columnKey])
  const onActiveColumnChange = props.onActiveColumnChange
  useEffect(() => {
    onActiveColumnChange?.(activeColumn === null ? null : columns[activeColumn] ?? null)
  }, [activeColumn, columns, onActiveColumnChange])

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

  const scrollResetKey = props.scrollResetKey ?? rows
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [scrollResetKey])

  const [editCell, setEditCell] = useState<{ row: number; column: number } | null>(null)
  const editing = props.editing
  useEffect(() => {
    if (!editing) setEditCell(null)
  }, [editing])

  useEffect(() => {
    if (!headerMenu) return
    const close = (): void => setHeaderMenu(null)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [headerMenu])

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

  /**
   * A drag across rows after pressing on one, which selects the range like Excel. `base` is what
   * the range is added to (the existing selection for Ctrl+drag, else nothing).
   */
  const dragSelect = useRef<{ anchor: number; base: Set<number>; last: number } | null>(null)
  const [dragSelecting, setDragSelecting] = useState(false)

  const dragTo = (index: number): void => {
    const drag = dragSelect.current
    if (!drag || index === drag.last) return
    drag.last = index
    const [a, b] = [Math.min(drag.anchor, index), Math.max(drag.anchor, index)]
    const next = new Set(drag.base)
    for (let i = a; i <= b; i++) next.add(i)
    onSelectionChange({ rows: next, active: drag.anchor })
  }
  const dragToRef = useRef(dragTo)
  dragToRef.current = dragTo

  // While dragging, follow the pointer, and scroll when it's held near the top or bottom edge.
  useEffect(() => {
    if (!dragSelecting) return
    let pointerY: number | null = null
    const rowAt = (clientY: number): number | null => {
      const el = scrollRef.current
      if (!el || !rows.length) return null
      const rect = el.getBoundingClientRect()
      const y = clientY - rect.top + el.scrollTop - ROW_HEIGHT
      return Math.max(0, Math.min(rows.length - 1, Math.floor(y / ROW_HEIGHT)))
    }
    const onMove = (e: MouseEvent): void => {
      pointerY = e.clientY
      const index = rowAt(e.clientY)
      if (index !== null) dragToRef.current(index)
    }
    const timer = setInterval(() => {
      const el = scrollRef.current
      if (!el || pointerY === null) return
      const rect = el.getBoundingClientRect()
      const edge = ROW_HEIGHT * 1.5
      const step = pointerY < rect.top + ROW_HEIGHT + edge ? -ROW_HEIGHT : pointerY > rect.bottom - edge ? ROW_HEIGHT : 0
      if (!step) return
      el.scrollTop += step
      const index = rowAt(pointerY)
      if (index !== null) dragToRef.current(index)
    }, 40)
    const stop = (): void => {
      dragSelect.current = null
      setDragSelecting(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stop)
    window.addEventListener('blur', stop)
    return () => {
      clearInterval(timer)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', stop)
      window.removeEventListener('blur', stop)
    }
  }, [dragSelecting, rows.length])

  const selectRow = (index: number, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void => {
    const additive = event.ctrlKey || event.metaKey
    const anchor = event.shiftKey && selection.active !== null ? selection.active : index
    dragSelect.current = { anchor, base: additive ? new Set(selection.rows) : new Set(), last: index }
    setDragSelecting(true)
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

  const scrollColumnIntoView = (ci: number): void => {
    const el = scrollRef.current
    if (!el || offsets[ci] === undefined) return
    const left = ROW_NUMBER_WIDTH + offsets[ci]
    if (left - ROW_NUMBER_WIDTH < el.scrollLeft) el.scrollLeft = left - ROW_NUMBER_WIDTH
    else if (left + widths[ci] > el.scrollLeft + el.clientWidth) el.scrollLeft = left + widths[ci] - el.clientWidth
  }

  const focusColumn = props.focusColumn
  useEffect(() => {
    if (!focusColumn) return
    const index = columns.indexOf(focusColumn.name)
    if (index < 0) return
    setActiveColumn(index)
    scrollColumnIntoView(index)
    // Only when asked again, not whenever the scroll helpers change.
  }, [focusColumn])

  const startEdit = (row: number, column: number): void => {
    if (!editing?.canEdit(row, column)) return
    onSelectionChange({ rows: new Set([row]), active: row })
    scrollIntoView(row)
    scrollColumnIntoView(column)
    setEditCell({ row, column })
  }

  /** The next editable column in the row, for Tab and Shift+Tab. */
  const nextEditable = (row: number, column: number, step: 1 | -1): number | null => {
    for (let ci = column + step; ci >= 0 && ci < columns.length; ci += step) {
      if (editing?.canEdit(row, ci)) return ci
    }
    return null
  }

  /**
   * `text` null cancels. Returns false when the value was rejected, so the editor stays open.
   * The cell is passed in, as a blur can arrive after the editor has already moved on.
   */
  const finishEdit = (cell: { row: number; column: number }, text: string | null, move: 1 | -1 | 0): boolean => {
    if (text !== null) {
      const error = editing?.commit(cell.row, cell.column, text)
      if (error) {
        toast(error)
        return false
      }
    }
    const next = move ? nextEditable(cell.row, cell.column, move) : null
    if (next !== null) {
      scrollColumnIntoView(next)
      setEditCell({ row: cell.row, column: next })
    } else {
      setEditCell((current) => (current?.row === cell.row && current.column === cell.column ? null : current))
      scrollRef.current?.focus()
    }
    return true
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    const mod = event.ctrlKey || event.metaKey
    if (editing && selection.active !== null && (event.key === 'F2' || event.key === 'Enter')) {
      event.preventDefault()
      const first = nextEditable(selection.active, -1, 1)
      if (first !== null) startEdit(selection.active, first)
    } else if (editing && event.key === 'Delete' && selectedIndexes.length) {
      event.preventDefault()
      editing.deleteRows(selectedIndexes)
    } else if (mod && event.key.toLowerCase() === 'c' && selectedIndexes.length) {
      event.preventDefault()
      copy('tsv', selectedIndexes)
    } else if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      onSelectionChange({ rows: new Set(rows.map((_, i) => i)), active: selection.active ?? 0 })
    } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && selection.active !== null && activeColumn !== null) {
      // Moves the active cell along the row, keeping it in view.
      event.preventDefault()
      const next = Math.min(columns.length - 1, Math.max(0, activeColumn + (event.key === 'ArrowRight' ? 1 : -1)))
      setActiveColumn(next)
      scrollColumnIntoView(next)
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
    setActiveColumn(column)
    setMenu({ x: event.clientX, y: event.clientY, row, column })
  }

  const handlers = useRef<RowHandlers>(null!)
  handlers.current = {
    selectRow,
    openMenu,
    onRowDoubleClick: props.onRowDoubleClick,
    referenceTarget: props.referenceTarget,
    crossLinkTarget: props.crossLinkTarget,
    link,
    startEdit: editing ? startEdit : undefined,
    finishEdit,
    inputText: (row, column) => editing?.inputText(row, column) ?? '',
    setActiveColumn
  }

  const menuRows = menu && selection.rows.has(menu.row) ? selectedIndexes : menu ? [menu.row] : []
  const menuValue = menu ? rows[menu.row]?.[menu.column] : null
  const menuColumn = menu ? columns[menu.column] : ''
  const menuEditable = !!menu && !!editing?.canEdit(menu.row, menu.column)
  const kind = props.copyTarget?.kind ?? 'mssql'
  const menuColumnInfo = menu ? columnInfo?.get(columns[menu.column]) : undefined
  const menuType = menuColumnInfo?.dataType
  const menuDate = menuType ? dateKind(menuType) : null

  /** The clicked column summarised over the selected rows, or over every loaded row until several are selected. */
  const statsScope = selectedIndexes.length > 1 ? 'selected' : 'all'
  const stats = useMemo(() => {
    if (activeColumn === null || !rows.length) return null
    const indexes = statsScope === 'selected' ? selectedIndexes : rows.map((_, i) => i)
    return cellStats(indexes.map((i) => rows[i]?.[activeColumn] ?? null))
  }, [activeColumn, selectedIndexes, rows, statsScope])
  const statsRows = statsScope === 'selected' ? selectedIndexes.length : rows.length

  /** The same column summarised on the server over every matching row, once asked for. */
  const [whole, setWhole] = useState<{ column: number; result: ColumnSummary | 'loading' } | null>(null)
  useEffect(() => setWhole(null), [activeColumn, scrollResetKey])
  const summarizeWhole = async (column: number): Promise<void> => {
    if (!props.summarizeAll) return
    setWhole({ column, result: 'loading' })
    try {
      const result = await props.summarizeAll(columns[column])
      if (result) setWhole((w) => (w?.column === column ? { column, result } : w))
      else {
        setWhole(null)
        toast('That took too long, so the summary still covers just this page')
      }
    } catch (e) {
      setWhole(null)
      toast(`Couldn't summarise the table: ${(e as Error).message}`)
    }
  }
  const wholeResult = whole && whole.column === activeColumn && whole.result !== 'loading' ? whole.result : null
  const menuMarked = menuRows.some((i) => props.marks?.has(i))
  const menuPlural = `${menuRows.length} row${menuRows.length === 1 ? '' : 's'}`
  const menuAction = (run: () => string | null | void): void => {
    const error = run()
    if (error) toast(error)
    setMenu(null)
  }

  return (
    <div className={`grid-wrap ${dragSelecting ? 'drag-selecting' : ''}`}>
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
            {visibleColumns.map((_, i) => (
              <col key={firstColumn + i} className={firstColumn + i === activeColumn ? 'col-active' : undefined} style={{ width: widths[firstColumn + i] }} />
            ))}
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
                    className={[props.onSort && 'sortable', ci === activeColumn && 'col-active'].filter(Boolean).join(' ') || undefined}
                    title={info ? `${name}\n${info.dataType}${info.nullable ? ' null' : ' not null'}${info.references ? `\n→ ${info.references.schema}.${info.references.name}.${info.references.column}` : ''}` : name}
                    onClick={() => props.onSort?.(name)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setActiveColumn(ci)
                      setHeaderMenu({ x: e.clientX, y: e.clientY, column: name })
                    }}
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
                  activeColumn={selection.active === index ? activeColumn : null}
                  columns={columns}
                  firstColumn={firstColumn}
                  lastColumn={lastColumn}
                  leftPad={leftPad > 0}
                  rightPad={rightPad > 0}
                  columnInfo={columnInfo}
                  crossLinks={props.crossLinks}
                  mark={props.marks?.get(index)}
                  editingColumn={editCell?.row === index ? editCell.column : null}
                  handlers={handlers}
                  format={cellFormat}
                />
              )
            })}
            {last < rows.length && <tr style={{ height: (rows.length - last) * ROW_HEIGHT }} />}
          </tbody>
        </table>
        {!rows.length && !props.loadingLabel && <div className="grid-empty">No rows</div>}
      </div>

      {stats && activeColumn !== null && (() => {
        const shown = wholeResult ?? stats
        const scope = wholeResult ? 'whole' : statsScope
        const label = scope === 'whole' ? 'all matching rows' : scope === 'selected' ? `${statsRows.toLocaleString()} selected` : `all ${statsRows.toLocaleString()} rows`
        return (
          <div
            className={`grid-stats ${scope === 'whole' ? 'whole' : ''}`}
            title={`Summary of ${columns[activeColumn]} across ${scope === 'whole' ? 'every row matching the filters, worked out by the database' : scope === 'selected' ? `the ${statsRows} selected rows` : `the ${statsRows} rows on this page`}.\nClick a cell to pick the column; Shift/Ctrl+click or drag rows to narrow it down. NULLs are left out.`}
          >
            <span className="grid-stats-col">{columns[activeColumn]}</span>
            <span className="grid-stats-scope">{label}</span>
            {shown.numeric ? (
              <>
                <span>Sum <b>{formatStat(shown.numeric.sum)}</b></span>
                <span>Average <b>{formatStat(shown.numeric.average, 2)}</b></span>
                <span>Min <b>{formatStat(shown.numeric.min)}</b></span>
                <span>Max <b>{formatStat(shown.numeric.max)}</b></span>
              </>
            ) : shown.distinct !== undefined && (
              <span>Distinct <b>{shown.distinct.toLocaleString()}</b></span>
            )}
            <span>Count <b>{shown.count.toLocaleString()}</b></span>
            {props.summarizeAll && statsScope === 'all' && !wholeResult && (
              <button
                className="ghost small-button"
                disabled={whole?.result === 'loading'}
                title="Work this out over every row matching the filters, not just this page (stops after 10 seconds)"
                onClick={() => summarizeWhole(activeColumn)}
              >
                {whole?.result === 'loading' ? 'Summing…' : 'Whole table'}
              </button>
            )}
            <button className="icon small" title="Hide the summary" onClick={() => setActiveColumn(null)}>✕</button>
          </div>
        )
      })()}

      {headerMenu && (
        <div className="menu" style={{ left: headerMenu.x, top: headerMenu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <div className="menu-label">{headerMenu.column}</div>
          {props.onSort && (
            <button onClick={() => { props.onSort?.(headerMenu.column); setHeaderMenu(null) }}>
              {props.sort?.column !== headerMenu.column ? 'Sort ascending' : props.sort.dir === 'asc' ? 'Sort descending' : 'Stop sorting'}
            </button>
          )}
          {props.columnMenu?.(headerMenu.column).map((item) => (
            <button key={item.label} onClick={() => { setHeaderMenu(null); item.run() }}>{item.label}</button>
          ))}
          <div className="menu-sep" />
          <button onClick={() => { window.api.copy(headerMenu.column); toast('Copied column name'); setHeaderMenu(null) }}>Copy column name</button>
        </div>
      )}

      {menu && (
        <div className="menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          {!editing && props.editHint && (
            <>
              <div className="menu-label menu-hint">{props.editHint}</div>
              <div className="menu-sep" />
            </>
          )}
          {editing && (
            <>
              {menuEditable && (
                <>
                  <button onClick={() => menuAction(() => startEdit(menu.row, menu.column))}>Edit value</button>
                  {menuColumnInfo?.nullable !== false && (
                    <button onClick={() => menuAction(() => editing.setNull(menu.row, menu.column))}>Set NULL</button>
                  )}
                  {menuType && canHoldGuid(menuType) && (
                    <button onClick={() => menuAction(() => editing.commit(menu.row, menu.column, newGuid(kind)))}>New GUID</button>
                  )}
                  {menuDate && (
                    <>
                      <button
                        title="Your computer's local time"
                        onClick={() => menuAction(() => editing.commit(menu.row, menu.column, momentText(menuType!, new Date())))}
                      >
                        {menuDate === 'date' ? 'Today' : 'Now'}
                      </button>
                      {menuDate !== 'date' && (
                        <button onClick={() => menuAction(() => editing.commit(menu.row, menu.column, momentText(menuType!, new Date(), true)))}>Now (UTC)</button>
                      )}
                    </>
                  )}
                </>
              )}
              <button onClick={() => menuAction(() => editing.deleteRows(menuRows))}>Delete {menuPlural}</button>
              {menuMarked && <button onClick={() => menuAction(() => editing.revertRows(menuRows))}>Undo changes to {menuPlural}</button>}
              <div className="menu-sep" />
            </>
          )}
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
  setActiveColumn(column: number): void
  /** Set while the grid is editable; double-clicking a cell edits it. */
  startEdit?(row: number, column: number): void
  finishEdit(cell: { row: number; column: number }, text: string | null, move: 1 | -1 | 0): boolean
  inputText(row: number, column: number): string
}

interface RowProps {
  row: CellValue[]
  index: number
  rowNumber: number
  selected: boolean
  active: boolean
  /** The clicked cell's column, on the active row only, so other rows keep their memo. */
  activeColumn: number | null
  columns: string[]
  firstColumn: number
  lastColumn: number
  leftPad: boolean
  rightPad: boolean
  columnInfo?: Map<string, ColumnInfo>
  crossLinks?: Map<string, { title: string; env: string }>
  mark?: RowMark
  /** The column being edited in this row, if any. */
  editingColumn: number | null
  handlers: { current: RowHandlers }
  format: CellFormat
}

/** One grid row. Memoised, so moving the scroll window only renders the rows that come into view. */
const GridRow = memo(function GridRow(props: RowProps) {
  const { row, index, columns, columnInfo, handlers, mark } = props
  const h = handlers.current
  const cells = []
  for (let ci = props.firstColumn; ci < props.lastColumn; ci++) {
    const value = row[ci]
    const info = columnInfo?.get(columns[ci])
    const edited = (mark?.cells?.has(ci) ? ' edited' : '') + (props.activeColumn === ci ? ' cell-active' : '')
    const onMouseDown = (): void => handlers.current.setActiveColumn(ci)
    // Read at event time: memoised rows don't re-render when editing is switched on or off.
    const onDoubleClick = (e: ReactMouseEvent): void => {
      const start = handlers.current.startEdit
      if (!start) return
      e.stopPropagation()
      start(index, ci)
    }
    if (props.editingColumn === ci) {
      cells.push(
        <td key={ci} className="editing">
          <CellEditor cell={{ row: index, column: ci }} initial={h.inputText(index, ci)} onDone={(...args) => handlers.current.finishEdit(...args)} />
        </td>
      )
    } else if (mark?.state === 'inserted' && !edited) {
      // Unset columns in a new row are left out of the INSERT, so the database fills them in.
      cells.push(
        <td key={ci} className={`default${edited}`} onMouseDown={onMouseDown} onContextMenu={(e) => h.openMenu(e, index, ci)} onDoubleClick={onDoubleClick}>default</td>
      )
    } else {
      cells.push(
        <td key={ci} className={cellClass(value) + edited} onMouseDown={onMouseDown} onContextMenu={(e) => h.openMenu(e, index, ci)} onDoubleClick={onDoubleClick}>
          <CellContent value={value} column={columns[ci]} format={props.format} info={info} crossInfo={value !== null ? props.crossLinks?.get(columns[ci]) : undefined} handlers={h} />
        </td>
      )
    }
  }
  return (
    <tr
      className={`${props.selected ? 'selected' : ''} ${props.active ? 'active' : ''} ${mark ? `row-${mark.state}` : ''}`}
      onMouseDown={(e) => e.button === 0 && h.selectRow(index, e)}
      onDoubleClick={() => handlers.current.onRowDoubleClick?.(index)}
    >
      <td className="rownum">{props.rowNumber}</td>
      {props.leftPad && <td className="spacer" />}
      {cells}
      {props.rightPad && <td className="spacer" />}
    </tr>
  )
})

function CellContent({ value, column, format, info, crossInfo, handlers }: {
  value: CellValue
  column: string
  format: CellFormat
  info?: ColumnInfo
  crossInfo?: { title: string; env: string }
  handlers: RowHandlers
}) {
  const text = clip(formatCell(value, column, format))
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

/** Inline cell input: Enter saves, Tab saves and moves along the row, Esc cancels. */
function CellEditor({ cell, initial, onDone }: {
  cell: { row: number; column: number }
  initial: string
  onDone(cell: { row: number; column: number }, text: string | null, move: 1 | -1 | 0): boolean
}) {
  /** Set once a key has finished the edit, so the blur that follows doesn't save it again. */
  const done = useRef(false)
  const finish = (text: string | null, move: 1 | -1 | 0): void => {
    if (done.current) return
    // Set first: finishing focuses the grid, which blurs this input before onDone returns.
    done.current = true
    done.current = onDone(cell, text, move)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    // The grid's own keys (arrows, Ctrl+A, Delete) mustn't act while typing.
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      finish(e.currentTarget.value, 0)
    } else if (e.key === 'Tab') {
      e.preventDefault()
      finish(e.currentTarget.value, e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      finish(null, 0)
    }
  }
  return (
    <input
      className="cell-input"
      autoFocus
      defaultValue={initial}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      // Clicking away keeps a valid value and drops an invalid one.
      onBlur={(e) => {
        if (done.current) return
        done.current = true
        if (!onDone(cell, e.currentTarget.value, 0)) onDone(cell, null, 0)
      }}
    />
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
