import type { KeyKind, LinkCandidate, LinkEnd, LinkOverlap, SchemaTable } from '@shared/types'
import { buildModel } from '@shared/nl/model'
import { candidatesBetween, comparableValues, keyKind, sameEnd, type CandidateSpec } from '@shared/links'
import * as db from './db'
import { getConnection, listLinks } from './store'

/** Distinct values sampled from the referencing column; enough to tell a real link from a coincidence. */
const SAMPLE_SIZE = 200
/** Share of sampled values that must exist on the other side for a candidate to be suggested. */
const MIN_OVERLAP = 0.5
const CONCURRENCY = 4

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }))
  return results
}

/** Samples the `from` column and counts how many of those values exist as keys on the `to` side. */
export async function measureOverlap(from: LinkEnd, to: LinkEnd, kind: KeyKind): Promise<LinkOverlap> {
  const sample = await db.sampleDistinct(from.connectionId, from.table, from.column, SAMPLE_SIZE)
  const values = comparableValues(sample, kind)
  const matched = values.length ? await db.countMatchingKeys(to.connectionId, to.table, to.column, values, kind) : 0
  // Values that can't be compared (e.g. text in an int link) still count as sampled, so they lower the score.
  return { matched, sampled: new Set(sample.map(String)).size, checkedAt: new Date().toISOString() }
}

/** Overlap for a hand-entered link, reading the key's type to compare values safely. */
export async function verifyLink(from: LinkEnd, to: LinkEnd): Promise<LinkOverlap> {
  const details = await db.describeTable(to.connectionId, to.table)
  const key = details.columns.find((c) => c.name.toLowerCase() === to.column.toLowerCase())
  if (!key) throw new Error(`${to.table.name} has no column ${to.column}`)
  const source = await db.describeTable(from.connectionId, from.table)
  if (!source.columns.some((c) => c.name.toLowerCase() === from.column.toLowerCase())) {
    throw new Error(`${from.table.name} has no column ${from.column}`)
  }
  return measureOverlap(from, { ...to, column: key.name }, keyKind(key.dataType) ?? 'text')
}

/** Finds links between two connections by naming, then keeps those whose data actually lines up. */
export async function discoverLinks(aId: string, bId: string): Promise<LinkCandidate[]> {
  if (aId === bId) throw new Error('Pick two different connections to link.')
  const [a, b] = [getConnection(aId).config, getConnection(bId).config]
  const [schemaA, schemaB] = await Promise.all([db.describeSchema(aId), db.describeSchema(bId)])
  const side = (id: string, name: string, schema: SchemaTable[], kind: 'mssql' | 'mysql') =>
    ({ connectionId: id, name, model: buildModel(schema, kind) })
  const sideA = side(aId, a.name, schemaA, a.kind)
  const sideB = side(bId, b.name, schemaB, b.kind)

  const known = listLinks()
  const isKnown = (spec: CandidateSpec): boolean => known.some((l) => sameEnd(l.from, spec.from) && sameEnd(l.to, spec.to))
  const specs = [...candidatesBetween(sideA, sideB), ...candidatesBetween(sideB, sideA)].filter((s) => !isKnown(s))

  const measured = await mapLimit(specs, CONCURRENCY, async (spec): Promise<LinkCandidate | null> => {
    try {
      return { from: spec.from, to: spec.to, overlap: await measureOverlap(spec.from, spec.to, spec.toKind) }
    } catch {
      // A table we can't read (permissions, odd types) just isn't suggested.
      return null
    }
  })

  return measured
    .filter((c): c is LinkCandidate => c !== null && c.from.connectionId !== c.to.connectionId && c.overlap.matched > 0 && c.overlap.matched / c.overlap.sampled >= MIN_OVERLAP)
    .sort((x, y) => y.overlap.matched / y.overlap.sampled - x.overlap.matched / x.overlap.sampled)
}
