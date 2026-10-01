import type { DbKind } from '../types'
import { comparableValues, keyKind } from '../links'
import type { Model, ModelColumn, ModelTable } from './model'
import { buildSql, quoteIdentifier, type Condition, type KeyPlaceholder, type Query, type Target } from './translate'

/**
 * Most keys a step may hand to the next. Past this the IN list gets unwieldy and the user
 * almost certainly wants a narrower question; the run stops with a clear message instead.
 */
export const KEY_LIMIT = 5000

export interface FederatedStep {
  /** 1-based, in run order. */
  index: number
  connectionId: string
  connectionName: string
  kind: DbKind
  /**
   * keys: collect the first column's values for a later step.
   * main: the query the user asked for, with key lists substituted in.
   * enrich: look up extra columns for the main results' foreign-key values.
   */
  role: 'keys' | 'main' | 'enrich'
  description: string
  sql: string
  placeholders: KeyPlaceholder[]
  enrich?: { sourceColumn: string; keyType: string; addedColumns: string[] }
}

export interface FederatedPlan {
  steps: FederatedStep[]
  keyLimit: number
}

const isRemote = (t?: Target): boolean => !!t?.via?.ref?.table.remote

/** True when any part of the query touches a table in another database. */
export function usesRemote(q: Query): boolean {
  return (
    q.conditions.some((c) => (c.kind === 'exists' ? !!c.link.table.remote : isRemote(c.target))) ||
    q.shown.some(isRemote) || isRemote(q.order?.target) || isRemote(q.groupBy)
  )
}

function softDeleteHidden(table: ModelTable): Condition[] {
  const sd = table.softDelete
  if (!sd) return []
  return [sd.kind === 'bool'
    ? { kind: 'compare', target: { column: sd }, op: '=', value: { text: '0', numeric: true } }
    : { kind: 'null', target: { column: sd }, isNull: true }]
}

/**
 * Splits a query that spans databases into steps each database can run:
 * filters on linked tables become key lookups run first, the main query runs with those keys,
 * and columns shown from linked tables are fetched afterwards for the rows returned.
 */
export function buildFederated(q: Query, model: Model, notes: string[]): { plan: FederatedPlan; script: string } {
  const local = model.connection ?? { id: '', name: 'this database' }
  const steps: FederatedStep[] = []
  const conditions: Condition[] = []
  const remoteFilters = new Map<ModelColumn, Condition[]>()

  const addStep = (step: Omit<FederatedStep, 'index' | 'placeholders'> & { placeholders?: KeyPlaceholder[] }): number => {
    steps.push({ ...step, placeholders: step.placeholders ?? [], index: steps.length + 1 })
    return steps.length
  }

  for (const c of q.conditions) {
    if (c.kind === 'exists') {
      const remote = c.link.table.remote
      if (!remote) {
        conditions.push(c)
        continue
      }
      // "jobs with orders" where orders live elsewhere: collect the keys orders point at, then filter by them.
      const child = c.link.table
      const { sql } = buildSql({ table: child, conditions: softDeleteHidden(child), shown: [], count: false, includeDeleted: true }, remote.kind, {
        select: { columns: [{ name: c.link.column }], distinct: true },
        limit: KEY_LIMIT + 1,
        where: [`{t}.${quoteIdentifier(remote.kind, c.link.column)} IS NOT NULL`]
      })
      const step = addStep({
        connectionId: remote.connectionId,
        connectionName: remote.name,
        kind: remote.kind,
        role: 'keys',
        description: `${q.table.info.name} keys referenced by ${child.info.name}.${c.link.column}`,
        sql
      })
      const parentColumn = q.table.columns.find((col) => col.info.name === c.link.parentColumn)!
      conditions.push({ kind: 'inKeys', target: { column: parentColumn }, step, negate: c.negate })
      continue
    }
    if (isRemote(c.target)) {
      const fk = c.target.via!
      remoteFilters.set(fk, [...(remoteFilters.get(fk) ?? []), c])
    } else {
      conditions.push(c)
    }
  }

  // Filters on a linked table: find its matching keys first, then keep main rows pointing at them.
  for (const [fk, filters] of remoteFilters) {
    const parent = fk.ref!.table
    const remote = parent.remote!
    const retargeted = filters.map((c) => ({ ...c, target: { column: (c as { target: Target }).target.column } }) as Condition)
    const { sql } = buildSql(
      { table: parent, conditions: [...retargeted, ...softDeleteHidden(parent)], shown: [], count: false, includeDeleted: true },
      remote.kind,
      { select: { columns: [{ name: fk.ref!.column }], distinct: true }, limit: KEY_LIMIT + 1 }
    )
    const step = addStep({
      connectionId: remote.connectionId,
      connectionName: remote.name,
      kind: remote.kind,
      role: 'keys',
      description: `${parent.info.name} rows matching the filter`,
      sql
    })
    conditions.push({ kind: 'inKeys', target: { column: fk }, step, negate: false })
  }

  let order = q.order
  let groupBy = q.groupBy
  if (isRemote(order?.target)) {
    notes.push(`Sorting by a column in ${order!.target.via!.ref!.table.remote!.name} isn't supported yet, so results aren't sorted by it.`)
    order = undefined
  }
  if (isRemote(groupBy)) {
    notes.push(`Grouping by a column in ${groupBy!.via!.ref!.table.remote!.name} isn't supported yet.`)
    groupBy = undefined
  }

  // Linked columns are merged into the main rows by key, which a picked column list could leave out.
  if (q.select?.length && !q.count) notes.push("Picking columns isn't supported with linked databases yet, so every column is shown.")
  const main = buildSql({ ...q, select: undefined, conditions, shown: q.shown.filter((t) => !isRemote(t)), order, groupBy }, model.kind)
  addStep({
    connectionId: local.id,
    connectionName: local.name,
    kind: model.kind,
    role: 'main',
    description: q.count ? `count ${q.table.info.name}` : q.aggregates?.length ? `${q.table.info.name} totals` : `${q.table.info.name} rows`,
    sql: main.sql,
    placeholders: main.placeholders
  })

  // Columns shown from linked tables are looked up for the rows the main step returns.
  if (!q.count && !q.aggregates?.length) {
    const shownByFk = new Map<ModelColumn, ModelColumn[]>()
    for (const t of q.shown.filter(isRemote)) shownByFk.set(t.via!, [...(shownByFk.get(t.via!) ?? []), t.column])
    for (const [fk, columns] of shownByFk) {
      const parent = fk.ref!.table
      const remote = parent.remote!
      const keyColumn = parent.columns.find((c) => c.info.name === fk.ref!.column)
      const labels = columns.map((c) => `${parent.info.name}.${c.info.name}`)
      const { sql } = buildSql({ table: parent, conditions: [], shown: [], count: false, includeDeleted: true }, remote.kind, {
        select: { columns: [{ name: fk.ref!.column, alias: '__key' }, ...columns.map((c, i) => ({ name: c.info.name, alias: labels[i] }))] },
        limit: null,
        where: [`{t}.${quoteIdentifier(remote.kind, fk.ref!.column)} IN ({{values}})`]
      })
      addStep({
        connectionId: remote.connectionId,
        connectionName: remote.name,
        kind: remote.kind,
        role: 'enrich',
        description: `add ${labels.join(', ')} for each ${fk.info.name}`,
        sql,
        enrich: { sourceColumn: fk.info.name, keyType: keyColumn?.info.dataType ?? '', addedColumns: labels }
      })
    }
  }

  return { plan: { steps, keyLimit: KEY_LIMIT }, script: renderScript(steps) }
}

/** Readable version of the plan for the SQL panel, with key lists shown as comments. */
function renderScript(steps: FederatedStep[]): string {
  return steps.map((step) => {
    let sql = step.sql
    for (const p of step.placeholders) {
      sql = sql.replace(p.token, `${p.column} ${p.negate ? 'NOT IN' : 'IN'} (/* keys from step ${p.step} */)`)
    }
    const source = steps.find((s) => s.role === 'main')
    sql = sql.replace('{{values}}', `/* ${step.enrich?.sourceColumn} values from step ${source?.index} */`)
    return `-- Step ${step.index} · ${step.connectionName}: ${step.description}\n${sql}`
  }).join('\n\n')
}

/** Comma-separated literals for an IN list, written safely for the column's type and dialect. */
export function valueList(values: string[], columnType: string, kind: DbKind): string {
  const k = keyKind(columnType) ?? 'text'
  const usable = comparableValues(values, k)
  if (k === 'number') return usable.join(', ')
  const unicode = kind === 'mssql' && /^n(var)?char|^ntext/i.test(columnType)
  return usable.map((v) => `${unicode ? 'N' : ''}'${v.replace(/'/g, "''")}'`).join(', ')
}

/** The predicate a key placeholder becomes; an empty list must still produce valid SQL. */
export function keyPredicate(p: KeyPlaceholder, values: string[], kind: DbKind): string {
  const list = valueList(values, p.columnType, kind)
  if (!list) return p.negate ? '1 = 1' : '1 = 0'
  return `${p.column} ${p.negate ? 'NOT IN' : 'IN'} (${list})`
}
