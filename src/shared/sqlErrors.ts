import type { Model } from './nl/model'
import { maskLiterals, mentionedTables, resolveMentions } from './sqlComplete'

/**
 * Reads a server error against the SQL that caused it: where in the text it points (a misspelt
 * column or table, the token a syntax error is near, or just a line), and for unknown names the
 * nearest names that do exist.
 */
export interface ErrorHelp {
  /** Offsets of the offending text in the SQL that ran, when it could be found. */
  spot?: { from: number; to: number }
  /** 1-based line in the SQL that ran. */
  line?: number
  /** An unknown column or table, and real names close to it. */
  unknown?: { kind: 'column' | 'table'; name: string; suggestions: string[] }
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Case-insensitive edit distance, for "did you mean". */
export function distance(a: string, b: string): number {
  a = a.toLowerCase()
  b = b.toLowerCase()
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = row[j]
      row[j] = next
    }
  }
  return row[b.length]
}

/** Up to `max` candidates close to `name`: a small edit distance, or one containing the other. */
export function nearestNames(name: string, candidates: string[], max = 3): string[] {
  const lower = name.toLowerCase()
  const limit = Math.max(2, Math.floor(name.length / 3))
  return [...new Set(candidates)]
    .filter((c) => c.toLowerCase() !== lower)
    .map((c) => {
      const d = distance(name, c)
      const contains = c.toLowerCase().includes(lower) || lower.includes(c.toLowerCase())
      return { c, score: d <= limit ? d : contains && Math.min(c.length, name.length) >= 3 ? limit + 1 : Infinity }
    })
    .filter((x) => x.score < Infinity)
    .sort((a, b) => a.score - b.score || a.c.length - b.c.length)
    .slice(0, max)
    .map((x) => x.c)
}

const lineStart = (sql: string, line: number): number => {
  let at = 0
  for (let n = 1; n < line; n++) {
    const next = sql.indexOf('\n', at)
    if (next < 0) return sql.length
    at = next + 1
  }
  return at
}
const lineOf = (sql: string, offset: number): number => sql.slice(0, offset).split('\n').length

/** Where a name appears as a whole identifier (bare or quoted, optionally after `qualifier.`), preferring `line`. */
function findName(sql: string, name: string, qualifier: string | undefined, line?: number): { from: number; to: number } | undefined {
  const masked = maskLiterals(sql)
  const quoted = `(?:\\[${esc(name)}\\]|\`${esc(name)}\`|"${esc(name)}"|(?<![\\w@#$])${esc(name)}(?![\\w$#]))`
  const q = qualifier ? `(?:(?:\\[${esc(qualifier)}\\]|\`${esc(qualifier)}\`|"${esc(qualifier)}"|(?<![\\w@#$])${esc(qualifier)})\\s*\\.\\s*)` : ''
  const re = new RegExp(`${q}(${quoted})`, 'gi')
  const hits: { from: number; to: number }[] = []
  for (const m of masked.matchAll(re)) {
    const inner = m[1]
    const from = m.index! + m[0].length - inner.length + (/^[[`"]/.test(inner) ? 1 : 0)
    hits.push({ from, to: from + name.length })
  }
  if (!hits.length) return undefined
  return (line && hits.find((h) => lineOf(sql, h.from) === line)) || hits[0]
}

/** Column and table names the statement could have meant. */
function columnCandidates(sql: string, model: Model, qualifier?: string): string[] {
  const tables = resolveMentions(mentionedTables(sql), model)
  const scoped = qualifier ? tables.filter((t) => (t.alias ?? t.table.info.name).toLowerCase() === qualifier.toLowerCase()) : tables
  const pool = scoped.length ? scoped : tables
  const names = pool.flatMap((t) => t.table.columns.map((c) => c.info.name))
  return names.length ? names : model.tables.flatMap((t) => t.columns.map((c) => c.info.name))
}

const lastPart = (name: string): { qualifier?: string; name: string } => {
  const parts = name.split('.').map((p) => p.replace(/^[[`"]|[\]`"]$/g, ''))
  return { name: parts[parts.length - 1], qualifier: parts.length > 1 ? parts[parts.length - 2] : undefined }
}

export function explainError(message: string, sql: string, model: Model | null, serverLine?: number): ErrorHelp {
  const atLine = /\bat line (\d+)\b/i.exec(message)
  const line = serverLine ?? (atLine ? Number(atLine[1]) : undefined)
  const help: ErrorHelp = { ...(line && { line }) }

  const column = /Invalid column name '([^']+)'|Unknown column '([^']+)'|multi-part identifier "([^"]+)" could not be bound|Ambiguous column name '([^']+)'/i.exec(message)
  const table = /Invalid object name '([^']+)'|Table '([^']+)' doesn't exist/i.exec(message)
  if (column) {
    const raw = column[1] ?? column[2] ?? column[3] ?? column[4]
    const { name, qualifier } = lastPart(raw)
    help.spot = findName(sql, name, qualifier, line)
    if (!/Ambiguous/i.test(column[0])) {
      help.unknown = { kind: 'column', name, suggestions: model ? nearestNames(name, columnCandidates(sql, model, qualifier)) : [] }
    }
  } else if (table) {
    const { name, qualifier } = lastPart(table[1] ?? table[2])
    // MySQL names the database ("shop.ordrs") rather than what was written, so match the table part alone.
    help.spot = findName(sql, name, table[1] ? qualifier : undefined, line) ?? findName(sql, name, undefined, line)
    help.unknown = { kind: 'table', name, suggestions: model ? nearestNames(name, model.tables.map((t) => t.info.name)) : [] }
  } else {
    // MySQL quotes the text from the error on: near 'WHERE x' at line 2. SQL Server just the token.
    const near = /near '([\s\S]*?)'(?: at line \d+|\.|$)/i.exec(message)
    const fragment = near?.[1]
    if (fragment) {
      const start = line ? lineStart(sql, line) : 0
      const head = fragment.split('\n')[0].slice(0, 40)
      let from = head ? sql.indexOf(head, start) : -1
      if (from < 0 && head) from = sql.indexOf(head)
      if (from >= 0) {
        const token = /^\S+/.exec(head)?.[0] ?? head
        help.spot = { from, to: from + token.length }
      }
    }
  }
  if (help.spot && !help.line) help.line = lineOf(sql, help.spot.from)
  return help
}
