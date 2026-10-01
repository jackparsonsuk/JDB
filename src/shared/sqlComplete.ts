import type { DbKind } from './types'
import type { Model, ModelTable } from './nl/model'
import { quoteIdent } from './rows'
import { splitIdentifier } from './nl/words'

/** A table named after FROM / JOIN / UPDATE / INTO in the SQL being edited, and its alias if it has one. */
export interface TableMention {
  schema?: string
  name: string
  alias?: string
  /** Offsets of the table name in the text that was scanned. */
  from: number
  to: number
}

export interface ResolvedMention {
  table: ModelTable
  alias?: string
}

/** One completion option; the renderer maps these onto CodeMirror completions. */
export interface SqlOption {
  label: string
  /** Text inserted in place of the word being typed, when it differs from the label. */
  apply?: string
  detail: string
  /** A join that follows a key guessed from column names rather than a declared one; listed after declared keys. */
  inferred?: boolean
}

const IDENT = '(?:\\[[^\\]]+\\]|`[^`]+`|"[^"]+"|[A-Za-z_#@][\\w$#@]*)'
const NAME = `${IDENT}(?:\\s*\\.\\s*${IDENT}){0,2}`
const ALIAS = `(?:\\s+(?:AS\\s+)?(${IDENT}))?`

/** Words that can follow a table name but are never its alias. */
const NOT_ALIAS = new Set([
  'where', 'on', 'join', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural', 'straight_join', 'group', 'order',
  'having', 'limit', 'offset', 'fetch', 'union', 'except', 'intersect', 'with', 'set', 'values', 'as', 'select', 'from',
  'and', 'or', 'not', 'apply', 'using', 'for', 'option', 'pivot', 'unpivot', 'tablesample', 'window', 'when', 'then',
  'else', 'end', 'go', 'into', 'output', 'lock', 'partition', 'use', 'force', 'ignore'
])

/** Short words an alias must not be, because they are SQL keywords. */
const RESERVED_ALIAS = new Set(['as', 'at', 'by', 'do', 'go', 'if', 'in', 'is', 'of', 'on', 'or', 'to', 'add', 'all', 'and', 'any', 'asc', 'end', 'for', 'key', 'not', 'set', 'top', 'use'])

function unquote(identifier: string): string {
  const first = identifier[0]
  if (first === '[' || first === '`' || first === '"') return identifier.slice(1, -1)
  return identifier
}

function splitName(name: string): string[] {
  return name.match(new RegExp(IDENT, 'g'))?.map(unquote) ?? []
}

/** Blanks out comments and string literals, keeping offsets, so their contents are never read as SQL. */
export function maskLiterals(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'?/g, (m) => m.replace(/[^\n]/g, ' '))
}

/** The statement around `pos`: text between the nearest `;` or `GO` line on each side. */
export function statementAt(sql: string, pos: number): { text: string; offset: number } {
  const masked = maskLiterals(sql)
  const boundary = /;|^\s*GO\s*$/gim
  let start = 0
  let end = sql.length
  for (let m = boundary.exec(masked); m; m = boundary.exec(masked)) {
    if (m.index + m[0].length <= pos) start = m.index + m[0].length
    else if (m.index >= pos) {
      end = m.index
      break
    }
  }
  return { text: sql.slice(start, end), offset: start }
}

/**
 * Every statement in the script, split like `statementAt`, from its first character of SQL to its
 * last, leaving out surrounding comments and blank space. Segments with no SQL are skipped.
 */
export function statementRanges(sql: string): { from: number; to: number }[] {
  const masked = maskLiterals(sql)
  // Comments blanked but strings kept, so a statement ending in a literal keeps it.
  const code = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'?/g, (m) => (m[0] === "'" ? m : m.replace(/[^\n]/g, ' ')))
  const boundary = /;|^\s*GO\s*$/gim
  const out: { from: number; to: number }[] = []
  const add = (start: number, end: number): void => {
    const segment = code.slice(start, end)
    const lead = segment.length - segment.trimStart().length
    const body = segment.trim()
    if (body) out.push({ from: start + lead, to: start + lead + body.length })
  }
  let start = 0
  for (let m = boundary.exec(masked); m; m = boundary.exec(masked)) {
    add(start, m.index)
    start = m.index + m[0].length
  }
  add(start, sql.length)
  return out
}

/** Tables mentioned in a statement, in order, including comma-separated FROM lists. */
export function mentionedTables(sql: string): TableMention[] {
  const text = maskLiterals(sql)
  const out: TableMention[] = []
  const lead = new RegExp(`\\b(FROM|JOIN|UPDATE|INTO|APPLY)\\s+(${NAME})${ALIAS}`, 'gi')
  const more = new RegExp(`\\s*,\\s*(${NAME})${ALIAS}`, 'y')

  /** Records a mention and returns where scanning should resume: after the alias, or after the name when the "alias" was a keyword. */
  const add = (name: string, alias: string | undefined, at: number, matchEnd: number): number => {
    const parts = splitName(name)
    const isAlias = !!alias && !NOT_ALIAS.has(alias.toLowerCase())
    if (parts.length) {
      out.push({
        name: parts[parts.length - 1],
        schema: parts.length > 1 ? parts[parts.length - 2] : undefined,
        alias: isAlias ? unquote(alias!) : undefined,
        from: at,
        to: at + name.length
      })
    }
    return isAlias || !alias ? matchEnd : at + name.length
  }

  for (let m = lead.exec(text); m; m = lead.exec(text)) {
    const nameAt = m.index + m[0].indexOf(m[2], m[1].length)
    const end = m.index + m[0].length
    // A function call such as "APPLY fn(...)" names no table.
    if (!m[3] && text[end] === '(') continue
    lead.lastIndex = add(m[2], m[3], nameAt, end)
    if (m[1].toUpperCase() !== 'FROM') continue
    more.lastIndex = lead.lastIndex
    for (let n = more.exec(text); n; n = more.exec(text)) {
      lead.lastIndex = add(n[1], n[2], n.index + n[0].indexOf(n[1]), n.index + n[0].length)
      more.lastIndex = lead.lastIndex
    }
  }
  return out
}

/** Matches mentions to tables in the model, case-insensitively; unknown names (CTEs, typos) are dropped. */
export function resolveMentions(mentions: TableMention[], model: Model): ResolvedMention[] {
  const out: ResolvedMention[] = []
  const seen = new Set<string>()
  for (const m of mentions) {
    // The same table under the same alias (say, again in a subquery) adds nothing.
    const key = `${m.schema ?? ''}.${m.name}|${m.alias ?? ''}`.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const name = m.name.toLowerCase()
    const schema = m.schema?.toLowerCase()
    const matches = model.tables.filter((t) => t.info.name.toLowerCase() === name && (!schema || t.info.schema.toLowerCase() === schema))
    const table = matches.find((t) => t.info.schema === defaultSchema(model)) ?? matches[0]
    if (table) out.push({ table, alias: m.alias })
  }
  return out
}

/** The schema bare table names belong to: dbo on SQL Server, otherwise the one most tables are in. */
export function defaultSchema(model: Model): string | undefined {
  if (model.kind === 'mssql' && model.tables.some((t) => t.info.schema === 'dbo')) return 'dbo'
  const counts = new Map<string, number>()
  for (const t of model.tables) counts.set(t.info.schema, (counts.get(t.info.schema) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
}

function ident(kind: DbKind, name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : quoteIdent(kind, name)
}

function tableName(model: Model, table: ModelTable): string {
  const name = ident(model.kind, table.info.name)
  return table.info.schema === defaultSchema(model) ? name : `${ident(model.kind, table.info.schema)}.${name}`
}

/**
 * Columns of the tables the statement uses, so a bare column name completes before any "alias." is typed.
 * A column name that more than one of those tables has is inserted qualified, so it isn't ambiguous.
 */
export function columnOptions(resolved: ResolvedMention[], kind: DbKind): SqlOption[] {
  const seen = new Map<string, number>()
  for (const { table } of resolved) {
    for (const c of table.columns) seen.set(c.info.name.toLowerCase(), (seen.get(c.info.name.toLowerCase()) ?? 0) + 1)
  }
  const out: SqlOption[] = []
  for (const { table, alias } of resolved) {
    const qualifier = alias ?? ident(kind, table.info.name)
    for (const c of table.columns) {
      const col = ident(kind, c.info.name)
      const ambiguous = (seen.get(c.info.name.toLowerCase()) ?? 0) > 1
      // The label stays the bare name so it prefix-matches what's typed; the qualifier goes in on accept.
      out.push({
        label: c.info.name,
        apply: ambiguous ? `${qualifier}.${col}` : col === c.info.name ? undefined : col,
        detail: `${alias ?? table.info.name} · ${c.info.dataType}${c.info.isPrimaryKey ? ' · PK' : ''}`
      })
    }
  }
  return out
}

/** A short alias from a table name's word initials (OrderLines → ol), numbered if already taken. */
export function aliasFor(name: string, taken: Set<string>): string {
  const words = splitIdentifier(name)
  let base = words.map((w) => w[0]).join('') || 't'
  if (!/^[a-z]/.test(base)) base = `t${base}`
  if (RESERVED_ALIAS.has(base)) base = words[0]?.slice(0, 3) ?? `${base}1`
  let alias = base
  for (let i = 2; taken.has(alias.toLowerCase()) || RESERVED_ALIAS.has(alias); i++) alias = `${base}${i}`
  return alias
}

/**
 * Whole join clauses for the tables a statement already uses, following foreign keys both ways:
 * "Orders o ON o.CustomerId = c.Id". Declared keys come before ones inferred from column names.
 */
export function joinOptions(model: Model, resolved: ResolvedMention[]): SqlOption[] {
  const kind = model.kind
  const taken = new Set(resolved.map((r) => (r.alias ?? r.table.info.name).toLowerCase()))
  const used = new Set(resolved.map((r) => r.table))
  const declared: SqlOption[] = []
  const inferred: SqlOption[] = []
  const seen = new Set<string>()

  const push = (target: ModelTable, on: (alias: string) => string, anchor: string, isInferred: boolean): void => {
    if (used.has(target)) return
    const alias = aliasFor(target.info.name, taken)
    const label = `${tableName(model, target)} ${alias} ON ${on(alias)}`
    if (seen.has(label)) return
    seen.add(label)
    ;(isInferred ? inferred : declared).push({ label, detail: `${isInferred ? 'inferred key' : 'foreign key'} from ${anchor}`, inferred: isInferred })
  }

  for (const { table, alias } of resolved) {
    const self = alias ?? ident(kind, table.info.name)
    for (const c of table.columns) {
      const ref = c.ref
      if (!ref || ref.table.remote) continue
      push(ref.table, (a) => `${a}.${ident(kind, ref.column)} = ${self}.${ident(kind, c.info.name)}`, table.info.name, ref.inferred)
    }
    for (const child of table.children) {
      if (child.table.remote) continue
      const inferredKey = child.table.columns.find((c) => c.info.name === child.column)?.ref?.inferred ?? false
      push(child.table, (a) => `${a}.${ident(kind, child.column)} = ${self}.${ident(kind, child.parentColumn)}`, table.info.name, inferredKey)
    }
  }
  return [...declared, ...inferred]
}
