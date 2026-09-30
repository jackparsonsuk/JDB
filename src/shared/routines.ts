import type { DbKind, RoutineDefinition, RoutineKind, RoutineRef, RoutineSource, TableRef } from './types'

/** Where a routine's source mentions a table, and whether it reads it, writes it, or both. */
export interface TableUse {
  table: TableRef
  reads: boolean
  writes: boolean
}

export interface RoutineUses {
  tables: TableUse[]
  /** Other procedures and functions it calls. */
  calls: RoutineRef[]
}

type Token = { chain: string[]; quoted: boolean } | { punct: string }

/**
 * Blanks out comments and string literals, keeping offsets, so names inside them aren't read as
 * references and search results point at the right line. Double quotes are identifiers on SQL
 * Server and strings on MySQL.
 */
export function stripLiterals(source: string, kind: DbKind): string {
  const out = source.split('')
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' '
  }
  let i = 0
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === '-' && next === '-') {
      const end = source.indexOf('\n', i)
      const stop = end < 0 ? source.length : end
      blank(i, stop)
      i = stop
    } else if (kind === 'mysql' && c === '#') {
      const end = source.indexOf('\n', i)
      const stop = end < 0 ? source.length : end
      blank(i, stop)
      i = stop
    } else if (c === '/' && next === '*') {
      // SQL Server nests block comments; MySQL doesn't, but nesting is rare enough to treat alike.
      let depth = 1
      let j = i + 2
      while (j < source.length && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') { depth++; j += 2 } else if (source[j] === '*' && source[j + 1] === '/') { depth--; j += 2 } else j++
      }
      blank(i, j)
      i = j
    } else if (c === "'" || (c === '"' && kind === 'mysql')) {
      let j = i + 1
      while (j < source.length) {
        if (kind === 'mysql' && source[j] === '\\') { j += 2; continue }
        if (source[j] === c) {
          if (source[j + 1] === c) { j += 2; continue }
          break
        }
        j++
      }
      blank(i, j + 1)
      i = j + 1
    } else {
      i++
    }
  }
  return out.join('')
}

const WORD_START = /[A-Za-z_@#À-￿]/
const WORD_PART = /[A-Za-z0-9_@#$À-￿]/

/** Splits source into dotted name chains (`[dbo].[Orders]`, `o.Id`, `` `db`.`t` ``) and punctuation. */
function tokenize(source: string, kind: DbKind): Token[] {
  const text = stripLiterals(source, kind)
  const tokens: Token[] = []
  let i = 0
  const readPart = (): { name: string; quoted: boolean } | null => {
    const c = text[i]
    const close = c === '[' && kind === 'mssql' ? ']' : c === '`' ? '`' : c === '"' && kind === 'mssql' ? '"' : null
    if (close) {
      let j = i + 1
      let name = ''
      while (j < text.length) {
        if (text[j] === close) {
          if (text[j + 1] === close) { name += close; j += 2; continue }
          break
        }
        name += text[j++]
      }
      i = j + 1
      return { name, quoted: true }
    }
    if (c && WORD_START.test(c)) {
      let j = i + 1
      while (j < text.length && WORD_PART.test(text[j])) j++
      const name = text.slice(i, j)
      i = j
      return { name, quoted: false }
    }
    return null
  }
  const skipSpace = (): void => {
    while (i < text.length && /\s/.test(text[i])) i++
  }
  while (i < text.length) {
    skipSpace()
    if (i >= text.length) break
    const first = readPart()
    if (!first) {
      tokens.push({ punct: text[i] })
      i++
      continue
    }
    const chain = [first.name]
    let quoted = first.quoted
    // Follow dots, allowing `db..table` (an empty schema) and spaces around the dot.
    for (;;) {
      const save = i
      skipSpace()
      if (text[i] !== '.') { i = save; break }
      i++
      skipSpace()
      if (text[i] === '.') { chain.push(''); continue }
      const part = readPart()
      if (!part) { i = save; break }
      chain.push(part.name)
      quoted = quoted || part.quoted
    }
    tokens.push({ chain, quoted })
  }
  return tokens
}

const word = (t: Token | undefined): string | null => (t && 'chain' in t && t.chain.length === 1 && !t.quoted ? t.chain[0].toUpperCase() : null)

/** Resolves a name chain to one of `objects`, preferring `defaults` (in order) for unqualified names. */
function resolve<T extends TableRef>(chain: string[], byName: Map<string, T[]>, defaults: string[]): T | undefined {
  const name = chain[chain.length - 1]
  const candidates = byName.get(name.toLowerCase())
  if (!candidates?.length) return undefined
  const schema = chain.length > 1 ? chain[chain.length - 2] : ''
  if (schema) return candidates.find((c) => c.schema.toLowerCase() === schema.toLowerCase())
  for (const d of defaults) {
    const hit = candidates.find((c) => c.schema.toLowerCase() === d.toLowerCase())
    if (hit) return hit
  }
  return candidates.length === 1 ? candidates[0] : undefined
}

function index<T extends TableRef>(objects: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const o of objects) {
    const key = o.name.toLowerCase()
    const list = map.get(key)
    if (list) list.push(o)
    else map.set(key, [o])
  }
  return map
}

/**
 * Tables a routine reads and writes, and routines it calls, found by reading its source. A name
 * counts as a table only right after FROM, JOIN, INTO, UPDATE and the like, or when it is
 * schema-qualified, so a column that shares a table's name isn't mistaken for it.
 */
export function routineUses(
  source: string,
  kind: DbKind,
  self: RoutineRef,
  tables: TableRef[],
  routines: RoutineRef[]
): RoutineUses {
  const tokens = tokenize(source, kind)
  const tableIndex = index(tables)
  const routineIndex = index(routines.filter((r) => r.kind !== 'trigger'))
  const defaults = kind === 'mssql' ? [self.schema, 'dbo'] : [self.schema]
  const uses = new Map<string, TableUse>()
  const calls = new Map<string, RoutineRef>()
  const selfKey = `${self.schema}.${self.name}`.toLowerCase()

  const useTable = (chain: string[], write: boolean): boolean => {
    const table = resolve(chain, tableIndex, defaults)
    if (!table) return false
    const key = `${table.schema}.${table.name}`.toLowerCase()
    const entry = uses.get(key) ?? { table: { schema: table.schema, name: table.name }, reads: false, writes: false }
    if (write) entry.writes = true
    else entry.reads = true
    uses.set(key, entry)
    return true
  }
  const useRoutine = (chain: string[]): boolean => {
    const routine = resolve(chain, routineIndex, defaults)
    if (!routine) return false
    const key = `${routine.schema}.${routine.name}`.toLowerCase()
    if (key !== selfKey) calls.set(key, { schema: routine.schema, name: routine.name, kind: routine.kind })
    return true
  }

  /** The chain `offset` tokens on from i, if that token is one. */
  const chainAt = (at: number): string[] | null => {
    const t = tokens[at]
    return t && 'chain' in t ? t.chain : null
  }
  /** Skips a `TABLE` keyword (TRUNCATE TABLE) or `INTO` / `FROM` that may sit between a verb and its target. */
  const targetAfter = (at: number, optional: string[]): number => {
    let j = at
    while (optional.includes(word(tokens[j]) ?? '')) j++
    return j
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!('chain' in t)) continue
    const kw = word(t)
    const prev = word(tokens[i - 1])
    switch (kw) {
      case 'FROM': {
        // DELETE FROM x writes x; everything else after FROM is read.
        const target = chainAt(i + 1)
        if (target) useTable(target, prev === 'DELETE')
        continue
      }
      case 'JOIN':
      case 'USING': {
        const target = chainAt(i + 1)
        if (target) useTable(target, false)
        continue
      }
      case 'INTO': {
        const target = chainAt(i + 1)
        if (target && word(tokens[i + 1]) !== 'TABLE') useTable(target, true)
        continue
      }
      case 'UPDATE':
      case 'INSERT':
      case 'MERGE':
      case 'REPLACE':
      case 'TRUNCATE':
      case 'DELETE': {
        // `ON UPDATE CASCADE`, `FOR INSERT` in a trigger header and `REPLACE(` the function aren't writes.
        if (prev === 'ON' || prev === 'FOR' || prev === 'AFTER' || prev === 'BEFORE' || prev === 'OF' || prev === ',') continue
        const next = tokens[i + 1]
        if (next && 'punct' in next) continue
        const j = targetAfter(i + 1, ['INTO', 'FROM', 'TABLE', 'TOP', 'IGNORE', 'LOW_PRIORITY', 'QUICK', 'DELAYED', 'HIGH_PRIORITY'])
        const target = chainAt(j)
        if (target) {
          useTable(target, true)
          i = j
        }
        continue
      }
      case 'EXEC':
      case 'EXECUTE':
      case 'CALL': {
        let j = i + 1
        // EXEC @result = dbo.Proc
        if (chainAt(j)?.[0]?.startsWith('@') && tokens[j + 1] && 'punct' in tokens[j + 1] && (tokens[j + 1] as { punct: string }).punct === '=') j += 2
        const target = chainAt(j)
        if (target) useRoutine(target)
        continue
      }
    }
    // Qualified names anywhere, and bare names followed by "(": function calls or schema.table references.
    const next = tokens[i + 1]
    const calledAs = next && 'punct' in next && next.punct === '('
    if (t.chain.length > 1 || calledAs) {
      if (useRoutine(t.chain)) continue
    }
    // After ON it's a trigger's own table (or a join condition's alias.column, which won't resolve).
    if (t.chain.length > 1 && t.chain[t.chain.length - 2] && prev !== 'ON') useTable(t.chain, false)
  }

  const sort = <T extends TableRef>(a: T, b: T): number => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name)
  return {
    tables: [...uses.values()].sort((a, b) => Number(b.writes) - Number(a.writes) || sort(a.table, b.table)),
    calls: [...calls.values()].sort(sort)
  }
}

export interface SourceMatch {
  source: RoutineSource
  /** Occurrences of the search text. */
  count: number
  /** 1-based line of the first occurrence. */
  line: number
  /** That line, trimmed and shortened around the match; `start`/`end` mark the match in it. */
  snippet: string
  start: number
  end: number
}

const SNIPPET_WIDTH = 90

/** Lowercased sources, kept while the source objects live, so each keystroke doesn't redo them. */
const lowered = new WeakMap<RoutineSource, string>()
function lowerOf(source: RoutineSource, text: string): string {
  let value = lowered.get(source)
  if (value === undefined) {
    value = text.toLowerCase()
    lowered.set(source, value)
  }
  return value
}

/** Routines whose source contains `needle` (case-insensitive), most occurrences first. */
export function searchSources(sources: RoutineSource[], needle: string, limit = 200): SourceMatch[] {
  const lower = needle.trim().toLowerCase()
  if (!lower) return []
  const out: SourceMatch[] = []
  for (const source of sources) {
    const text = source.definition
    if (!text) continue
    const hay = lowerOf(source, text)
    const first = hay.indexOf(lower)
    if (first < 0) continue
    let count = 0
    for (let at = first; at >= 0; at = hay.indexOf(lower, at + lower.length)) count++
    const lineStart = text.lastIndexOf('\n', first) + 1
    const lineEndAt = text.indexOf('\n', first)
    const lineEnd = lineEndAt < 0 ? text.length : lineEndAt
    const line = text.slice(0, first).split('\n').length
    const raw = text.slice(lineStart, lineEnd).replace(/\t/g, '  ')
    const offset = text.slice(lineStart, first).replace(/\t/g, '  ').length
    const lead = raw.length - raw.trimStart().length
    let snippet = raw.trim()
    let start = offset - lead
    // Keep the match in view on long lines.
    if (snippet.length > SNIPPET_WIDTH) {
      const from = Math.max(0, Math.min(start - 30, snippet.length - SNIPPET_WIDTH))
      snippet = `${from > 0 ? '…' : ''}${snippet.slice(from, from + SNIPPET_WIDTH)}${from + SNIPPET_WIDTH < snippet.length ? '…' : ''}`
      start = start - from + (from > 0 ? 1 : 0)
    }
    out.push({ source, count, line, snippet, start, end: start + lower.length })
  }
  return out.sort((a, b) => b.count - a.count || a.source.name.localeCompare(b.source.name)).slice(0, limit)
}

const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function name(kind: DbKind, schema: string, routine: string): string {
  const q = (part: string): string => (PLAIN_NAME.test(part) ? part : kind === 'mssql' ? `[${part.replace(/]/g, ']]')}]` : `\`${part.replace(/`/g, '``')}\``)
  return `${q(schema)}.${q(routine)}`
}

/** A ready-to-fill call of a procedure or function, with each parameter's type as a comment. Null for triggers. */
export function callTemplate(kind: DbKind, def: RoutineDefinition): string | null {
  const { routine, parameters } = def
  if (routine.kind === 'trigger') return null
  const target = name(kind, routine.schema, routine.name)
  const inline = parameters.map((p) => `NULL /* ${p.name} ${p.dataType} */`).join(', ')
  if (routine.kind === 'function') {
    if (def.returns === 'TABLE') return kind === 'mssql' ? `SELECT TOP 100 *\nFROM ${target}(${inline})` : `SELECT *\nFROM ${target}(${inline})\nLIMIT 100`
    return `SELECT ${target}(${inline})`
  }
  if (kind === 'mysql') {
    return parameters.length ? `CALL ${target}(\n  ${parameters.map((p) => `${p.mode === 'IN' ? 'NULL' : `@${p.name}`} /* ${p.mode} ${p.name} ${p.dataType} */`).join(',\n  ')}\n)` : `CALL ${target}()`
  }
  if (!parameters.length) return `EXEC ${target}`
  const outputs = parameters.filter((p) => p.mode !== 'IN')
  const declare = outputs.length ? `DECLARE ${outputs.map((p) => `${p.name} ${p.dataType}`).join(', ')}\n\n` : ''
  const lines = parameters.map((p, i) => {
    const value = p.mode === 'IN' ? 'NULL' : `${p.name} OUTPUT`
    return `  ${p.name} = ${value}${i < parameters.length - 1 ? ',' : ''}`.padEnd(40) + ` -- ${p.dataType}`
  })
  const select = outputs.length ? `\n\nSELECT ${outputs.map((p) => p.name).join(', ')}` : ''
  return `${declare}EXEC ${target}\n${lines.join('\n')}${select}`
}

export const ROUTINE_LABELS: Record<RoutineKind, { short: string; plural: string; singular: string }> = {
  procedure: { short: 'PROC', plural: 'Procedures', singular: 'procedure' },
  function: { short: 'FN', plural: 'Functions', singular: 'function' },
  trigger: { short: 'TRG', plural: 'Triggers', singular: 'trigger' }
}

export const sameRoutine = (a: RoutineRef, b: RoutineRef): boolean =>
  a.kind === b.kind && a.schema === b.schema && a.name === b.name
