import { useCallback, useMemo, useState } from 'react'
import type { CellValue, ColumnInfo, DbKind, TableDetails, TableRef } from '@shared/types'
import { changeSql, isEditableColumn, parseInput, type TableChange } from '@shared/edits'
import type { GridEditing, RowMark } from '../components/DataGrid'

interface RowUpdate {
  /** The row as loaded, whose key the UPDATE matches. */
  original: CellValue[]
  set: Record<string, CellValue>
}

const sameValue = (a: CellValue, b: CellValue): boolean => a === b || (a !== null && b !== null && String(a) === String(b))

/**
 * Edits staged in the table grid until saved. Rows are tracked by primary key, so edits
 * survive paging, sorting and refreshing; new rows are listed after the loaded ones.
 */
export function useTableEdits(kind: DbKind, table: TableRef, columns: string[], details: TableDetails | null, loaded: CellValue[][]) {
  const [updates, setUpdates] = useState<Map<string, RowUpdate>>(() => new Map())
  const [deletes, setDeletes] = useState<Map<string, CellValue[]>>(() => new Map())
  const [inserts, setInserts] = useState<Record<string, CellValue>[]>([])

  const info = useMemo(() => new Map<string, ColumnInfo>(details?.columns.map((c) => [c.name, c]) ?? []), [details])
  const keyColumns = useMemo(() => details?.columns.filter((c) => c.isPrimaryKey).map((c) => c.name) ?? [], [details])
  const keyOf = useCallback(
    (row: CellValue[]): string => JSON.stringify(keyColumns.map((name) => row[columns.indexOf(name)])),
    [keyColumns, columns]
  )

  /** Loaded rows with their edits applied, then new rows; marks say how each differs. */
  const view = useMemo(() => {
    const rows: CellValue[][] = []
    const marks = new Map<number, RowMark>()
    loaded.forEach((row, i) => {
      const key = keyOf(row)
      if (deletes.has(key)) {
        marks.set(i, { state: 'deleted' })
        rows.push(row)
        return
      }
      const update = updates.get(key)
      if (!update) {
        rows.push(row)
        return
      }
      const next = row.slice()
      const cells = new Set<number>()
      for (const [name, value] of Object.entries(update.set)) {
        const ci = columns.indexOf(name)
        if (ci < 0) continue
        next[ci] = value
        cells.add(ci)
      }
      marks.set(i, { state: 'updated', cells })
      rows.push(next)
    })
    inserts.forEach((values, j) => {
      const cells = new Set<number>()
      rows.push(columns.map((name, ci) => {
        if (!(name in values)) return null
        cells.add(ci)
        return values[name]
      }))
      marks.set(loaded.length + j, { state: 'inserted', cells })
    })
    return { rows, marks }
  }, [loaded, updates, deletes, inserts, columns, keyOf])

  const count = inserts.length + deletes.size + [...updates.keys()].filter((key) => !deletes.has(key)).length

  const setValue = useCallback((index: number, name: string, value: CellValue) => {
    if (index >= loaded.length) {
      const j = index - loaded.length
      setInserts((prev) => prev.map((values, i) => (i === j ? { ...values, [name]: value } : values)))
      return
    }
    const row = loaded[index]
    const key = keyOf(row)
    setUpdates((prev) => {
      const next = new Map(prev)
      const set = { ...next.get(key)?.set }
      // Typing the original value back removes the edit rather than saving a no-op.
      if (sameValue(value, row[columns.indexOf(name)])) delete set[name]
      else set[name] = value
      if (Object.keys(set).length) next.set(key, { original: next.get(key)?.original ?? row, set })
      else next.delete(key)
      return next
    })
  }, [loaded, keyOf, columns])

  const grid = useMemo<GridEditing>(() => {
    const columnAt = (ci: number): ColumnInfo | undefined => info.get(columns[ci])
    const canEdit = (index: number, ci: number): boolean => {
      const column = columnAt(ci)
      if (!column || !isEditableColumn(kind, column)) return false
      if (index >= loaded.length) return index < loaded.length + inserts.length
      // Keys identify the row being saved, so they only change by deleting and re-adding it.
      return !column.isPrimaryKey && !deletes.has(keyOf(loaded[index]))
    }
    const newRows = (indexes: number[]): Set<number> =>
      new Set(indexes.filter((i) => i >= loaded.length).map((i) => i - loaded.length))
    const loadedKeys = (indexes: number[]): Map<string, CellValue[]> =>
      new Map(indexes.filter((i) => i < loaded.length).map((i) => [keyOf(loaded[i]), loaded[i]]))

    return {
      canEdit,
      inputText: (index, ci) => {
        const value = view.rows[index]?.[ci]
        return value === null || value === undefined ? '' : String(value)
      },
      commit: (index, ci, text) => {
        const column = columnAt(ci)
        if (!column || !canEdit(index, ci)) return `${columns[ci]} can't be edited here`
        const parsed = parseInput(column, text)
        if ('error' in parsed) return parsed.error
        setValue(index, column.name, parsed.value)
        return null
      },
      setNull: (index, ci) => {
        const column = columnAt(ci)
        if (!column || !canEdit(index, ci)) return `${columns[ci]} can't be edited here`
        if (!column.nullable) return `${column.name} doesn't allow NULL`
        setValue(index, column.name, null)
        return null
      },
      deleteRows: (indexes) => {
        const drop = newRows(indexes)
        if (drop.size) setInserts((prev) => prev.filter((_, i) => !drop.has(i)))
        const keys = loadedKeys(indexes)
        if (keys.size) setDeletes((prev) => new Map([...prev, ...keys]))
      },
      revertRows: (indexes) => {
        const drop = newRows(indexes)
        if (drop.size) setInserts((prev) => prev.filter((_, i) => !drop.has(i)))
        const keys = loadedKeys(indexes)
        if (!keys.size) return
        setDeletes((prev) => new Map([...prev].filter(([key]) => !keys.has(key))))
        setUpdates((prev) => new Map([...prev].filter(([key]) => !keys.has(key))))
      }
    }
  }, [kind, info, columns, loaded, inserts.length, deletes, keyOf, view.rows, setValue])

  /** Adds a blank row, returning its index in `rows`. Columns left unset get their defaults. */
  const addRow = useCallback((): number => {
    setInserts((prev) => [...prev, {}])
    return loaded.length + inserts.length
  }, [loaded.length, inserts.length])

  const discard = useCallback(() => {
    setUpdates(new Map())
    setDeletes(new Map())
    setInserts([])
  }, [])

  /** The statements that save every staged edit: deletes, then updates, then inserts. */
  const statements = useCallback((): string[] => {
    const keyFor = (row: CellValue[]): Record<string, CellValue> =>
      Object.fromEntries(keyColumns.map((name) => [name, row[columns.indexOf(name)]]))
    const changes: TableChange[] = [
      ...[...deletes.values()].map((row): TableChange => ({ kind: 'delete', key: keyFor(row) })),
      ...[...updates].filter(([key]) => !deletes.has(key)).map(([, u]): TableChange => ({ kind: 'update', key: keyFor(u.original), set: u.set })),
      ...inserts.map((values): TableChange => ({ kind: 'insert', values }))
    ]
    return changes.map((change) => changeSql(kind, table, details?.columns ?? [], change))
  }, [kind, table, details, keyColumns, columns, deletes, updates, inserts])

  return { rows: view.rows, marks: view.marks, count, grid, addRow, discard, statements }
}
