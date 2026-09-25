import type { RelatedCount, RelatedCountRequest } from '@shared/types'
import * as db from './db'
import { indexKey, TimeoutError } from './db/driver'

/** Counts stop here; the explorer shows "1,000+" rather than scanning on. */
const COUNT_CAP = 1000
const COUNT_TIMEOUT_MS = 8_000
/** Unindexed columns on tables bigger than this aren't counted unless asked, to avoid full scans. */
const LARGE_TABLE_ROWS = 200_000
const CONCURRENCY = 4

/**
 * Counts rows referencing a record, one request per related table/column.
 * Guards against expensive scans on shared databases: indexed columns are counted straight away,
 * big unindexed tables are skipped until forced, and every count is capped and time-limited.
 */
export async function countRelated(connectionId: string, requests: RelatedCountRequest[]): Promise<RelatedCount[]> {
  const schema = await db.cachedSchema(connectionId)
  const tables = new Map(schema.map((t) => [`${t.schema}.${t.name}`.toLowerCase(), t]))
  const unique = [...new Map(requests.map((r) => [`${r.table.schema}.${r.table.name}`, r.table])).values()]
  const indexed = await db.indexedColumns(connectionId, unique).catch(() => new Set<string>())

  const results: RelatedCount[] = new Array(requests.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, requests.length) }, async () => {
    while (next < requests.length) {
      const i = next++
      results[i] = await countOne(connectionId, requests[i], tables, indexed)
    }
  }))
  return results
}

async function countOne(
  connectionId: string,
  request: RelatedCountRequest,
  tables: Map<string, { rowEstimate?: number; columns: { name: string; dataType: string }[] }>,
  indexed: Set<string>
): Promise<RelatedCount> {
  const info = tables.get(`${request.table.schema}.${request.table.name}`.toLowerCase())
  const column = info?.columns.find((c) => c.name.toLowerCase() === request.column.toLowerCase())
  const isIndexed = indexed.has(indexKey(request.table.schema, request.table.name, request.column))
  const rows = info?.rowEstimate ?? 0
  if (!request.force && !isIndexed && rows > LARGE_TABLE_ROWS) {
    return { status: 'skipped', reason: `${rows.toLocaleString()} rows and ${request.column} isn't indexed` }
  }
  try {
    const count = await db.countWhere(connectionId, request.table, request.column, column?.dataType ?? '', request.value, COUNT_CAP, COUNT_TIMEOUT_MS)
    return { status: 'ok', count: Math.min(count, COUNT_CAP), capped: count > COUNT_CAP }
  } catch (error) {
    if (error instanceof TimeoutError) return { status: 'timeout' }
    return { status: 'error', message: (error as Error).message }
  }
}
