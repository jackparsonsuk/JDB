import type { ColumnFilter } from '@shared/types'

/**
 * Builds a WHERE clause from column filters. Values are always passed as parameters;
 * `quote` escapes identifiers and `param` produces the driver's placeholder for index i.
 */
export function buildWhere(
  filters: ColumnFilter[],
  quote: (identifier: string) => string,
  param: (index: number) => string
): { sql: string; values: string[] } {
  const clauses: string[] = []
  const values: string[] = []
  const next = (value: string): string => {
    values.push(value)
    return param(values.length - 1)
  }

  for (const filter of filters) {
    const column = quote(filter.column)
    const value = filter.value ?? ''
    switch (filter.op) {
      case 'is null':
        clauses.push(`${column} IS NULL`)
        break
      case 'not null':
        clauses.push(`${column} IS NOT NULL`)
        break
      case 'contains':
        clauses.push(`${column} LIKE ${next(`%${value}%`)}`)
        break
      case 'starts':
        clauses.push(`${column} LIKE ${next(`${value}%`)}`)
        break
      case '=':
      case '!=':
      case '>':
      case '<':
        clauses.push(`${column} ${filter.op === '!=' ? '<>' : filter.op} ${next(value)}`)
        break
    }
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', values }
}
