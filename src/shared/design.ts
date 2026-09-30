import type { DbKind, DesignColumn, TableDesign, TableRef } from './types'
import { qualifiedName, quoteIdent } from './rows'
import { APP_NAME } from './brand'

/** A column as edited in the designer. Defaults are SQL expressions; '' means none. */
export interface ColumnDraft {
  /** The existing column's name; undefined for a new column. */
  original?: string
  name: string
  dataType: string
  nullable: boolean
  default: string
  drop?: boolean
}

export function draftsFrom(design: TableDesign): ColumnDraft[] {
  return design.columns.map((c) => ({ original: c.name, name: c.name, dataType: c.dataType, nullable: c.nullable, default: c.default ?? '' }))
}

const sameType = (a: string, b: string): boolean => a.replace(/\s+/g, '').toLowerCase() === b.replace(/\s+/g, '').toLowerCase()
const isText = (dataType: string): boolean => /char|text|enum|set\b/i.test(dataType)

interface ColumnChange {
  draft: ColumnDraft
  column: DesignColumn
  renamed: boolean
  retyped: boolean
  nullability: boolean
  defaulted: boolean
}

function changesOf(design: TableDesign, drafts: ColumnDraft[]): { drops: DesignColumn[]; changes: ColumnChange[]; adds: ColumnDraft[] } {
  const byName = new Map(design.columns.map((c) => [c.name, c]))
  const drops: DesignColumn[] = []
  const changes: ColumnChange[] = []
  const adds: ColumnDraft[] = []
  for (const draft of drafts) {
    const column = draft.original !== undefined ? byName.get(draft.original) : undefined
    if (!column) {
      if (!draft.drop) adds.push(draft)
      continue
    }
    if (draft.drop) {
      drops.push(column)
      continue
    }
    const change: ColumnChange = {
      draft,
      column,
      renamed: draft.name !== column.name,
      retyped: !sameType(draft.dataType, column.dataType),
      nullability: draft.nullable !== column.nullable,
      defaulted: draft.default.trim() !== (column.default ?? '').trim()
    }
    if (change.renamed || change.retyped || change.nullability || change.defaulted) changes.push(change)
  }
  return { drops, changes, adds }
}

/** How many columns the drafts add, change or drop. */
export function countChanges(design: TableDesign, drafts: ColumnDraft[]): number {
  const { drops, changes, adds } = changesOf(design, drafts)
  return drops.length + changes.length + adds.length
}

/** Problems that stop the drafts being saved: missing or repeated names, missing types, altered computed columns. */
export function designProblems(design: TableDesign, drafts: ColumnDraft[]): string[] {
  const problems: string[] = []
  const kept = drafts.filter((d) => !d.drop)
  const names = new Map<string, number>()
  for (const d of kept) names.set(d.name.trim().toLowerCase(), (names.get(d.name.trim().toLowerCase()) ?? 0) + 1)
  if (kept.some((d) => !d.name.trim())) problems.push('Every column needs a name.')
  for (const [name, n] of names) if (name && n > 1) problems.push(`More than one column is called ${name}.`)
  for (const d of kept) if (!d.dataType.trim()) problems.push(`${d.name || 'A new column'} needs a data type.`)
  if (!kept.length) problems.push("A table can't drop all of its columns.")
  const byName = new Map(design.columns.map((c) => [c.name, c]))
  for (const { column, retyped, nullability, defaulted } of changesOf(design, drafts).changes) {
    if (column.computed && (retyped || nullability || defaulted)) problems.push(`${column.name} is computed, so only its name can change here.`)
    if (column.defaultHidden && (retyped || defaulted)) {
      problems.push(`${column.name} has a default this login can't read, so changing its type or default would lose it.`)
    }
  }
  for (const d of kept) {
    if (/[\]`]/.test(d.name)) problems.push(`${d.name} contains a bracket or backtick, which ${APP_NAME} won't write into a script.`)
    if (d.original === undefined && !d.nullable && !d.default.trim()) {
      problems.push(`New column ${d.name || '(unnamed)'} is NOT NULL with no default, which fails on a table that has rows.`)
    }
    const original = d.original !== undefined ? byName.get(d.original) : undefined
    if (original?.isPrimaryKey && d.nullable) problems.push(`${d.name} is part of the primary key, so it can't allow NULL.`)
  }
  return problems
}

/**
 * The script that turns the table into the drafts. SQL Server gets one statement per step, run
 * in a transaction (its DDL is transactional); MySQL gets a single ALTER TABLE, which is atomic
 * but commits at once.
 */
export function designSql(kind: DbKind, table: TableRef, design: TableDesign, drafts: ColumnDraft[]): string[] {
  const { drops, changes, adds } = changesOf(design, drafts)
  return kind === 'mssql' ? mssqlScript(table, drops, changes, adds) : mysqlScript(table, drops, changes, adds)
}

function mssqlScript(table: TableRef, drops: DesignColumn[], changes: ColumnChange[], adds: ColumnDraft[]): string[] {
  const q = (name: string): string => quoteIdent('mssql', name)
  const t = qualifiedName('mssql', table)
  const nstr = (text: string): string => `N'${text.replace(/'/g, "''")}'`
  const defaultName = (column: string): string => q(`DF_${table.name}_${column}`)
  const out: string[] = []
  // Defaults are constraints in SQL Server, and a column with one can't be dropped or retyped.
  for (const c of drops) {
    if (c.defaultConstraint) out.push(`ALTER TABLE ${t} DROP CONSTRAINT ${q(c.defaultConstraint)};`)
    out.push(`ALTER TABLE ${t} DROP COLUMN ${q(c.name)};`)
  }
  for (const ch of changes) {
    if (ch.column.defaultConstraint && (ch.defaulted || ch.retyped)) out.push(`ALTER TABLE ${t} DROP CONSTRAINT ${q(ch.column.defaultConstraint)};`)
    if (ch.retyped || ch.nullability) {
      const collate = ch.column.collation && isText(ch.draft.dataType) ? ` COLLATE ${ch.column.collation}` : ''
      out.push(`ALTER TABLE ${t} ALTER COLUMN ${q(ch.column.name)} ${ch.draft.dataType.trim()}${collate} ${ch.draft.nullable ? 'NULL' : 'NOT NULL'};`)
    }
    const expr = ch.draft.default.trim()
    if (expr && (ch.defaulted || (ch.retyped && ch.column.defaultConstraint))) {
      out.push(`ALTER TABLE ${t} ADD CONSTRAINT ${defaultName(ch.draft.name)} DEFAULT ${expr} FOR ${q(ch.column.name)};`)
    }
  }
  for (const d of adds) {
    const expr = d.default.trim()
    out.push(`ALTER TABLE ${t} ADD ${q(d.name.trim())} ${d.dataType.trim()} ${d.nullable ? 'NULL' : 'NOT NULL'}${expr ? ` CONSTRAINT ${defaultName(d.name.trim())} DEFAULT ${expr}` : ''};`)
  }
  // Renames go last so the steps above can use the old names.
  for (const ch of changes.filter((c) => c.renamed)) {
    out.push(`EXEC sp_rename ${nstr(`${q(table.schema)}.${q(table.name)}.${q(ch.column.name)}`)}, ${nstr(ch.draft.name.trim())}, N'COLUMN';`)
  }
  return out
}

function mysqlScript(table: TableRef, drops: DesignColumn[], changes: ColumnChange[], adds: ColumnDraft[]): string[] {
  const q = (name: string): string => quoteIdent('mysql', name)
  const str = (text: string): string => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
  const definition = (draft: ColumnDraft, column?: DesignColumn): string => {
    const parts = [draft.dataType.trim()]
    if (column?.collation && isText(draft.dataType)) parts.push(`COLLATE ${column.collation}`)
    parts.push(draft.nullable ? 'NULL' : 'NOT NULL')
    if (draft.default.trim()) parts.push(`DEFAULT ${draft.default.trim()}`)
    // CHANGE COLUMN replaces the whole definition, so keep what the designer doesn't show.
    if (column?.extra) parts.push(column.extra)
    if (column?.comment) parts.push(`COMMENT ${str(column.comment)}`)
    return parts.join(' ')
  }
  const clauses = [
    ...drops.map((c) => `DROP COLUMN ${q(c.name)}`),
    ...changes.map((ch) => `CHANGE COLUMN ${q(ch.column.name)} ${q(ch.draft.name.trim())} ${definition(ch.draft, ch.column)}`),
    ...adds.map((d) => `ADD COLUMN ${q(d.name.trim())} ${definition(d)}`)
  ]
  return clauses.length ? [`ALTER TABLE ${qualifiedName('mysql', table)}\n  ${clauses.join(',\n  ')};`] : []
}

/** Common types offered while typing, per dialect. Any other type can still be typed. */
export const TYPE_SUGGESTIONS: Record<DbKind, string[]> = {
  mssql: [
    'int', 'bigint', 'smallint', 'tinyint', 'bit', 'decimal(18,2)', 'numeric(18,2)', 'money', 'float', 'real',
    'date', 'datetime', 'datetime2', 'datetimeoffset', 'time', 'char(10)', 'varchar(50)', 'varchar(255)', 'varchar(max)',
    'nvarchar(50)', 'nvarchar(255)', 'nvarchar(max)', 'uniqueidentifier', 'varbinary(max)'
  ],
  mysql: [
    'int', 'bigint', 'smallint', 'tinyint', 'tinyint(1)', 'decimal(10,2)', 'double', 'float', 'date', 'datetime', 'datetime(6)',
    'timestamp', 'time', 'char(36)', 'varchar(50)', 'varchar(255)', 'text', 'mediumtext', 'longtext', 'json', 'blob'
  ]
}
