import type { CellValue, ColumnInfo, CrossLink, KeyKind, LinkEnd, TableRef } from './types'
import type { Model, ModelColumn, ModelTable } from './nl/model'
import { splitIdentifier, stem } from './nl/words'

/**
 * Words that mark a column as pointing at another system rather than describing it,
 * e.g. BusinessCMSId, LegacyJobId, CreatedByShopUserId. Connection names are added per run.
 */
const SYSTEM_TAGS = ['cms', 'crn', 'ext', 'external', 'legacy', 'remote', 'source', 'origin']
/** Audit prefixes: CreatedByShopUserId still points at a user. */
const AUDIT_WORDS = ['created', 'updated', 'modified', 'deleted', 'closed', 'reopened', 'approved', 'last', 'by']

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function keyKind(dataType: string): KeyKind | null {
  const t = (dataType ?? '').toLowerCase()
  if (/uniqueidentifier|^char\((36|38)\)/.test(t)) return 'guid'
  if (/^(tiny|small|medium|big)?int|^numeric\(\d+,0\)|^decimal\(\d+,0\)/.test(t)) return 'number'
  if (/char|text/.test(t)) return 'text'
  return null
}

/** Numbers only pair with numbers; GUIDs and text can hold each other's values (varchar(36) GUIDs are common). */
export function kindsCompatible(from: KeyKind, to: KeyKind): boolean {
  return from === 'number' ? to === 'number' : to !== 'number'
}

/**
 * Keeps only values that can be compared against a key of `kind` without a conversion error,
 * normalised to strings. Values that can't match are dropped (and so count as unmatched).
 */
export function comparableValues(values: CellValue[], kind: KeyKind): string[] {
  const out = new Set<string>()
  for (const v of values) {
    if (v === null) continue
    const s = String(v).trim()
    if (kind === 'number' ? /^-?\d{1,18}$/.test(s) : kind === 'guid' ? GUID.test(s) : s.length > 0) out.add(s)
  }
  return [...out]
}

export interface CandidateSpec {
  from: LinkEnd
  to: LinkEnd
  fromKind: KeyKind
  toKind: KeyKind
}

function ref(t: ModelTable): TableRef {
  return { schema: t.info.schema, name: t.info.name }
}

/** The stemmed subject of a reference column: CreatedByShopUserId -> "user", BusinessCMSId -> "business". */
function subject(column: ModelColumn, tags: Set<string>): string | null {
  const words = splitIdentifier(column.info.name)
  if (words.length < 2 || words[words.length - 1] !== 'id') return null
  let core = words.slice(0, -1).filter((w) => !tags.has(w))
  while (core.length > 1 && AUDIT_WORDS.includes(core[0])) core = core.slice(1)
  return core.length ? core.map(stem).join(' ') : null
}

function singleKey(table: ModelTable): ColumnInfo | null {
  const pk = table.columns.filter((c) => c.info.isPrimaryKey)
  return pk.length === 1 ? pk[0].info : null
}

/**
 * Name-based candidates for columns in `a` that refer to tables in `b`.
 * Columns with a declared foreign key in their own database are skipped; inferred ones are not,
 * because naming inference can pick the wrong local table (Shop Orders.JobId -> a job scheduler's Job).
 */
export function candidatesBetween(
  a: { connectionId: string; name: string; model: Model },
  b: { connectionId: string; name: string; model: Model }
): CandidateSpec[] {
  // Relationships inside one database are foreign keys, not cross-database links.
  if (a.connectionId === b.connectionId) return []
  const tags = new Set([...SYSTEM_TAGS, ...splitIdentifier(a.name), ...splitIdentifier(b.name)])
  const targets = new Map<string, ModelTable>()
  for (const t of b.model.tables) {
    const key = t.words.join(' ')
    const existing = targets.get(key)
    // Prefer the default schema when several tables share a name.
    if (!existing || (existing.info.schema !== 'dbo' && t.info.schema === 'dbo')) targets.set(key, t)
  }

  const out: CandidateSpec[] = []
  for (const table of a.model.tables) {
    for (const column of table.columns) {
      if (column.info.isPrimaryKey || column.info.references) continue
      const fromKind = keyKind(column.info.dataType)
      const topic = fromKind && subject(column, tags)
      const target = topic ? targets.get(topic) : undefined
      const key = target && singleKey(target)
      const toKind = key && keyKind(key.dataType)
      if (!fromKind || !target || !key || !toKind || !kindsCompatible(fromKind, toKind)) continue
      out.push({
        from: { connectionId: a.connectionId, table: ref(table), column: column.info.name },
        to: { connectionId: b.connectionId, table: ref(target), column: key.name },
        fromKind,
        toKind
      })
    }
  }
  return out
}

export function sameEnd(x: LinkEnd, y: LinkEnd): boolean {
  return x.connectionId === y.connectionId && x.column === y.column && x.table.schema === y.table.schema && x.table.name === y.table.name
}

export function sameTable(end: LinkEnd, connectionId: string, table: TableRef): boolean {
  return end.connectionId === connectionId && end.table.schema === table.schema && end.table.name === table.name
}

/** Confirmed links whose reference column lives in this table (for "jump to the other database"). */
export function outgoingLinks(links: CrossLink[], connectionId: string, table: TableRef): CrossLink[] {
  return links.filter((l) => l.status === 'confirmed' && sameTable(l.from, connectionId, table))
}

/** Confirmed links pointing at a key in this table (for "rows elsewhere that reference this one"). */
export function incomingLinks(links: CrossLink[], connectionId: string, table: TableRef): CrossLink[] {
  return links.filter((l) => l.status === 'confirmed' && sameTable(l.to, connectionId, table))
}
