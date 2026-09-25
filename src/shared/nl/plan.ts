import { formatRangeLabel } from './dates'
import type { ModelColumn, ModelTable } from './model'
import type { Condition, Literal, Query, Target } from './translate'
import { splitIdentifier, stem } from './words'

export type PlanColumnKind = 'key' | 'filter' | 'sort' | 'group' | 'shown'

export interface PlanColumn {
  name: string
  kind: PlanColumnKind
  /** Human description of what the query does with the column, e.g. "= Draft", "newest first". */
  note?: string
}

export interface PlanTable {
  /** Unique per node: a lookup joined twice through different keys appears twice. */
  id: string
  name: string
  schema: string
  /** Why the table is there, e.g. "via InvoiceStatusId". */
  caption?: string
  /** Name of the other connection, when the table lives in another database. */
  remote?: string
  columns: PlanColumn[]
}

export interface PlanLink {
  kind: 'join' | 'exists' | 'not-exists'
  /** The table holding the foreign key. */
  from: string
  fromColumn: string
  /** The table being pointed at. */
  to: string
  toColumn: string
}

export interface PlanSuggestion {
  id: string
  name: string
  side: 'parent' | 'child'
  /** Text to append to the request to bring this table in, e.g. "with documents". */
  phrase: string
}

export interface Plan {
  main: PlanTable
  parents: PlanTable[]
  children: PlanTable[]
  links: PlanLink[]
  suggestions: PlanSuggestion[]
}

const MAX_SUGGESTIONS = 5

function literalText(l: Literal): string {
  return l.text
}

function conditionNote(c: Exclude<Condition, { kind: 'exists' }>): string {
  switch (c.kind) {
    case 'compare': return `${c.op === '<>' ? '≠' : c.op} ${literalText(c.value)}`
    case 'in': return `${c.negate ? 'not ' : ''}in ${c.values.map(literalText).join(', ')}`
    case 'like': return `${c.negate ? "doesn't contain" : 'contains'} ${c.pattern.replace(/^%|%$/g, '')}`
    case 'null': return c.isNull ? 'is empty' : 'is set'
    case 'range': return formatRangeLabel(c.range)
    case 'inKeys': return `in keys from step ${c.step}`
  }
}

/**
 * Words of an identifier as a user would type them, minus "id" and the main table's own words.
 * Falls back to the full name when the short form would only repeat the main table's words,
 * because the translator can't tell those apart ("query builder groups with queries").
 */
function phraseFor(name: string, exclude: string[]): string {
  const words = splitIdentifier(name).filter((w) => w !== 'id')
  const excluded = new Set(exclude.map(stem))
  const own = words.filter((w) => !excluded.has(stem(w)))
  return (own.length ? own : words).join(' ')
}

export function buildPlan(q: Query): Plan {
  const main = q.table
  const tables = new Map<string, PlanTable>()
  const links: PlanLink[] = []

  const node = (table: ModelTable, id: string, caption?: string): PlanTable => {
    let n = tables.get(id)
    if (!n) {
      n = { id, name: table.info.name, schema: table.info.schema, caption, remote: table.remote?.name, columns: [] }
      tables.set(id, n)
    }
    return n
  }
  const addColumn = (n: PlanTable, name: string, kind: PlanColumnKind, note?: string): void => {
    const existing = n.columns.find((c) => c.name === name)
    if (!existing) n.columns.push({ name, kind, note })
    else if (note) {
      // A column can be both a key and filtered; the more specific role wins and notes accumulate.
      if (existing.kind === 'key') existing.kind = kind
      existing.note = existing.note ? `${existing.note}; ${note}` : note
    }
  }

  const mainNode = node(main, main.key)
  const pk = main.columns.filter((c) => c.info.isPrimaryKey)

  /** Node for a parent reached through `fk`, with the join link. */
  const parentNode = (fk: ModelColumn): PlanTable => {
    const parent = fk.ref!.table
    const id = `${parent.key}#${fk.info.name}`
    const isNew = !tables.has(id)
    const n = node(parent, id, parent.remote ? `in ${parent.remote.name}, via ${fk.info.name}` : `via ${fk.info.name}`)
    if (isNew) {
      addColumn(n, fk.ref!.column, 'key')
      addColumn(mainNode, fk.info.name, 'key')
      links.push({ kind: 'join', from: mainNode.id, fromColumn: fk.info.name, to: id, toColumn: fk.ref!.column })
    }
    return n
  }

  const place = (target: Target, kind: PlanColumnKind, note?: string): void => {
    const n = target.via ? parentNode(target.via) : mainNode
    addColumn(n, target.column.info.name, kind, note)
  }

  for (const pkColumn of pk) addColumn(mainNode, pkColumn.info.name, 'key')

  q.conditions.forEach((c, i) => {
    if (c.kind === 'exists') {
      const child = c.link.table
      const id = `${child.key}#exists${i}`
      const rule = c.negate ? 'must have none' : 'must have at least one'
      const n = node(child, id, child.remote ? `in ${child.remote.name}, ${rule}` : rule)
      addColumn(n, c.link.column, 'key')
      addColumn(mainNode, c.link.parentColumn, 'key')
      links.push({ kind: c.negate ? 'not-exists' : 'exists', from: id, fromColumn: c.link.column, to: mainNode.id, toColumn: c.link.parentColumn })
      return
    }
    const note = c.target.column === main.softDelete && c.kind === 'null' && c.isNull ? 'hides deleted' : conditionNote(c)
    place(c.target, 'filter', note)
  })

  for (const target of q.shown) place(target, 'shown', 'shown')
  if (q.groupBy) place(q.groupBy, 'group', 'grouped, counted')
  if (q.order) place(q.order.target, 'sort', q.order.desc ? 'sorted ↓' : 'sorted ↑')

  const usedParents = new Set([...tables.keys()].filter((id) => id.includes('#') && !id.includes('#exists')).map((id) => id.split('#')[1]))
  const usedChildren = new Set(q.conditions.flatMap((c) => (c.kind === 'exists' ? [c.link.table.key] : [])))
  const mainWords = splitIdentifier(main.info.name)

  const suggestions: PlanSuggestion[] = []
  const auditish = /^(created|modified|updated|deleted|lastmodified)by/i
  for (const column of main.columns) {
    if (suggestions.length >= MAX_SUGGESTIONS) break
    if (!column.ref?.table.display || usedParents.has(column.info.name) || auditish.test(column.info.name) || column.ref.table === main) continue
    suggestions.push({
      id: `${column.ref.table.key}#${column.info.name}`,
      name: column.ref.table.info.name,
      side: 'parent',
      phrase: `with ${phraseFor(column.info.name, [])}`
    })
  }
  let childCount = 0
  for (const link of main.children) {
    if (childCount >= MAX_SUGGESTIONS) break
    if (usedChildren.has(link.table.key) || link.table === main) continue
    childCount++
    suggestions.push({
      id: `${link.table.key}#child#${link.column}`,
      name: link.table.info.name,
      side: 'child',
      phrase: `with ${phraseFor(link.table.info.name, mainWords)}`
    })
  }

  // Two FKs to the same table often yield the same phrase (OriginalInvoiceId / CreditInvoiceId); keep one.
  const seenPhrases = new Set<string>()
  const unique = suggestions.filter((sg) => !seenPhrases.has(sg.phrase) && seenPhrases.add(sg.phrase))

  const all = [...tables.values()]
  return {
    main: mainNode,
    parents: all.filter((t) => t.id !== mainNode.id && !t.id.includes('#exists')),
    children: all.filter((t) => t.id.includes('#exists')),
    links,
    suggestions: unique
  }
}
