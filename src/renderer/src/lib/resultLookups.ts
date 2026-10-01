import { useCallback, useMemo } from 'react'
import type { TableInfo, TableRef } from '@shared/types'
import type { Model } from '@shared/nl/model'
import { maskLiterals, resultColumnSources, statementRanges, type ColumnSource } from '@shared/sqlComplete'
import { useColumnLookup, type ColumnLookup } from './lookups'

const NO_TABLE: TableRef = { schema: '', name: '' }

/**
 * The SELECT behind each result set of a run, when the script's SELECTs and its result sets pair up
 * one to one; otherwise null for each (a procedure call, a batch that also prints counts…).
 */
export function sqlPerResult(sql: string, count: number): (string | null)[] {
  const selects = statementRanges(sql)
    .map((r) => sql.slice(r.from, r.to))
    .filter((s) => /^\s*(\(|SELECT\b|WITH\b)/i.test(maskLiterals(s)))
  return selects.length === count ? selects : Array<null>(count).fill(null)
}

export interface ResultLookups {
  /** Where each result column came from, by position. */
  sources: (ColumnSource | undefined)[]
  /** The active column's source, and its lookup: undefined while working it out, null for none. */
  source: ColumnSource | undefined
  lookup: ColumnLookup | null | undefined
  /** The source table's row estimate, so big lookup tables are searched rather than listed. */
  targetRows: number | undefined
}

/** Lookups for a query's result columns, found through the table columns the SELECT reads. */
export function useResultLookups(connectionId: string, model: Model | null, sql: string | null | undefined, columns: string[], activeColumn: string | null, tableList: TableInfo[] | undefined): ResultLookups {
  const sources = useMemo(() => (model && sql ? resultColumnSources(sql, columns, model) : []), [model, sql, columns])
  const index = activeColumn === null ? -1 : columns.indexOf(activeColumn)
  const source = index >= 0 ? sources[index] : undefined
  const table = useMemo(() => (source ? { schema: source.table.info.schema, name: source.table.info.name } : NO_TABLE), [source?.table])
  const hasTable = useCallback(
    (t: TableRef) => !!tableList?.some((x) => x.schema.toLowerCase() === t.schema.toLowerCase() && x.name.toLowerCase() === t.name.toLowerCase()),
    [tableList]
  )
  const lookup = useColumnLookup(connectionId, table, source?.column, hasTable)
  const target = lookup?.link.target
  const targetRows = target && tableList?.find((t) => t.schema.toLowerCase() === target.schema.toLowerCase() && t.name.toLowerCase() === target.name.toLowerCase())?.rowEstimate
  return { sources, source, lookup, targetRows }
}
