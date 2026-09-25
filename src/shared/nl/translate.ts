import type { DbKind } from '../types'
import { formatRangeLabel, isoDate, parseDate, type DateRange } from './dates'
import { valueSources, type ChildLink, type Model, type ModelColumn, type ModelTable, type ValueSource } from './model'
import { tokenize, type Token } from './tokens'
import { containsRun, FILLER, sameWords, splitIdentifier, SQL_KEYWORDS, stem } from './words'

export type Role = 'table' | 'column' | 'value' | 'date' | 'keyword' | 'filler' | 'unknown'

export interface Span {
  start: number
  end: number
  text: string
  role: Role
  detail?: string
}

export interface TranslateResult {
  sql: string | null
  table?: ModelTable
  spans: Span[]
  notes: string[]
  /** Value lists the caller should load (then translate again) to recognise more words. */
  wanted: ValueSource[]
}

/** Loaded values per ValueSource key; null means the column had too many distinct values to use. */
export type ValueCache = Map<string, string[] | null>

const DEFAULT_LIMIT = 1000

// ---- Query model ---------------------------------------------------------------------------

/** A column on the main table, or on a parent joined through one of its foreign keys. */
interface Target {
  column: ModelColumn
  via?: ModelColumn
}

type Literal = { text: string; numeric: boolean }

type Condition =
  | { kind: 'compare'; target: Target; op: string; value: Literal }
  | { kind: 'in'; target: Target; values: Literal[]; negate: boolean }
  | { kind: 'like'; target: Target; pattern: string; negate: boolean }
  | { kind: 'null'; target: Target; isNull: boolean }
  | { kind: 'range'; target: Target; range: DateRange }
  | { kind: 'exists'; link: ChildLink; negate: boolean }

interface Query {
  table: ModelTable
  conditions: Condition[]
  shown: ModelColumn[]
  count: boolean
  groupBy?: Target
  limit?: number
  order?: { target: Target; desc: boolean }
  latest?: 'desc' | 'asc'
  includeDeleted: boolean
}

// ---- Matching helpers ----------------------------------------------------------------------

const BOUNDARY = new Set([
  'and', 'or', 'with', 'without', 'where', 'sorted', 'ordered', 'order', 'sort', 'by', 'for', 'top', 'first',
  'limit', 'after', 'before', 'since', 'until', 'till', 'between', 'during', 'that', 'which', 'having',
  'created', 'from', 'in', 'on', 'this', 'last', 'today', 'yesterday', 'not', 'but', 'per'
])

const DATE_PREPOSITIONS = new Set(['after', 'since', 'from', 'before', 'until', 'till', 'on', 'in', 'during', 'between', 'within'])
const RELATIVE_STARTERS = new Set(['today', 'yesterday', 'tomorrow', 'this', 'last', 'next', 'past', 'previous', 'current'])
const NEGATORS = new Set(['not', 'no', 'never', 'non', 'isnt', "isn't", 'without'])

interface ColumnMatch {
  column: ModelColumn
  length: number
  exact: boolean
  alternatives: ModelColumn[]
}

/** Stemmed words for the run of plain word tokens tokens[i..i+n). */
function phraseAt(tokens: Token[], i: number, n: number): string[] | null {
  const words: string[] = []
  for (let k = i; k < i + n; k++) {
    const t = tokens[k]
    if (!t || t.type !== 'word') return null
    words.push(stem(t.lower))
  }
  return words
}

/** Longest column-name match starting at tokens[i], preferring exact matches and shorter names. */
function matchColumn(table: ModelTable, tokens: Token[], i: number, used: boolean[], filter?: (c: ModelColumn) => boolean): ColumnMatch | null {
  for (let n = 4; n >= 1; n--) {
    if (used.slice(i, i + n).some(Boolean)) continue
    const phrase = phraseAt(tokens, i, n)
    if (!phrase) continue
    if (n === 1 && FILLER.has(tokens[i].lower)) continue
    const pool = table.columns.filter((c) => !filter || filter(c))
    const exact = pool.filter((c) => sameWords(c.core, phrase) || sameWords(c.words, phrase))
    const partial = exact.length ? [] : pool.filter((c) => containsRun(c.words, phrase))
    const found = (exact.length ? exact : partial).sort((a, b) => rankColumn(a) - rankColumn(b))
    if (found.length) return { column: found[0], length: n, exact: exact.length > 0, alternatives: found.slice(1, 4) }
  }
  return null
}

/** Lower is better: short names, and not audit/foreign-key plumbing. */
function rankColumn(c: ModelColumn): number {
  let rank = c.words.length
  if (c.core.some((w) => ['modified', 'deleted', 'tenant', 'updated'].includes(w))) rank += 5
  if (c.info.isPrimaryKey) rank += 3
  return rank
}

/** Matches a child table (one with a FK to `table`) against the words at tokens[i]. */
function matchChild(table: ModelTable, tokens: Token[], i: number): { link: ChildLink; length: number } | null {
  for (let n = 3; n >= 1; n--) {
    const phrase = phraseAt(tokens, i, n)
    if (!phrase || (n === 1 && FILLER.has(tokens[i].lower))) continue
    // "invoices with invoice type": the word "invoice" alone says nothing about InvoiceLines.
    if (phrase.every((w) => table.words.includes(w))) continue
    const scored = table.children
      .map((link) => {
        const words = link.table.words
        const own = words.filter((w) => !table.words.includes(w))
        const score = sameWords(own, phrase) || sameWords(words, phrase) ? 3 : containsRun(words, phrase) ? 1 : 0
        return { link, score, size: words.length }
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.size - b.size)
    if (scored.length) return { link: scored[0].link, length: n }
  }
  return null
}

/** Matches a foreign-key column by its own name or its parent table's name, e.g. "customer", "account manager". */
function matchParent(table: ModelTable, tokens: Token[], i: number): { column: ModelColumn; length: number } | null {
  for (let n = 3; n >= 1; n--) {
    const phrase = phraseAt(tokens, i, n)
    if (!phrase || (n === 1 && FILLER.has(tokens[i].lower))) continue
    const found = table.columns.find((c) => c.ref && c.ref.table.display && (sameWords(c.core, phrase) || sameWords(c.ref.table.words, phrase)))
    if (found) return { column: found, length: n }
  }
  return null
}

function literal(text: string, column?: ModelColumn): Literal {
  const numeric = /^-?\d+(\.\d+)?$/.test(text) && (!column || column.kind === 'number' || column.kind === 'bool')
  return { text, numeric }
}

// ---- Table detection -----------------------------------------------------------------------

function findTable(model: Model, tokens: Token[]): { table: ModelTable; indexes: number[] } | null {
  const allStems = new Set(tokens.filter((t) => t.type === 'word').map((t) => stem(t.lower)))
  for (let i = 0; i < tokens.length; i++) {
    for (let n = 4; n >= 1; n--) {
      const phrase = phraseAt(tokens, i, n)
      if (!phrase || (n === 1 && FILLER.has(tokens[i].lower))) continue
      const exact = model.tables.filter((t) => sameWords(t.words, phrase))
      if (exact.length) return { table: preferTable(exact), indexes: range(i, n) }
      if (n > 1) continue
      // Partial: "documents" -> CustomerDocuments. Prefer tables whose other words also appear in the request.
      const partial = model.tables
        .filter((t) => containsRun(t.words, phrase) && t.words[t.words.length - 1] === phrase[0])
        .map((t) => ({ t, extra: t.words.filter((w) => w !== phrase[0] && allStems.has(w)).length }))
        .sort((a, b) => b.extra - a.extra || a.t.words.length - b.t.words.length || (b.t.info.rowEstimate ?? 0) - (a.t.info.rowEstimate ?? 0))
      if (partial.length) {
        const table = partial[0].t
        const indexes = [i]
        tokens.forEach((t, k) => {
          if (k !== i && t.type === 'word' && table.words.includes(stem(t.lower))) indexes.push(k)
        })
        return { table, indexes }
      }
    }
  }
  return null
}

function preferTable(tables: ModelTable[]): ModelTable {
  return [...tables].sort((a, b) =>
    Number(a.info.type === 'view') - Number(b.info.type === 'view') ||
    Number(a.info.schema !== 'dbo') - Number(b.info.schema !== 'dbo') ||
    (b.info.rowEstimate ?? 0) - (a.info.rowEstimate ?? 0)
  )[0]
}

function range(start: number, n: number): number[] {
  return Array.from({ length: n }, (_, k) => start + k)
}

// ---- Translation ---------------------------------------------------------------------------

export function translate(input: string, model: Model, values: ValueCache, now = new Date()): TranslateResult {
  const tokens = tokenize(input)
  const roles: (Omit<Span, 'start' | 'end' | 'text'> | null)[] = tokens.map(() => null)
  const used = tokens.map(() => false)
  const notes: string[] = []

  const mark = (indexes: number[], role: Role, detail?: string): void => {
    for (const k of indexes) {
      roles[k] = { role, detail }
      used[k] = true
    }
  }

  const spans = (): Span[] =>
    tokens.map((t, k) => ({ start: t.start, end: t.end, text: t.text, ...(roles[k] ?? { role: FILLER.has(t.lower) ? 'filler' : 'unknown' }) }))

  const found = findTable(model, tokens)
  if (!found) {
    return { sql: null, spans: spans(), notes: tokens.length ? ['Mention a table, e.g. "invoices" or "customers".'] : [], wanted: [] }
  }

  const table = found.table
  mark(found.indexes, 'table', `${table.info.schema}.${table.info.name}`)
  const wanted = valueSources(table).filter((s) => !values.has(s.key))
  const q: Query = { table, conditions: [], shown: [], count: false, includeDeleted: false }
  const describe = (t: Target): string => (t.via ? `${t.via.info.name} → ${t.column.info.name}` : t.column.info.name)
  const noteAlternatives = (m: ColumnMatch, word: string): void => {
    if (m.alternatives.length && !m.exact) notes.push(`"${word}" → ${m.column.info.name} (also: ${m.alternatives.map((a) => a.info.name).join(', ')})`)
  }

  /** Default date column: the table's own date (InvoiceDate), then created, then any date. */
  const defaultDate = (): ModelColumn | undefined => {
    const dates = table.columns.filter((c) => c.kind === 'date')
    return (
      dates.find((c) => sameWords(c.core, table.words)) ??
      dates.find((c) => c.core.includes('created') || c.core.includes('create')) ??
      dates.find((c) => !c.core.some((w) => ['modified', 'deleted', 'updated', 'expire'].includes(w)))
    )
  }

  /** Reads a comparison value starting at tokens[i]: quoted string, number, date or words up to a boundary. */
  const readValue = (i: number): { text: string; length: number } | null => {
    const t = tokens[i]
    if (!t) return null
    if (t.type === 'quoted' || t.type === 'number' || t.type === 'date') return { text: t.text, length: 1 }
    const words: string[] = []
    let k = i
    while (tokens[k] && tokens[k].type === 'word' && !BOUNDARY.has(tokens[k].lower) && !used[k]) {
      words.push(tokens[k].text)
      k++
    }
    return words.length ? { text: words.join(' '), length: words.length } : null
  }

  /** Reads "<preposition>? <date>" or "between <date> and <date>" at tokens[i] into a range. */
  const readDateCondition = (i: number, allowBare: boolean): { range: DateRange; length: number } | null => {
    const w = tokens[i]?.lower
    if (!w) return null
    if (w === 'between' || w === 'from') {
      const a = parseDate(tokens, i + 1, now)
      const sep = a && tokens[i + 1 + a.length]?.lower
      if (a && (sep === 'and' || sep === 'to' || sep === 'until')) {
        const b = parseDate(tokens, i + 2 + a.length, now)
        if (b) return { range: { from: a.range.from, to: b.range.to }, length: 2 + a.length + b.length }
      }
    }
    if (DATE_PREPOSITIONS.has(w)) {
      const d = parseDate(tokens, i + 1, now)
      if (!d) return null
      const r = d.range
      switch (w) {
        case 'after': return { range: { from: r.to }, length: 1 + d.length }
        case 'since': case 'from': return { range: { from: r.from }, length: 1 + d.length }
        case 'before': return { range: { to: r.from }, length: 1 + d.length }
        case 'until': case 'till': return { range: { to: r.to }, length: 1 + d.length }
        default: return { range: r, length: 1 + d.length }
      }
    }
    if (!allowBare) return null
    const t = tokens[i]
    const relative = RELATIVE_STARTERS.has(w) || t.type === 'date' || tokens[i + 2]?.lower === 'ago'
    const d = relative ? parseDate(tokens, i, now) : null
    return d ? { range: d.range, length: d.length } : null
  }

  let negate = false

  for (let i = 0; i < tokens.length; ) {
    if (used[i]) {
      i++
      continue
    }
    const t = tokens[i]
    const w = t.lower
    const w2 = tokens[i + 1]?.lower

    // how many / count / number of
    if ((w === 'how' && w2 === 'many') || (w === 'number' && w2 === 'of') || w === 'count' || (w === 'total' && w2 === 'number')) {
      const length = w === 'count' ? 1 : w === 'total' ? (tokens[i + 2]?.lower === 'of' ? 3 : 2) : 2
      mark(range(i, length), 'keyword', 'count rows')
      q.count = true
      i += length
      continue
    }

    // count ... by/per <column>
    if (q.count && (w === 'by' || w === 'per' || (w === 'grouped' && w2 === 'by'))) {
      const offset = w === 'grouped' ? 2 : 1
      const target = matchTarget(i + offset)
      if (target) {
        mark(range(i, offset), 'keyword', 'group by')
        mark(range(i + offset, target.length), 'column', describe(target.target))
        q.groupBy = target.target
        i += offset + target.length
        continue
      }
    }

    // top N / first N / last N
    if ((w === 'top' || w === 'first' || w === 'last' || w === 'latest' || w === 'newest') && tokens[i + 1]?.type === 'number' && !readDateCondition(i, true)) {
      q.limit = Math.max(1, Math.floor(Number(tokens[i + 1].text)))
      if (w !== 'top' && w !== 'first') q.latest = 'desc'
      if (w === 'first') q.latest = q.latest ?? undefined
      mark([i, i + 1], 'keyword', `limit ${q.limit}`)
      i += 2
      continue
    }

    // latest / newest / most recent / oldest
    if (w === 'latest' || w === 'newest' || w === 'recent' || (w === 'most' && w2 === 'recent') || w === 'oldest' || w === 'earliest') {
      const length = w === 'most' ? 2 : 1
      q.latest = w === 'oldest' || w === 'earliest' ? 'asc' : 'desc'
      mark(range(i, length), 'keyword', q.latest === 'desc' ? 'newest first' : 'oldest first')
      i += length
      continue
    }

    // including / with deleted
    if ((w === 'including' || w === 'include' || w === 'incl' || w === 'with') && (w2 === 'deleted' || w2 === 'removed')) {
      q.includeDeleted = true
      mark([i, i + 1], 'keyword', 'include deleted rows')
      i += 2
      continue
    }

    // sorted / ordered by <column> [asc|desc]
    if (w === 'sorted' || w === 'ordered' || w === 'sort' || w === 'order' || (w === 'by' && !q.count)) {
      const offset = w2 === 'by' && w !== 'by' ? 2 : 1
      const target = matchTarget(i + offset)
      if (target) {
        const dirToken = tokens[i + offset + target.length]?.lower
        const desc = ['desc', 'descending', 'highest', 'largest', 'biggest', 'newest', 'latest', 'most'].includes(dirToken ?? '')
        const hasDir = desc || ['asc', 'ascending', 'lowest', 'smallest', 'oldest', 'least'].includes(dirToken ?? '')
        const ascByDefault = !q.limit || target.target.column.kind === 'text'
        q.order = { target: target.target, desc: hasDir ? desc : !ascByDefault }
        mark(range(i, offset), 'keyword', 'order by')
        mark(range(i + offset, target.length), 'column', describe(target.target))
        if (hasDir) mark([i + offset + target.length], 'keyword', desc ? 'descending' : 'ascending')
        i += offset + target.length + (hasDir ? 1 : 0)
        continue
      }
    }

    // negation for the next condition
    if (NEGATORS.has(w) && w !== 'without') {
      negate = true
      mark([i], 'keyword', 'not')
      i++
      continue
    }

    // with / without / having <child table | column | parent>
    if (w === 'with' || w === 'without' || w === 'having' || ((w === 'that' || w === 'which') && (w2 === 'have' || w2 === 'has'))) {
      let offset = w === 'that' || w === 'which' ? 2 : 1
      let neg = w === 'without' || negate
      const quantifier = tokens[i + offset]?.lower
      if (quantifier === 'no') {
        neg = true
        offset++
      } else if (['a', 'an', 'any', 'some', 'at'].includes(quantifier ?? '')) {
        offset += quantifier === 'at' && tokens[i + offset + 1]?.lower === 'least' ? 3 : 1
      }
      // Take whichever reading covers the most words: child table, parent lookup or plain column.
      const child = matchChild(table, tokens, i + offset)
      const parentFirst = matchParent(table, tokens, i + offset)
      const columnFirst = matchColumn(table, tokens, i + offset, used)
      const longest = Math.max(parentFirst?.length ?? 0, columnFirst?.length ?? 0)
      if (child && child.length >= longest) {
        q.conditions.push({ kind: 'exists', link: child.link, negate: neg })
        mark(range(i, offset), 'keyword', neg ? 'has none' : 'has at least one')
        mark(range(i + offset, child.length), 'table', `${child.link.table.info.name}.${child.link.column}`)
        negate = false
        i += offset + child.length
        continue
      }
      const parent = matchParent(table, tokens, i + offset)
      if (parent && !neg) {
        if (!q.shown.includes(parent.column)) q.shown.push(parent.column)
        mark(range(i, offset), 'keyword', 'also show')
        mark(range(i + offset, parent.length), 'column', `${parent.column.ref!.table.info.name}.${parent.column.ref!.table.display!.info.name}`)
        i += offset + parent.length
        continue
      }
      const column = matchColumn(table, tokens, i + offset, used)
      const after = column ? i + offset + column.length : 0
      if (column && (readOperator(after) || (column.column.kind === 'date' && readDateCondition(after, true)))) {
        // "with total over 500": "with" is just filler before a normal comparison.
        mark(range(i, offset), 'filler')
        i += offset
        continue
      }
      if (column) {
        q.conditions.push({ kind: 'null', target: { column: column.column }, isNull: neg })
        mark(range(i, offset), 'keyword', neg ? 'is empty' : 'is filled in')
        mark(range(i + offset, column.length), 'column', column.column.info.name)
        noteAlternatives(column, tokens[i + offset].text)
        negate = false
        i += offset + column.length
        continue
      }
    }

    // for / from / belonging to <parent> "<value>"
    if (w === 'for' || w === 'from' || w === 'of' || (w === 'belonging' && w2 === 'to')) {
      const offset = w === 'belonging' ? 2 : 1
      const parent = matchParent(table, tokens, i + offset)
      if (parent) {
        const value = readValue(i + offset + parent.length)
        const target: Target = { column: parent.column.ref!.table.display!, via: parent.column }
        mark(range(i, offset), 'keyword', 'belonging to')
        mark(range(i + offset, parent.length), 'column', describe(target))
        if (value) {
          q.conditions.push({ kind: 'like', target, pattern: `%${value.text}%`, negate })
          mark(range(i + offset + parent.length, value.length), 'value', `contains "${value.text}"`)
        } else if (!q.shown.includes(parent.column)) {
          q.shown.push(parent.column)
        }
        negate = false
        i += offset + parent.length + (value?.length ?? 0)
        continue
      }
      // No foreign key: fall back to a text column, e.g. "for customer acme" -> CustomerName LIKE '%acme%'.
      const textColumn = matchColumn(table, tokens, i + offset, used, (c) => c.kind === 'text' && !c.ref)
      const value = textColumn && readValue(i + offset + textColumn.length)
      if (textColumn && value) {
        const named = table.columns.find((c) =>
          c.kind === 'text' && containsRun(c.words, textColumn.column.core.slice(0, 1)) && c.core.includes('name'))
        const target: Target = { column: textColumn.exact ? textColumn.column : named ?? textColumn.column }
        q.conditions.push({ kind: 'like', target, pattern: `%${value.text}%`, negate })
        mark(range(i, offset), 'keyword', 'belonging to')
        mark(range(i + offset, textColumn.length), 'column', target.column.info.name)
        mark(range(i + offset + textColumn.length, value.length), 'value', `contains "${value.text}"`)
        negate = false
        i += offset + textColumn.length + value.length
        continue
      }
    }

    // <column> <operator> <value>, <date column> <date>, or a column used as an adjective
    const column = matchColumn(table, tokens, i, used)
    if (column) {
      const consumed = columnCondition(column, i)
      if (consumed) {
        noteAlternatives(column, t.text)
        negate = false
        i += consumed
        continue
      }
    }

    // bare date: "after 12/12/2025", "this week"
    const date = readDateCondition(i, true)
    if (date) {
      const retarget = q.conditions.findIndex((c) => c.kind === 'null' && !c.isNull && c.target.column.kind === 'date' && !c.target.via)
      const target = retarget >= 0 ? (q.conditions[retarget] as { target: Target }).target : defaultDate() && { column: defaultDate()! }
      if (target) {
        if (retarget >= 0) q.conditions.splice(retarget, 1)
        q.conditions.push({ kind: 'range', target, range: date.range })
        mark(range(i, date.length), 'date', `${target.column.info.name}: ${formatRangeLabel(date.range)}`)
        i += date.length
        continue
      }
    }

    // bare value: "paid", "in progress", 'Closed'
    const value = matchValue(i)
    if (value) {
      i += value
      negate = false
      continue
    }

    i++
  }

  if (table.softDelete && !q.includeDeleted && !q.conditions.some((c) => 'target' in c && c.target.column === table.softDelete)) {
    const sd = table.softDelete
    q.conditions.push(sd.kind === 'bool'
      ? { kind: 'compare', target: { column: sd }, op: '=', value: { text: '0', numeric: true } }
      : { kind: 'null', target: { column: sd }, isNull: true })
    notes.push(`Deleted rows are hidden (${sd.info.name}). Add "including deleted" to show them.`)
  }

  if (q.latest && !q.order) {
    const d = defaultDate()
    if (d) q.order = { target: { column: d }, desc: q.latest === 'desc' }
  }

  for (const [k, t] of tokens.entries()) {
    if (!roles[k] && !FILLER.has(t.lower) && t.type === 'word') notes.push(`Didn't understand "${t.text}"`)
  }

  return { sql: buildSql(q, model.kind), table, spans: spans(), notes: dedupe(notes), wanted }

  // ---- closures that need the parse state ----

  function matchTarget(i: number): { target: Target; length: number } | null {
    const parent = matchParent(table, tokens, i)
    const column = matchColumn(table, tokens, i, used)
    if (parent && (!column || parent.length >= column.length) && (!column || !column.exact || column.column === parent.column)) {
      return { target: { column: parent.column.ref!.table.display!, via: parent.column }, length: parent.length }
    }
    if (!column) return null
    // Grouping or sorting by a foreign key means by its lookup's label, not the raw key.
    const c = column.column
    const target: Target = c.ref?.table.display ? { column: c.ref.table.display, via: c } : { column: c }
    return { target, length: column.length }
  }

  function columnCondition(m: ColumnMatch, i: number): number {
    const c = m.column
    let k = i + m.length
    const colName = c.info.name

    // Date column followed by a date: "created after 1/1/2025", "exported this week"
    if (c.kind === 'date') {
      const date = readDateCondition(k, true)
      if (date) {
        q.conditions.push({ kind: 'range', target: { column: c }, range: date.range })
        mark(range(i, m.length), 'column', colName)
        mark(range(k, date.length), 'date', formatRangeLabel(date.range))
        return m.length + date.length
      }
    }

    // Operators
    const op = readOperator(k)
    if (op) {
      k += op.length
      mark(range(i, m.length), 'column', colName)
      mark(range(i + m.length, op.length), 'keyword', op.label)
      if (op.op === 'empty' || op.op === 'filled') {
        q.conditions.push({ kind: 'null', target: { column: c }, isNull: (op.op === 'empty') !== negate })
        return m.length + op.length
      }
      const value = readValue(k)
      if (!value) return m.length + op.length
      // Comparing a foreign key to text means comparing its lookup's label, e.g. status is closed.
      const target: Target = c.ref?.table.display && !/^-?\d+$/.test(value.text)
        ? { column: c.ref.table.display, via: c }
        : { column: c }
      const known = canonical(target, value.text)
      if (op.op === 'like' || op.op === 'starts' || op.op === 'ends') {
        const pattern = op.op === 'like' ? `%${value.text}%` : op.op === 'starts' ? `${value.text}%` : `%${value.text}`
        q.conditions.push({ kind: 'like', target, pattern, negate: negate !== !!op.negate })
      } else {
        const sqlOp = negate ? invert(op.op) : op.op
        q.conditions.push({ kind: 'compare', target, op: sqlOp, value: literal(known ?? value.text, target.column) })
      }
      mark(range(k, value.length), 'value', known ?? value.text)
      return m.length + op.length + value.length
    }

    // Adjective use needs an exact name match to avoid false positives.
    if (!m.exact) return 0
    if (c.kind === 'date' && !c.core.includes('created')) {
      // "exported invoices" -> ExportedDatetime IS NOT NULL
      q.conditions.push({ kind: 'null', target: { column: c }, isNull: negate })
      mark(range(i, m.length), 'column', `${colName} ${negate ? 'is empty' : 'is set'}`)
      return m.length
    }
    if (c.kind === 'bool') {
      q.conditions.push({ kind: 'compare', target: { column: c }, op: '=', value: { text: negate ? '0' : '1', numeric: true } })
      mark(range(i, m.length), 'column', `${colName} = ${negate ? 0 : 1}`)
      return m.length
    }
    return 0
  }

  function readOperator(k: number): { op: string; length: number; label: string; negate?: boolean } | null {
    const a = tokens[k]?.lower
    const b = tokens[k + 1]?.lower
    const c = tokens[k + 2]?.lower
    if (!a) return null
    if (tokens[k].type === 'symbol') {
      const map: Record<string, string> = { '=': '=', '!=': '<>', '<>': '<>', '>': '>', '<': '<', '>=': '>=', '<=': '<=' }
      return { op: map[a], length: 1, label: a }
    }
    if ((a === 'is' || a === 'are') && (b === 'empty' || b === 'blank' || b === 'null' || b === 'missing')) return { op: 'empty', length: 2, label: 'is empty' }
    if ((a === 'is' || a === 'are') && b === 'not' && (c === 'empty' || c === 'blank' || c === 'null')) return { op: 'filled', length: 3, label: 'is not empty' }
    if (a === 'empty' || a === 'blank' || a === 'missing') return { op: 'empty', length: 1, label: 'is empty' }
    if ((a === 'is' || a === 'are') && b === 'not') return { op: '<>', length: 2, label: 'is not' }
    if (a === 'isnt' || a === "isn't" || a === 'not') return { op: '<>', length: 1, label: 'is not' }
    if ((a === 'greater' || a === 'more' || a === 'larger' || a === 'bigger' || a === 'higher') && b === 'than') return { op: '>', length: 2, label: '>' }
    if ((a === 'less' || a === 'lower' || a === 'smaller' || a === 'fewer') && b === 'than') return { op: '<', length: 2, label: '<' }
    if (a === 'at' && b === 'least') return { op: '>=', length: 2, label: '≥' }
    if (a === 'at' && b === 'most') return { op: '<=', length: 2, label: '≤' }
    if (a === 'over' || a === 'above' || a === 'exceeding') return { op: '>', length: 1, label: '>' }
    if (a === 'under' || a === 'below') return { op: '<', length: 1, label: '<' }
    if (a === 'contains' || a === 'containing' || a === 'like' || a === 'includes' || a === 'including') return { op: 'like', length: 1, label: 'contains' }
    if ((a === 'does' || a === 'doesnt' || a === "doesn't") && (b === 'not' || b === 'contain')) {
      return { op: 'like', length: b === 'not' ? 3 : 2, label: "doesn't contain", negate: true }
    }
    if ((a === 'starts' || a === 'begins' || a === 'starting' || a === 'beginning') && b === 'with') return { op: 'starts', length: 2, label: 'starts with' }
    if ((a === 'ends' || a === 'ending') && b === 'with') return { op: 'ends', length: 2, label: 'ends with' }
    if (a === 'is' || a === 'are' || a === 'equals' || a === 'equal' || a === 'was' || a === '=') {
      return { op: '=', length: b === 'to' && a === 'equal' ? 2 : 1, label: '=' }
    }
    return null
  }

  function canonical(target: Target, text: string): string | undefined {
    const list = valuesFor(target)
    return list?.find((v) => v.toLowerCase() === text.toLowerCase())
  }

  function valuesFor(target: Target): string[] | undefined {
    if (target.via) {
      const source = valueSources(table).find((s) => s.column === target.via!.info.name && s.via)
      return source ? values.get(source.key) ?? undefined : undefined
    }
    if (target.column.enumValues) return target.column.enumValues
    const source = valueSources(table).find((s) => s.column === target.column.info.name && !s.via)
    return source ? values.get(source.key) ?? undefined : undefined
  }

  /** Matches loaded category values (lookups, enums, status columns) and boolean columns by name. */
  function matchValue(i: number): number {
    const candidates: { target: Target; value: string; length: number; hinted: boolean }[] = []
    const sources: { target: Target; list: string[]; hinted: boolean }[] = []
    for (const column of table.columns) {
      const hinted = column.core.some((w) => ['status', 'state', 'stage'].includes(w))
      if (column.enumValues) sources.push({ target: { column }, list: column.enumValues, hinted })
    }
    for (const source of valueSources(table)) {
      const list = values.get(source.key)
      if (!list) continue
      const column = table.columns.find((c) => c.info.name === source.column)!
      const target: Target = source.via ? { column: column.ref!.table.display!, via: column } : { column }
      sources.push({ target, list, hinted: column.core.some((w) => ['status', 'state', 'stage'].includes(w)) })
    }

    for (let n = Math.min(4, tokens.length - i); n >= 1; n--) {
      if (used.slice(i, i + n).some(Boolean)) continue
      const slice = tokens.slice(i, i + n)
      if (n === 1 && slice[0].type === 'word' && FILLER.has(slice[0].lower)) break
      if (slice.some((t) => t.type !== 'word' && t.type !== 'quoted')) continue
      const text = slice.map((t) => t.lower).join(' ')
      const textStem = slice.map((t) => stem(t.lower)).join(' ')
      for (const s of sources) {
        const hit = s.list.find((v) => {
          const lv = v.toLowerCase()
          return lv === text || lv.split(/[^a-z0-9]+/).map(stem).join(' ') === textStem
        })
        if (hit) candidates.push({ target: s.target, value: hit, length: n, hinted: s.hinted })
      }
      if (candidates.length) break
    }

    if (candidates.length) {
      candidates.sort((a, b) => Number(b.hinted) - Number(a.hinted))
      const best = candidates[0]
      const others = [...new Set(candidates.slice(1).map((c) => describe(c.target)))]
      if (others.length) notes.push(`"${best.value}" matched ${describe(best.target)} (also found in ${others.join(', ')})`)
      addValue(best.target, best.value, i, best.length)
      return best.length
    }

    // Boolean columns used as adjectives: "active users", "inactive users"
    const t = tokens[i]
    if (t.type === 'word') {
      const plain = stem(t.lower)
      const bare = plain.replace(/^(in|un|non)/, '')
      for (const column of table.columns.filter((c) => c.kind === 'bool')) {
        const matchesPlain = sameWords(column.core, [plain])
        if (matchesPlain || (bare !== plain && sameWords(column.core, [bare]))) {
          const truthy = matchesPlain !== negate
          q.conditions.push({ kind: 'compare', target: { column }, op: '=', value: { text: truthy ? '1' : '0', numeric: true } })
          mark([i], 'value', `${column.info.name} = ${truthy ? 1 : 0}`)
          return 1
        }
      }
    }
    return 0
  }

  /** Adds an equality on a category value, merging "paid or cancelled" into IN (...). */
  function addValue(target: Target, value: string, i: number, length: number): void {
    const previous = q.conditions[q.conditions.length - 1]
    const sameTarget = previous && 'target' in previous && previous.target.column === target.column && previous.target.via === target.via
    const joinedByOr = tokens[i - 1]?.lower === 'or'
    if (sameTarget && previous.kind === 'compare' && previous.op === '=' && joinedByOr) {
      q.conditions[q.conditions.length - 1] = { kind: 'in', target, values: [previous.value, literal(value)], negate: false }
    } else if (sameTarget && previous.kind === 'in' && joinedByOr) {
      previous.values.push(literal(value))
    } else {
      q.conditions.push(negate
        ? { kind: 'compare', target, op: '<>', value: literal(value) }
        : { kind: 'compare', target, op: '=', value: literal(value) })
    }
    const orIndex = i - 1
    if (tokens[orIndex]?.lower === 'or') mark([orIndex], 'keyword', 'or')
    mark(range(i, length), 'value', `${describe(target)} = ${value}`)
  }
}

function invert(op: string): string {
  return ({ '=': '<>', '<>': '=', '>': '<=', '<': '>=', '>=': '<', '<=': '>' } as Record<string, string>)[op] ?? op
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)]
}

// ---- SQL generation ------------------------------------------------------------------------

function buildSql(q: Query, kind: DbKind): string {
  const quote = (s: string): string => (kind === 'mssql' ? `[${s.replace(/]/g, ']]')}]` : `\`${s.replace(/`/g, '``')}\``)
  const qualified = (t: ModelTable): string => `${quote(t.info.schema)}.${quote(t.info.name)}`
  const taken = new Set<string>()
  const makeAlias = (words: string[]): string => {
    let base = words.map((w) => w[0]).join('').toLowerCase() || 't'
    if (SQL_KEYWORDS.has(base)) base = words[words.length - 1]?.toLowerCase() ?? 't'
    let alias = base
    for (let n = 2; taken.has(alias) || SQL_KEYWORDS.has(alias); n++) alias = `${base}${n}`
    taken.add(alias)
    return alias
  }

  const main = makeAlias(splitIdentifier(q.table.info.name))
  const joins = new Map<ModelColumn, string>()
  const joinAlias = (fk: ModelColumn): string => {
    let alias = joins.get(fk)
    if (!alias) {
      const words = splitIdentifier(fk.info.name).filter((w) => w !== 'id')
      const last = words[words.length - 1]
      alias = last && !SQL_KEYWORDS.has(last) && !taken.has(last) && last.length <= 12 ? last : makeAlias(words)
      taken.add(alias)
      joins.set(fk, alias)
    }
    return alias
  }
  const col = (t: Target): string => `${t.via ? joinAlias(t.via) : main}.${quote(t.column.info.name)}`
  const lit = (l: Literal): string => (l.numeric ? l.text : `'${l.text.replace(/'/g, "''")}'`)
  const dateLit = (d: Date): string => (kind === 'mssql' ? `'${isoDate(d).replace(/-/g, '')}'` : `'${isoDate(d)}'`)

  const where: string[] = []
  for (const c of q.conditions) {
    switch (c.kind) {
      case 'compare':
        where.push(`${col(c.target)} ${c.op} ${lit(c.value)}`)
        break
      case 'in':
        where.push(`${col(c.target)} ${c.negate ? 'NOT IN' : 'IN'} (${c.values.map(lit).join(', ')})`)
        break
      case 'like':
        where.push(`${col(c.target)} ${c.negate ? 'NOT LIKE' : 'LIKE'} ${lit({ text: c.pattern, numeric: false })}`)
        break
      case 'null': {
        const text = c.target.column.kind === 'text'
        where.push(c.isNull
          ? (text ? `(${col(c.target)} IS NULL OR ${col(c.target)} = '')` : `${col(c.target)} IS NULL`)
          : (text ? `${col(c.target)} <> ''` : `${col(c.target)} IS NOT NULL`))
        break
      }
      case 'range':
        if (c.range.from) where.push(`${col(c.target)} >= ${dateLit(c.range.from)}`)
        if (c.range.to) where.push(`${col(c.target)} < ${dateLit(c.range.to)}`)
        break
      case 'exists': {
        const alias = makeAlias(splitIdentifier(c.link.table.info.name))
        where.push(`${c.negate ? 'NOT EXISTS' : 'EXISTS'} (\n    SELECT 1 FROM ${qualified(c.link.table)} ${alias}\n    WHERE ${alias}.${quote(c.link.column)} = ${main}.${quote(c.link.parentColumn)}\n  )`)
        break
      }
    }
  }

  for (const fk of q.shown) joinAlias(fk)
  const shownCols = q.shown.map((fk) => `${joinAlias(fk)}.${quote(fk.ref!.table.display!.info.name)} AS ${quote(splitIdentifier(fk.info.name).filter((w) => w !== 'id').map(cap).join('') + cap(splitIdentifier(fk.ref!.table.display!.info.name).join('')))}`)
  const order = q.order ? `${col(q.order.target)} ${q.order.desc ? 'DESC' : 'ASC'}` : null

  let select: string
  let groupBy = ''
  let orderBy = order ? `\nORDER BY ${order}` : ''
  let limit = q.limit ?? (q.count ? undefined : DEFAULT_LIMIT)
  if (q.count && q.groupBy) {
    const g = col(q.groupBy)
    select = `${g}, COUNT(*) AS ${quote('Count')}`
    groupBy = `\nGROUP BY ${g}`
    orderBy = `\nORDER BY ${quote('Count')} DESC`
  } else if (q.count) {
    select = `COUNT(*) AS ${quote('Count')}`
    orderBy = ''
    limit = undefined
  } else {
    select = [`${main}.*`, ...shownCols].join(', ')
  }

  // Joins are collected while rendering conditions, so emit them last.
  const joinSql = [...joins.entries()].map(([fk, alias]) => {
    const parent = fk.ref!.table
    const required = q.conditions.some((c) => 'target' in c && c.target.via === fk && !(c.kind === 'null' && c.isNull))
    return `\n${required ? 'JOIN' : 'LEFT JOIN'} ${qualified(parent)} ${alias} ON ${alias}.${quote(fk.ref!.column)} = ${main}.${quote(fk.info.name)}`
  }).join('')

  const top = kind === 'mssql' && limit ? `TOP ${limit} ` : ''
  const tail = kind === 'mysql' && limit ? `\nLIMIT ${limit}` : ''
  const whereSql = where.length ? `\nWHERE ${where.join('\n  AND ')}` : ''
  return `SELECT ${top}${select}\nFROM ${qualified(q.table)} ${main}${joinSql}${whereSql}${groupBy}${orderBy}${tail}`
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}
