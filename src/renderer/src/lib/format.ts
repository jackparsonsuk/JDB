import type { CellValue, ColumnFilter, DbKind, TableRef } from '@shared/types'

export type CopyFormat = 'tsv' | 'csv' | 'json' | 'markdown' | 'insert'

export const COPY_FORMATS: { format: CopyFormat; label: string }[] = [
  { format: 'tsv', label: 'TSV (paste into Excel)' },
  { format: 'csv', label: 'CSV' },
  { format: 'json', label: 'JSON' },
  { format: 'markdown', label: 'Markdown table' },
  { format: 'insert', label: 'INSERT statements' }
]

export function quoteIdent(kind: DbKind, identifier: string): string {
  return kind === 'mssql' ? `[${identifier.replace(/]/g, ']]')}]` : `\`${identifier.replace(/`/g, '``')}\``
}

export function qualifiedName(kind: DbKind, table: TableRef): string {
  return `${quoteIdent(kind, table.schema)}.${quoteIdent(kind, table.name)}`
}

export function sqlLiteral(value: CellValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (/^0x[0-9A-F]+$/.test(value)) return value
  return `'${value.replace(/'/g, "''")}'`
}

export function displayValue(value: CellValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

function csvField(value: CellValue): string {
  if (value === null) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function formatRows(
  format: CopyFormat,
  columns: string[],
  rows: CellValue[][],
  target?: { kind: DbKind; table?: TableRef }
): string {
  switch (format) {
    case 'tsv':
      return [columns, ...rows.map((r) => r.map((v) => (v === null ? '' : String(v).replace(/[\t\n\r]/g, ' '))))]
        .map((r) => r.join('\t'))
        .join('\n')
    case 'csv':
      return [columns.map(csvField), ...rows.map((r) => r.map(csvField))].map((r) => r.join(',')).join('\n')
    case 'json':
      return JSON.stringify(rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2)
    case 'markdown': {
      const escape = (v: CellValue): string => displayValue(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')
      return [
        `| ${columns.join(' | ')} |`,
        `| ${columns.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${r.map(escape).join(' | ')} |`)
      ].join('\n')
    }
    case 'insert': {
      const kind = target?.kind ?? 'mssql'
      const name = target?.table ? qualifiedName(kind, target.table) : 'table_name'
      const cols = columns.map((c) => quoteIdent(kind, c)).join(', ')
      return rows.map((r) => `INSERT INTO ${name} (${cols}) VALUES (${r.map(sqlLiteral).join(', ')});`).join('\n')
    }
  }
}

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
