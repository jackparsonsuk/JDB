import type { ColumnInfo, DbKind } from './types'
import type { Model } from './nl/model'
import { maskLiterals, mentionedTables, resolveMentions } from './sqlComplete'
import { columnLiteral, isNumericType } from './edits'

/**
 * Query parameters: `:name` anywhere, and `@name` in scripts that don't declare or assign
 * variables of their own (there `@name` is T-SQL's or MySQL's own variable). Running asks for a
 * value for each, and each is written in as a literal that suits the column it's compared with.
 */
export interface QueryParam {
  name: string
  /** Where it appears, as offsets into the SQL. */
  at: { from: number; to: number }[]
  /** The column it's compared with (`Col = :name`), when that can be worked out. */
  column?: ColumnInfo
  /** Used as `IN (:name)`, so a comma-separated value becomes a list. */
  list: boolean
}

/** How a value is written into the SQL. */
export type ParamMode = 'auto' | 'text' | 'number' | 'null' | 'sql'

export interface ParamValue {
  text: string
  mode: ParamMode
}

const COLON = /(^|[^\w:@$#.\\])(:([A-Za-z_]\w*))/g
const AT = /(^|[^\w@$#.])(@([A-Za-z_]\w*))/g

/** Scripts that declare or assign variables, where `@name` is the database's own variable. */
function ownsVariables(masked: string, kind: DbKind): boolean {
  if (kind === 'mssql') return /\bDECLARE\b|\bCREATE\s+(OR\s+ALTER\s+)?(PROC|PROCEDURE|FUNCTION|TRIGGER)\b|\bEXEC(UTE)?\b/i.test(masked)
  return /\bSET\s+@|:=|\bINTO\s+@|\bCREATE\s+(DEFINER\s*=\s*\S+\s+)?(PROCEDURE|FUNCTION|TRIGGER)\b/i.test(masked)
}

const IDENT = String.raw`(?:\[[^\]]+\]|\x60[^\x60]+\x60|"[^"]+"|[A-Za-z_][\w$#]*)`
const unquote = (s: string): string => (/^[[`"]/.test(s) ? s.slice(1, -1) : s)

/** The column a parameter is compared with: `[alias.]Col <op> :name` or `Col IN (:name)`. */
function comparedColumn(masked: string, from: number, model: Model | null, sql: string): { column?: ColumnInfo; list: boolean } {
  const before = masked.slice(Math.max(0, from - 200), from)
  const m = new RegExp(`(?:(${IDENT})\\s*\\.\\s*)?(${IDENT})\\s*(=|<>|!=|<=|>=|<|>|\\bLIKE|\\bIN\\s*\\((?:[^()]*,)?)\\s*$`, 'i').exec(before)
  if (!m) return { list: false }
  const list = /^IN/i.test(m[3])
  if (!model) return { list }
  const alias = m[1] && unquote(m[1]).toLowerCase()
  const name = unquote(m[2]).toLowerCase()
  const tables = resolveMentions(mentionedTables(sql), model)
  const candidates = alias ? tables.filter((t) => (t.alias ?? t.table.info.name).toLowerCase() === alias) : tables
  for (const t of candidates) {
    const column = t.table.columns.find((c) => c.info.name.toLowerCase() === name)
    if (column) return { column: column.info, list }
  }
  return { list }
}

export function findParams(sql: string, kind: DbKind, model: Model | null = null): QueryParam[] {
  const masked = maskLiterals(sql)
  const byName = new Map<string, QueryParam>()
  const add = (name: string, from: number, to: number): void => {
    const key = name.toLowerCase()
    let param = byName.get(key)
    if (!param) {
      param = { name, at: [], ...comparedColumn(masked, from, model, sql) }
      byName.set(key, param)
    }
    param.at.push({ from, to })
  }
  for (const m of masked.matchAll(COLON)) add(m[3], m.index! + m[1].length, m.index! + m[0].length)
  if (!ownsVariables(masked, kind)) {
    for (const m of masked.matchAll(AT)) add(m[3], m.index! + m[1].length, m.index! + m[0].length)
  }
  return [...byName.values()]
}

const looksNumeric = (text: string): boolean => /^-?\d+(\.\d+)?$/.test(text.trim())

/** One value as SQL, following its mode; `auto` goes by the column's type, or by what was typed. */
export function paramLiteral(kind: DbKind, param: QueryParam, value: ParamValue): string {
  const text = value.text
  switch (value.mode) {
    case 'null': return 'NULL'
    case 'sql': return text
    case 'number':
      if (!looksNumeric(text)) throw new Error(`:${param.name} should be a number, not "${text}"`)
      return text.trim()
    case 'text': return columnLiteral(kind, param.column?.dataType ?? (kind === 'mssql' && /[^\x00-\x7f]/.test(text) ? 'nvarchar' : 'varchar'), text)
  }
  const one = (part: string): string => {
    if (param.column) {
      if (isNumericType(param.column.dataType) && !looksNumeric(part)) throw new Error(`${param.column.name} is a number column, so :${param.name} can't be "${part}"`)
      return columnLiteral(kind, param.column.dataType, part)
    }
    return looksNumeric(part) ? part.trim() : columnLiteral(kind, kind === 'mssql' && /[^\x00-\x7f]/.test(part) ? 'nvarchar' : 'varchar', part)
  }
  if (param.list && text.includes(',')) return text.split(',').map((p) => p.trim()).filter(Boolean).map(one).join(', ')
  return one(text)
}

/** The SQL with every parameter replaced by its value. */
export function bindParams(sql: string, kind: DbKind, params: QueryParam[], values: Record<string, ParamValue>): string {
  const spots = params.flatMap((p) => p.at.map((at) => ({ ...at, literal: paramLiteral(kind, p, values[p.name.toLowerCase()] ?? { text: '', mode: 'auto' }) })))
  spots.sort((a, b) => b.from - a.from)
  let out = sql
  for (const s of spots) out = out.slice(0, s.from) + s.literal + out.slice(s.to)
  return out
}
