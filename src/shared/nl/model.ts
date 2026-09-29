import type { ColumnInfo, CrossLink, DbKind, SchemaTable, TableRef, ValueLookup } from '../types'
import { pickDisplayColumn } from '../display'
import { CATEGORY_HINTS, COLUMN_NOISE, sameWords, splitIdentifier, stem, stems } from './words'

export type ColumnKind = 'date' | 'text' | 'number' | 'bool' | 'other'

export interface ModelColumn {
  info: ColumnInfo
  kind: ColumnKind
  /** Stemmed words of the column name, e.g. InvoiceStatusId -> [invoice, status, id]. */
  words: string[]
  /** Same, without type-ish noise like "id", "date", "on": CreatedOn -> [created]. */
  core: string[]
  /** Values listed in a MySQL ENUM(...) type, available without querying. */
  enumValues?: string[]
  /** Parent this column points to: a declared foreign key, or one inferred from naming. */
  ref?: { table: ModelTable; column: string; inferred: boolean }
}

export interface ChildLink {
  table: ModelTable
  /** Column in the child table pointing at `parentColumn` in this table. */
  column: string
  parentColumn: string
}

export interface ModelTable {
  info: SchemaTable
  key: string
  words: string[]
  columns: ModelColumn[]
  children: ChildLink[]
  /** Most human-readable column: Name, Title, Label, … */
  display?: ModelColumn
  /** Column that marks soft-deleted rows, if the table uses that pattern. */
  softDelete?: ModelColumn
  /** Set on tables that live in another database, reached through a cross-database link. */
  remote?: RemoteSource
}

/** Where a table lives, for tables pulled in from other connections. */
export interface RemoteSource {
  connectionId: string
  name: string
  kind: DbKind
}

export interface Model {
  kind: DbKind
  tables: ModelTable[]
  /** The connection this model describes; needed to plan queries that span databases. */
  connection?: { id: string; name: string }
}

/** A set of values worth loading so words like "paid" or "closed" can be recognised. */
export interface ValueSource {
  key: string
  table: TableRef
  column: string
  via?: ValueLookup
}

export function columnKind(dataType: string): ColumnKind {
  const t = dataType.toLowerCase()
  if (/^(tinyint\(1\)|bit|bool|boolean)/.test(t)) return 'bool'
  if (/date|time/.test(t) && !/timestamp.*binary/.test(t)) return 'date'
  if (/int|decimal|numeric|float|double|real|money/.test(t)) return 'number'
  if (/char|text|enum|set\(|uniqueidentifier/.test(t)) return 'text'
  return 'other'
}

function parseEnum(dataType: string): string[] | undefined {
  const match = dataType.match(/^enum\((.*)\)$/i)
  if (!match) return undefined
  return [...match[1].matchAll(/'((?:''|[^'])*)'/g)].map((m) => m[1].replace(/''/g, "'"))
}

function textLength(dataType: string): number | null {
  const match = dataType.match(/\((\d+|max)\)/i)
  if (!match) return /text/i.test(dataType) ? Number.MAX_SAFE_INTEGER : null
  return match[1].toLowerCase() === 'max' ? Number.MAX_SAFE_INTEGER : Number(match[1])
}

function pickDisplay(table: ModelTable): ModelColumn | undefined {
  const chosen = pickDisplayColumn(table.columns.map((c) => c.info), table.info.name)
  return chosen && table.columns.find((c) => c.info.name === chosen.name)
}

function pickSoftDelete(table: ModelTable): ModelColumn | undefined {
  return table.columns.find((c) =>
    (c.kind === 'date' || c.kind === 'bool') && sameWords(c.core, ['deleted'])
  ) ?? table.columns.find((c) => c.kind === 'bool' && sameWords(c.words, ['is', 'deleted']))
}

/** Loose type families so an inferred FK doesn't pair an int with a GUID string. */
function typeFamily(dataType: string): string {
  const k = columnKind(dataType)
  return k === 'text' ? (/uniqueidentifier|char\(36\)|char\(38\)/i.test(dataType) ? 'guid' : 'text') : k
}

export function buildModel(schema: SchemaTable[], kind: DbKind): Model {
  const tables: ModelTable[] = schema.map((info) => ({
    info,
    key: `${info.schema}.${info.name}`,
    words: stems(splitIdentifier(info.name)),
    // Drivers can report a null type when the login can't see a user-defined type; don't let one column break the model.
    columns: info.columns.filter((c) => c.name != null).map((raw) => {
      const c = { ...raw, dataType: raw.dataType ?? '' }
      const words = stems(splitIdentifier(c.name))
      const core = words.filter((w) => !COLUMN_NOISE.has(w))
      return { info: c, kind: columnKind(c.dataType), words, core: core.length ? core : words, enumValues: parseEnum(c.dataType) }
    }),
    children: []
  }))

  const byKey = new Map(tables.map((t) => [t.key, t]))
  const byWords = new Map<string, ModelTable[]>()
  for (const t of tables) {
    const k = t.words.join(' ')
    byWords.set(k, [...(byWords.get(k) ?? []), t])
  }

  for (const table of tables) {
    for (const column of table.columns) {
      const ref = column.info.references
      if (ref) {
        const parent = byKey.get(`${ref.schema}.${ref.name}`)
        if (parent) column.ref = { table: parent, column: ref.column, inferred: false }
        continue
      }
      // Undeclared FK by convention: CustomerId -> Customer(s).Id with a single-column PK of the same type family.
      if (column.info.isPrimaryKey || column.words.length < 2 || column.words[column.words.length - 1] !== 'id') continue
      const prefix = column.words.slice(0, -1).join(' ')
      const candidates = (byWords.get(prefix) ?? []).filter((t) => t !== table)
      const parent = candidates.find((t) => t.info.schema === table.info.schema) ?? candidates[0]
      const pk = parent?.columns.filter((c) => c.info.isPrimaryKey)
      if (parent && pk?.length === 1 && typeFamily(pk[0].info.dataType) === typeFamily(column.info.dataType)) {
        column.ref = { table: parent, column: pk[0].info.name, inferred: true }
      }
    }
  }

  for (const table of tables) {
    for (const column of table.columns) {
      if (column.ref && column.ref.table !== table) {
        column.ref.table.children.push({ table, column: column.info.name, parentColumn: column.ref.column })
      }
    }
  }

  for (const table of tables) {
    table.display = pickDisplay(table)
    table.softDelete = pickSoftDelete(table)
  }

  return { kind, tables }
}

/**
 * A confirmed cross-database link says where a column really points, so drop any local
 * foreign key that was only inferred from its name (Shop Orders.JobId is not the job scheduler's Job).
 */
/**
 * Wires confirmed cross-database links into a model: a linked column's parent becomes the table in the
 * other database, and tables in other databases that point here become children. Tables of other
 * connections are never the main table, so they stay out of `model.tables`.
 */
export function attachRemote(
  model: Model,
  connectionId: string,
  links: CrossLink[],
  remotes: Map<string, { model: Model; name: string }>
): Model {
  const find = (m: Model, schema: string, name: string): ModelTable | undefined =>
    m.tables.find((t) => t.info.schema === schema && t.info.name === name)
  const tag = (t: ModelTable, remoteId: string): ModelTable => {
    const remote = remotes.get(remoteId)!
    t.remote = { connectionId: remoteId, name: remote.name, kind: remote.model.kind }
    return t
  }

  for (const link of links) {
    if (link.status !== 'confirmed') continue
    if (link.from.connectionId === connectionId && remotes.has(link.to.connectionId)) {
      const table = find(model, link.from.table.schema, link.from.table.name)
      const column = table?.columns.find((c) => c.info.name === link.from.column)
      const target = find(remotes.get(link.to.connectionId)!.model, link.to.table.schema, link.to.table.name)
      if (!table || !column || !target) continue
      if (column.ref) column.ref.table.children = column.ref.table.children.filter((c) => !(c.table === table && c.column === column.info.name))
      column.ref = { table: tag(target, link.to.connectionId), column: link.to.column, inferred: false }
    } else if (link.to.connectionId === connectionId && remotes.has(link.from.connectionId)) {
      const parent = find(model, link.to.table.schema, link.to.table.name)
      const child = find(remotes.get(link.from.connectionId)!.model, link.from.table.schema, link.from.table.name)
      if (!parent || !child) continue
      parent.children.push({ table: tag(child, link.from.connectionId), column: link.from.column, parentColumn: link.to.column })
    }
  }
  return model
}

export function applyCrossLinks(model: Model, connectionId: string, links: CrossLink[]): Model {
  for (const link of links) {
    if (link.status !== 'confirmed' || link.from.connectionId !== connectionId) continue
    const table = model.tables.find((t) => t.info.schema === link.from.table.schema && t.info.name === link.from.table.name)
    const column = table?.columns.find((c) => c.info.name === link.from.column)
    if (!table || !column?.ref?.inferred) continue
    const parent = column.ref.table
    parent.children = parent.children.filter((c) => !(c.table === table && c.column === column.info.name))
    column.ref = undefined
  }
  return model
}

const LOOKUP_ROW_LIMIT = 2000

/** Columns of a table whose values are worth fetching so bare words can match them. */
export function valueSources(table: ModelTable): ValueSource[] {
  const out: ValueSource[] = []
  const ref: TableRef = { schema: table.info.schema, name: table.info.name }
  for (const column of table.columns) {
    if (column.enumValues) continue
    // Values in another database would need that connection; not worth it for recognising words.
    if (column.ref?.table.remote) continue
    const hinted = column.core.some((w) => CATEGORY_HINTS.has(w))
    if (column.ref) {
      const parent = column.ref.table
      const small = (parent.info.rowEstimate ?? LOOKUP_ROW_LIMIT) < LOOKUP_ROW_LIMIT
      const lookupish = hinted || parent.words.some((w) => CATEGORY_HINTS.has(w))
      if (parent.display && small && lookupish) {
        out.push({
          key: `${table.key}.${column.info.name}>${parent.key}.${parent.display.info.name}`,
          table: ref,
          column: column.info.name,
          via: { table: { schema: parent.info.schema, name: parent.info.name }, column: column.ref.column, display: parent.display.info.name }
        })
      }
    } else if (column.kind === 'text' && hinted && (textLength(column.info.dataType) ?? 0) <= 200) {
      out.push({ key: `${table.key}.${column.info.name}`, table: ref, column: column.info.name })
    }
  }
  return out
}

export function stemPhrase(text: string): string[] {
  return text.split(/[^A-Za-z0-9]+/).filter(Boolean).map(stem)
}
