import { useEffect, useState, useSyncExternalStore } from 'react'
import type { CellValue, ColumnInfo, ConnectionConfig, TableDetails, TableRef } from '@shared/types'
import { findLookup, lookupFromReference, lookupItems, lookupKindsSql, lookupListSql, LOOKUP_LIMIT, LOOKUP_LIST_MAX_ROWS, type LookupItem, type LookupLink } from '@shared/lookups'

/** Lookups set up by hand, loaded once and shared by every table tab. */
let links: LookupLink[] = []
let loaded: Promise<void> | null = null
const listeners = new Set<() => void>()

function publish(next: LookupLink[]): void {
  links = next
  listeners.forEach((l) => l())
}

function load(): Promise<void> {
  loaded ??= window.api.listLookups().then(publish, () => undefined)
  return loaded
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  load()
  return () => listeners.delete(listener)
}

export function useLookupLinks(): LookupLink[] {
  return useSyncExternalStore(subscribe, () => links)
}

export async function saveLookup(link: LookupLink): Promise<void> {
  publish(await window.api.saveLookup(link))
}

export async function deleteLookup(id: string): Promise<void> {
  publish(await window.api.deleteLookup(id))
}

/** Target table columns, read once per connection and table. */
const details = new Map<string, Promise<TableDetails>>()
export function describeCached(connectionId: string, table: TableRef): Promise<TableDetails> {
  const key = `${connectionId}|${table.schema}.${table.name}`.toLowerCase()
  let found = details.get(key)
  if (!found) {
    found = window.api.describeTable(connectionId, table)
    found.catch(() => details.delete(key))
    details.set(key, found)
  }
  return found
}

export interface ColumnLookup {
  link: LookupLink
  /** Set up by hand (and so editable and removable), rather than a declared foreign key. */
  manual: boolean
  /** The target's columns by lowercased name, for literals of the right type. */
  types: Map<string, string>
  targetColumns: ColumnInfo[]
}

/** The lookup for a column: one set up by hand, else its declared foreign key. undefined while working it out. */
export function useColumnLookup(connectionId: string, table: TableRef, column: ColumnInfo | undefined, hasTable: (t: TableRef) => boolean): ColumnLookup | null | undefined {
  const all = useLookupLinks()
  const manual = column ? findLookup(all, connectionId, table, column.name, hasTable) : undefined
  const [result, setResult] = useState<ColumnLookup | null | undefined>(undefined)
  const target = manual?.target ?? (column?.references && { schema: column.references.schema, name: column.references.name })
  const manualKey = manual ? JSON.stringify(manual) : ''

  useEffect(() => {
    if (!column || !target) {
      setResult(null)
      return
    }
    let live = true
    setResult(undefined)
    describeCached(connectionId, target).then(
      (d) => {
        if (!live) return
        const link = manual ?? lookupFromReference(connectionId, table, column, d.columns)
        setResult(link ? { link, manual: !!manual, types: new Map(d.columns.map((c) => [c.name.toLowerCase(), c.dataType])), targetColumns: d.columns } : null)
      },
      () => live && setResult(null)
    )
    return () => { live = false }
    // manualKey stands in for `manual`, which is a new object each render.
  }, [connectionId, table.schema, table.name, column?.name, column?.references?.name, target?.schema, target?.name, manualKey])
  return result
}

export type LookupList =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  /** The lookup table is too big to list; search for a value instead. */
  | { status: 'too-big'; rows: number }
  | {
      status: 'ready'
      items: LookupItem[]
      /** More rows than LOOKUP_LIMIT matched, so only the first ones are listed. */
      truncated: boolean
      /** Narrowed to the kinds the column uses; false when showing every kind (or there are none). */
      narrowed: boolean
      /** The server already applied the search; otherwise the caller filters `items` itself. */
      searched: boolean
    }

const read = (conn: ConnectionConfig, sql: string): Promise<CellValue[][]> => window.api.snapshotRows(conn.id, sql).then((r) => r.rows)

/**
 * The lookup's rows, narrowed to the column's kinds unless `all`. A search goes to the server only
 * when the list didn't fit. `targetRows` is the lookup table's row estimate: big ones aren't listed.
 */
export function useLookupList(conn: ConnectionConfig, lookup: ColumnLookup | null | undefined, all: boolean, search: string, targetRows?: number): LookupList {
  const big = targetRows !== undefined && targetRows > LOOKUP_LIST_MAX_ROWS
  const linkKey = lookup ? JSON.stringify(lookup.link) : ''
  const [kinds, setKinds] = useState<{ key: string; values: CellValue[] | null } | null>(null)

  // The kinds the column uses: one bounded query per lookup.
  useEffect(() => {
    setKinds(null)
    if (!lookup) return
    const { link } = lookup
    if (!link.narrowBy) {
      setKinds({ key: linkKey, values: null })
      return
    }
    let live = true
    read(conn, lookupKindsSql(conn.kind, { ...link, narrowBy: link.narrowBy })).then(
      (rows) => live && setKinds({ key: linkKey, values: rows.map((r) => r[0]) }),
      () => live && setKinds({ key: linkKey, values: null })
    )
    return () => { live = false }
  }, [conn.id, linkKey])

  const kindsReady = !!lookup && !!kinds && kinds.key === linkKey
  const narrowed = kindsReady && !all && !!kinds.values && kinds.values.length > 0
  const load = (text: string): Promise<{ items: LookupItem[]; truncated: boolean }> =>
    read(conn, lookupListSql(conn.kind, lookup!.link, lookup!.types, { kinds: narrowed ? kinds!.values : null, search: text, unordered: big }))
      .then((rows) => ({ items: lookupItems(rows.slice(0, LOOKUP_LIMIT)), truncated: rows.length > LOOKUP_LIMIT }))

  const [base, setBase] = useState<LookupList>({ status: 'loading' })
  useEffect(() => {
    setBase({ status: 'loading' })
    if (!kindsReady) return
    if (big) {
      setBase({ status: 'too-big', rows: targetRows! })
      return
    }
    let live = true
    load('').then(
      (r) => live && setBase({ status: 'ready', ...r, narrowed, searched: false }),
      (e) => live && setBase({ status: 'error', error: (e as Error).message })
    )
    return () => { live = false }
  }, [conn.id, linkKey, kindsReady, narrowed, big])

  const [typed, setTyped] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setTyped(search.trim()), 250)
    return () => clearTimeout(id)
  }, [search])

  const needServer = typed !== '' && (base.status === 'too-big' || (base.status === 'ready' && base.truncated))
  const [found, setFound] = useState<{ text: string; list: LookupList } | null>(null)
  useEffect(() => {
    if (!needServer) return
    let live = true
    setFound({ text: typed, list: { status: 'loading' } })
    load(typed).then(
      (r) => live && setFound({ text: typed, list: { status: 'ready', ...r, narrowed, searched: true } }),
      (e) => live && setFound({ text: typed, list: { status: 'error', error: (e as Error).message } })
    )
    return () => { live = false }
  }, [needServer, typed, base])

  if (!needServer) return base
  return found?.text === typed ? found.list : { status: 'loading' }
}

/** The label for one key, for the current cell when the list doesn't hold it. */
export function useLookupLabel(conn: ConnectionConfig, lookup: ColumnLookup | null | undefined, value: CellValue | undefined): LookupItem | null {
  const [item, setItem] = useState<LookupItem | null>(null)
  const linkKey = lookup ? JSON.stringify(lookup.link) : ''
  useEffect(() => {
    setItem(null)
    if (!lookup || value === undefined || value === null) return
    let live = true
    read(conn, lookupListSql(conn.kind, lookup.link, lookup.types, { keys: [value] })).then(
      (rows) => live && setItem(lookupItems(rows)[0] ?? null),
      () => undefined
    )
    return () => { live = false }
  }, [conn.id, linkKey, value])
  return item
}
