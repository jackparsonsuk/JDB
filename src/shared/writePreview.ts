import type { DbKind } from './types'
import { lex, type SqlToken } from './sqlLayout'

/**
 * Before a write runs, works out how many rows it would touch: a SELECT COUNT(*) built from the
 * statement's own FROM / WHERE, or the number of rows an INSERT ... VALUES lists. Only single
 * UPDATE, DELETE and INSERT statements are read; anything else says why it can't be counted.
 */
export type WritePreview =
  | {
      verb: 'update' | 'delete' | 'insert'
      /** The table written to, as written in the statement. */
      target: string
      /** A read-only query returning the count in its first column; absent when `rows` is known already. */
      countSql?: string
      /** Rows an INSERT ... VALUES lists, known without asking the server. */
      rows?: number
      /** No WHERE clause: every row of the table is changed. */
      noWhere: boolean
      /** Joins are involved, so a row that joins more than once is counted more than once. */
      approximate: boolean
    }
  | { unsupported: string }

const unsupported = (reason: string): WritePreview => ({ unsupported: reason })

const isComment = (t: SqlToken): boolean => t.type === 'line-comment' || t.type === 'block-comment'
const word = (t: SqlToken | undefined): string | null => (t && t.type === 'word' ? t.upper : null)

/** The statements in a batch, split at top-level semicolons, without empty ones. */
function statements(tokens: SqlToken[]): SqlToken[][] {
  const out: SqlToken[][] = [[]]
  let depth = 0
  for (const t of tokens) {
    if (isComment(t)) continue
    if (t.type === 'punct') {
      if (t.text === '(') depth++
      else if (t.text === ')') depth--
      else if (t.text === ';' && depth === 0) {
        out.push([])
        continue
      }
    }
    out[out.length - 1].push(t)
  }
  return out.filter((s) => s.length)
}

/** Indexes of `words` at the statement's top level (outside parentheses), in order. */
function topLevel(tokens: SqlToken[], words: string[]): { word: string; at: number }[] {
  const found: { word: string; at: number }[] = []
  let depth = 0
  tokens.forEach((t, at) => {
    if (t.type === 'punct') {
      if (t.text === '(') depth++
      else if (t.text === ')') depth--
      return
    }
    const w = word(t)
    if (depth === 0 && w && words.includes(w)) found.push({ word: w, at })
  })
  return found
}

export function previewWrite(sql: string, kind: DbKind): WritePreview {
  const all = statements(lex(sql, kind))
  if (!all.length) return unsupported('There is no statement to count.')
  if (all.length > 1) return unsupported("It's a batch of several statements, so the rows can't be counted up front.")
  const t = all[0]
  const text = (from: number, to = t.length): string => {
    if (from >= to) return ''
    const start = t[from].start
    const last = t[to - 1]
    return sql.slice(start, last.start + last.text.length)
  }
  const verb = word(t[0])
  // T-SQL batches can hold several statements without semicolons: another statement word at the
  // top level means a second statement. MySQL's ON DUPLICATE KEY UPDATE and INSERT ... EXEC don't.
  const second = topLevel(t, ['UPDATE', 'DELETE', 'INSERT', 'REPLACE', 'MERGE', 'DECLARE', 'SET', 'EXEC', 'EXECUTE', 'IF', 'BEGIN', 'CREATE', 'DROP', 'ALTER', 'TRUNCATE', 'SELECT'])
    .filter(({ word: w, at }) => {
      if (at === 0) return false
      if (w === 'UPDATE' && word(t[at - 1]) === 'KEY') return false
      if (w === 'SET' && verb === 'UPDATE') return false
      if (w === 'SET' && word(t[at - 1]) === 'KEY') return false
      if (w === 'SELECT' && (verb === 'INSERT' || verb === 'REPLACE')) return false
      if ((w === 'EXEC' || w === 'EXECUTE') && (verb === 'INSERT' || verb === 'REPLACE')) return false
      return true
    })
  if (second.length && (verb === 'UPDATE' || verb === 'DELETE' || verb === 'INSERT' || verb === 'REPLACE')) {
    return unsupported("It's a batch of several statements, so the rows can't be counted up front.")
  }
  switch (verb) {
    case 'UPDATE':
      return previewUpdate(t, text, kind)
    case 'DELETE':
      return previewDelete(t, text, kind)
    case 'INSERT':
    case 'REPLACE':
      return previewInsert(t, text)
    case 'MERGE':
      return unsupported("MERGE can insert, update and delete at once, so there's no single count to show.")
    case 'WITH':
      return unsupported("Statements that start with WITH can't be counted up front.")
    default:
      return unsupported(`${verb ?? 'This statement'} isn't a row change that can be counted up front.`)
  }
}

/** Clauses that change which or how many rows a write touches, so a plain count would be wrong. */
function limiting(t: SqlToken[]): string | null {
  const found = topLevel(t, ['TOP', 'LIMIT', 'OUTPUT', 'RETURNING', 'ORDER'])[0]
  return found ? found.word : null
}

function targetName(t: SqlToken[], from: number): string {
  const parts: string[] = []
  let k = from
  while (k < t.length && (t[k].type === 'word' || t[k].type === 'quoted' || t[k].type === 'variable')) {
    const tok = t[k]
    parts.push(tok.type === 'quoted' ? tok.text.slice(1, -1) : tok.text)
    if (t[k + 1]?.type === 'punct' && t[k + 1].text === '.') k += 2
    else break
  }
  return parts.join('.') || 'the table'
}

function previewUpdate(t: SqlToken[], text: (from: number, to?: number) => string, kind: DbKind): WritePreview {
  const limit = limiting(t)
  if (limit) return unsupported(`It uses ${limit}, which changes how many rows it touches, so a plain count would mislead.`)
  const set = topLevel(t, ['SET'])[0]
  if (!set) return unsupported("There's no SET, so it doesn't look like a complete UPDATE.")
  const where = topLevel(t, ['WHERE']).find((w) => w.at > set.at)
  const from = kind === 'mssql' ? topLevel(t, ['FROM']).find((f) => f.at > set.at && (!where || f.at < where.at)) : undefined
  const tables = text(1, set.at)
  const joins = topLevel(t.slice(0, where?.at ?? t.length), ['JOIN', 'APPLY']).length > 0
  // SQL Server's UPDATE ... SET ... FROM names the rows through its own FROM; otherwise the tables before SET.
  const source = from ? text(from.at + 1, where?.at ?? t.length) : tables
  const filter = where ? ` ${text(where.at)}` : ''
  return {
    verb: 'update',
    target: targetName(t, 1),
    countSql: `SELECT COUNT(*) FROM ${source}${filter}`,
    noWhere: !where,
    approximate: joins || (!!from && /,/.test(source))
  }
}

function previewDelete(t: SqlToken[], text: (from: number, to?: number) => string, kind: DbKind): WritePreview {
  const limit = limiting(t)
  if (limit) return unsupported(`It uses ${limit}, which changes how many rows it touches, so a plain count would mislead.`)
  if (topLevel(t, ['USING']).length) return unsupported("DELETE ... USING can't be counted up front.")
  const froms = topLevel(t, ['FROM'])
  const where = topLevel(t, ['WHERE'])[0]
  const direct = word(t[1]) === 'FROM'
  // DELETE FROM t [FROM t JOIN ...] / DELETE a FROM t a JOIN ... / DELETE t WHERE ... (SQL Server)
  const countFrom = direct ? (froms[1] ?? froms[0]) : froms[0]
  const target = targetName(t, direct ? 2 : 1)
  let source: string
  if (countFrom) source = text(countFrom.at + 1, where?.at ?? t.length)
  else if (kind === 'mssql') source = text(1, where?.at ?? t.length)
  else return unsupported("It doesn't look like a complete DELETE.")
  const joins = topLevel(t, ['JOIN', 'APPLY']).length > 0
  return {
    verb: 'delete',
    target,
    countSql: `SELECT COUNT(*) FROM ${source}${where ? ` ${text(where.at)}` : ''}`,
    noWhere: !where,
    approximate: joins
  }
}

function previewInsert(t: SqlToken[], text: (from: number, to?: number) => string): WritePreview {
  let k = 1
  while (['INTO', 'IGNORE', 'LOW_PRIORITY', 'DELAYED', 'HIGH_PRIORITY'].includes(word(t[k]) ?? '')) k++
  const target = targetName(t, k)
  const values = topLevel(t, ['VALUES', 'VALUE'])[0]
  const select = topLevel(t, ['SELECT', 'WITH'])[0]
  if (topLevel(t, ['EXEC', 'EXECUTE']).length) return unsupported("It inserts what a procedure returns, which can't be counted up front.")
  if (topLevel(t, ['OUTPUT', 'RETURNING']).length) return unsupported("It uses OUTPUT, so it can't be counted up front.")
  if (values && (!select || values.at < select.at)) {
    // Count the (...) groups listed after VALUES.
    let rows = 0
    let depth = 0
    for (let i = values.at + 1; i < t.length; i++) {
      const tok = t[i]
      if (tok.type !== 'punct') {
        if (depth === 0 && tok.type === 'word' && tok.upper === 'ON') break // ON DUPLICATE KEY UPDATE
        continue
      }
      if (tok.text === '(') {
        if (depth === 0) rows++
        depth++
      } else if (tok.text === ')') depth--
    }
    return { verb: 'insert', target, rows, noWhere: false, approximate: false }
  }
  if (select) {
    const tail = topLevel(t, ['ON']).find((o) => o.at > select.at && word(t[o.at + 1]) === 'DUPLICATE')
    return {
      verb: 'insert',
      target,
      countSql: `SELECT COUNT(*) FROM (${text(select.at, tail?.at ?? t.length)}) AS jdb_rows`,
      noWhere: false,
      approximate: false
    }
  }
  return unsupported("It doesn't say which rows to insert (no VALUES or SELECT).")
}
