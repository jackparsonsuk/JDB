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
