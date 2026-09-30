import type { ColumnFilter, DbKind, TableRef } from '@shared/types'
import { qualifiedName, quoteIdent, sqlLiteral } from '@shared/rows'

export { COPY_FORMATS, displayValue, formatRows, qualifiedName, quoteIdent, sqlLiteral, type CopyFormat } from '@shared/rows'

/** Builds the SELECT equivalent of the current table view, so it can be tweaked in the editor. */
export function selectSql(
  kind: DbKind,
  table: TableRef,
  filters: ColumnFilter[],
  orderBy?: string,
  orderDir?: 'asc' | 'desc',
  limit = 100
): string {
  const q = (c: string): string => quoteIdent(kind, c)
  const clauses = filters.map((f) => {
    const v = f.value ?? ''
    switch (f.op) {
      case 'is null': return `${q(f.column)} IS NULL`
      case 'not null': return `${q(f.column)} IS NOT NULL`
      case 'contains': return `${q(f.column)} LIKE ${sqlLiteral(`%${v}%`)}`
      case 'starts': return `${q(f.column)} LIKE ${sqlLiteral(`${v}%`)}`
      case '!=': return `${q(f.column)} <> ${sqlLiteral(v)}`
      default: return `${q(f.column)} ${f.op} ${sqlLiteral(v)}`
    }
  })
  const where = clauses.length ? `\nWHERE ${clauses.join('\n  AND ')}` : ''
  const order = orderBy ? `\nORDER BY ${q(orderBy)} ${orderDir === 'desc' ? 'DESC' : 'ASC'}` : ''
  return kind === 'mssql'
    ? `SELECT TOP ${limit} *\nFROM ${qualifiedName(kind, table)}${where}${order}`
    : `SELECT *\nFROM ${qualifiedName(kind, table)}${where}${order}\nLIMIT ${limit}`
}

export function formatCount(n: number): string {
  return n.toLocaleString()
}

export function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`
}

/** A server timestamp (ISO, or MySQL's 'YYYY-MM-DD hh:mm:ss' in server time), or null if unreadable. */
export function parseStamp(stamp: string | undefined): Date | null {
  if (!stamp) return null
  const date = new Date(stamp.includes('T') ? stamp : stamp.replace(' ', 'T'))
  return isNaN(date.getTime()) ? null : date
}

/** "just now", "5 min ago", "3 days ago", then a date for anything over a year old. */
export function formatAgo(stamp: string | undefined): string | null {
  const date = parseStamp(stamp)
  if (!date) return null
  const seconds = (Date.now() - date.getTime()) / 1000
  if (seconds < 60) return 'just now'
  const steps: [number, string][] = [[60, 'min'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2629800, 'month']]
  if (seconds >= 31557600) return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
  let unit = steps[0]
  for (const step of steps) if (seconds >= step[0]) unit = step
  const n = Math.floor(seconds / unit[0])
  const label = unit[1] === 'min' ? 'min' : `${unit[1]}${n === 1 ? '' : 's'}`
  return `${n} ${label} ago`
}
