import type { DbKind } from './types'

/**
 * Lays out stored procedure source for reading, and outlines what it does.
 *
 * Formatting only ever changes whitespace and the case of keywords: statements go on their own
 * lines, blocks and IF/ELSE bodies are indented, clauses start new lines, and long select lists
 * and conditions break one item per line. The result is re-tokenised and compared with the
 * original, and the original is returned unchanged if anything but spacing differs.
 */

type TokenType = 'word' | 'quoted' | 'string' | 'number' | 'variable' | 'line-comment' | 'block-comment' | 'punct'

export interface SqlToken {
  type: TokenType
  text: string
  /** Upper case, for keyword checks. */
  upper: string
  start: number
  /** Newlines in the whitespace before this token. */
  nl: number
  /** Whether any whitespace came before it. */
  space: boolean
}

const WORD_START = /[A-Za-z_À-￿]/
const WORD_PART = /[A-Za-z0-9_@#$À-￿]/

/** Splits SQL into tokens. Never throws; anything unrecognised becomes a one-character punct token. */
export function lex(source: string, kind: DbKind): SqlToken[] {
  const tokens: SqlToken[] = []
  let i = 0
  let nl = 0
  let space = false
  const push = (type: TokenType, start: number, end: number): void => {
    const text = source.slice(start, end)
    tokens.push({ type, text, upper: type === 'word' ? text.toUpperCase() : text, start, nl, space })
    nl = 0
    space = false
    i = end
  }
  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') {
      if (c === '\n') nl++
      space = true
      i++
      continue
    }
    if ((c === '-' && next === '-') || (c === '#' && kind === 'mysql')) {
      const end = source.indexOf('\n', i)
      let stop = end < 0 ? source.length : end
      // Keep a Windows line ending's \r out of the comment.
      if (stop > i && source[stop - 1] === '\r') stop--
      push('line-comment', i, stop)
      continue
    }
    if (c === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < source.length && depth > 0) {
        if (kind === 'mssql' && source[j] === '/' && source[j + 1] === '*') { depth++; j += 2 } else if (source[j] === '*' && source[j + 1] === '/') { depth--; j += 2 } else j++
      }
      push('block-comment', i, j)
      continue
    }
    if (c === "'" || (c === '"' && kind === 'mysql')) {
      let j = i + 1
      while (j < source.length) {
        if (kind === 'mysql' && source[j] === '\\') { j += 2; continue }
        if (source[j] === c) {
          if (source[j + 1] === c) { j += 2; continue }
          break
        }
        j++
      }
      push('string', i, Math.min(j + 1, source.length))
      continue
    }
    const close = c === '[' && kind === 'mssql' ? ']' : c === '"' ? '"' : c === '`' ? '`' : null
    if (close) {
      let j = i + 1
      while (j < source.length) {
        if (source[j] === close) {
          if (source[j + 1] === close) { j += 2; continue }
          break
        }
        j++
      }
      push('quoted', i, Math.min(j + 1, source.length))
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && next !== undefined && /[0-9]/.test(next))) {
      let j = i
      if (c === '0' && (next === 'x' || next === 'X')) {
        j += 2
        while (j < source.length && /[0-9A-Fa-f]/.test(source[j])) j++
      } else {
        while (j < source.length && /[0-9.]/.test(source[j])) j++
        if ((source[j] === 'e' || source[j] === 'E') && /[0-9+-]/.test(source[j + 1] ?? '')) {
          j += 2
          while (j < source.length && /[0-9]/.test(source[j])) j++
        }
      }
      push('number', i, j)
      continue
    }
    if (c === '@' && next !== undefined && (WORD_PART.test(next) || next === '@')) {
      let j = i + 1
      while (j < source.length && (WORD_PART.test(source[j]) || source[j] === '@')) j++
      push('variable', i, j)
      continue
    }
    if (WORD_START.test(c) || (c === '#' && kind === 'mssql')) {
      let j = i + 1
      while (j < source.length && WORD_PART.test(source[j])) j++
      push('word', i, j)
      continue
    }
    push('punct', i, i + 1)
  }
  return tokens
}

/** Reserved words that are written in capitals. Words after or before a dot are never changed. */
const KEYWORDS = new Set((
  'ADD ALL ALTER AND ANY APPLY AS ASC BEGIN BETWEEN BREAK BY CALL CASCADE CASE CATCH CHECK CLOSE COLLATE COMMIT ' +
  'CONSTRAINT CONTINUE CREATE CROSS CURSOR DEALLOCATE DECLARE DEFAULT DELETE DENY DESC DISTINCT DISTRIBUTED DO DROP EACH ' +
  'ELSE ELSEIF END EXCEPT EXEC EXECUTE EXISTS FETCH FOR FOREIGN FROM FULL FUNCTION GOTO GRANT GROUP HANDLER HAVING IF ' +
  'IN INNER INOUT INSERT INSTEAD INTERSECT INTO IS ITERATE JOIN LEAVE LEFT LIKE LIMIT LOOP MERGE NOT NULL OF OFFSET ON ' +
  'OPEN OPTION OR ORDER OUTER OUTPUT OVER PARTITION PERCENT PRIMARY PRINT PROC PROCEDURE RAISERROR REFERENCES REPEAT ' +
  'RESIGNAL RETURN RETURNS REVOKE RIGHT ROLLBACK SAVE SELECT SET SIGNAL THEN THROW TOP TRAN TRANSACTION TRIGGER TRUNCATE ' +
  'TRY UNION UNIQUE UNTIL UPDATE USING VALUES VIEW WAITFOR WHEN WHERE WHILE WITH NOCOUNT TABLE DUPLICATE KEY INTERVAL'
).split(' '))

/** Words that begin a statement (subject to the checks in `startsStatement`). */
const STATEMENTS: Record<DbKind, Set<string>> = {
  mssql: new Set(('SELECT INSERT UPDATE DELETE MERGE WITH DECLARE SET IF ELSE WHILE BEGIN END RETURN EXEC EXECUTE PRINT ' +
    'RAISERROR THROW OPEN CLOSE FETCH DEALLOCATE TRUNCATE CREATE ALTER DROP COMMIT ROLLBACK SAVE GOTO BREAK CONTINUE ' +
    'WAITFOR GRANT REVOKE DENY').split(' ')),
  mysql: new Set(('SELECT INSERT UPDATE DELETE REPLACE WITH DECLARE SET IF ELSE ELSEIF WHILE BEGIN END RETURN CALL ' +
    'OPEN CLOSE FETCH TRUNCATE CREATE ALTER DROP COMMIT ROLLBACK START LEAVE ITERATE LOOP REPEAT UNTIL SIGNAL RESIGNAL ' +
    'GRANT REVOKE PREPARE EXECUTE DEALLOCATE').split(' '))
}

/** Clause keywords that start a new line within each kind of statement. */
const CLAUSES: Record<string, Set<string>> = {
  SELECT: new Set(['FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'INTO', 'OPTION', 'FOR', 'LIMIT', 'OFFSET', 'WINDOW']),
  INSERT: new Set(['VALUES', 'OUTPUT', 'ON']),
  REPLACE: new Set(['VALUES']),
  UPDATE: new Set(['SET', 'FROM', 'WHERE', 'OUTPUT', 'OPTION', 'ORDER', 'LIMIT']),
  DELETE: new Set(['FROM', 'WHERE', 'OUTPUT', 'OPTION', 'USING', 'ORDER', 'LIMIT']),
  MERGE: new Set(['USING', 'WHEN', 'OUTPUT', 'OPTION', 'SET', 'VALUES'])
}

const JOIN_WORDS = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'NATURAL', 'STRAIGHT_JOIN'])
const JOIN_TAKERS = new Set(['SELECT', 'UPDATE', 'DELETE'])
/** Lists longer than this break one item per line; conditions longer than this break before AND / OR. */
const LIST_WIDTH = 80
/** Subqueries shorter than this stay on one line. */
const SUBQUERY_WIDTH = 70
const BODY_STARTERS = ['BEGIN', 'SET', 'SELECT', 'DECLARE', 'IF', 'RETURN', 'INSERT', 'UPDATE', 'DELETE', 'EXEC', 'EXECUTE', 'WITH', 'WHILE', 'MERGE', 'TRUNCATE', 'CREATE', 'PRINT', 'RAISERROR', 'THROW', 'OPEN', 'FETCH', 'CLOSE', 'DROP']

export type OutlineKind = 'control' | 'read' | 'write' | 'call' | 'tx' | 'error' | 'return' | 'temp' | 'cursor' | 'comment'

export interface OutlineItem {
  kind: OutlineKind
  label: string
  /** 1-based line in the text the result describes. */
  line: number
  /** Nesting inside blocks and IF / WHILE bodies. */
  depth: number
}

export interface Layout {
  text: string
  outline: OutlineItem[]
  /** Whether `text` is the formatted version (false when formatting was off or not safe). */
  formatted: boolean
  /** Why formatting was skipped, when it was asked for. */
  problem?: string
}

type Frame =
  | { type: 'block'; indent: number; open: number; closer: string | null; isIf: boolean; mysqlIf?: boolean }
  | { type: 'body'; indent: number; open: number; isIf: boolean }
  | { type: 'paren'; indent: number; open: number; depth: number; list: boolean; saved: Saved }

interface Statement {
  verb: string
  indent: number
  start: number
  hasSelect?: boolean
  /** MERGE: inside a WHEN ... THEN action, whose clauses indent one more. */
  action?: boolean
}

interface Clause {
  mode: 'list' | 'logic'
  indent: number
  /** List mode: the break after the clause's leading words is still to come. */
  breakPending: boolean
  between: boolean
}

interface Condition {
  indent: number
  isIf: boolean
  start: number
  item?: RawItem
  word: string
}

interface Saved {
  stmt: Statement | null
  clause: Clause | null
  condition: Condition | null
}

interface RawItem {
  kind: OutlineKind
  label: string
  token: number
  depth: number
}

/**
 * Formats (when asked) and outlines `source`. Never throws: a failure returns the source as is.
 * `lowerKeywords`: write keywords in lower case rather than upper.
 */
export function layoutSql(source: string, kind: DbKind, format: boolean, lowerKeywords = false): Layout {
  const tokens = lex(source, kind)
  let result: { text: string; items: RawItem[]; lineOf: number[] }
  try {
    result = new Walker(tokens, kind, lowerKeywords).run()
  } catch (error) {
    return { text: source, outline: [], formatted: false, problem: format ? `Couldn't lay this out: ${(error as Error).message}` : undefined }
  }
  const originalLines = lineIndex(source)
  const original = (): Layout => ({
    text: source,
    outline: result.items.map((item) => ({ kind: item.kind, label: item.label, depth: item.depth, line: originalLines(tokens[item.token].start) })),
    formatted: false
  })
  if (!format) return original()
  if (!sameTokens(tokens, lex(result.text, kind))) {
    return { ...original(), problem: 'Formatting would have changed more than spacing, so it is shown as written.' }
  }
  return {
    text: result.text,
    outline: result.items.map((item) => ({ kind: item.kind, label: item.label, depth: item.depth, line: result.lineOf[item.token] + 1 })),
    formatted: true
  }
}

/** Same tokens in the same order; words may differ in case. */
function sameTokens(a: SqlToken[], b: SqlToken[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type) return false
    if (a[i].type === 'word' ? a[i].upper !== b[i].upper : a[i].text !== b[i].text) return false
  }
  return true
}

/** Maps a character offset to its 1-based line. */
function lineIndex(source: string): (offset: number) => number {
  const starts = [0]
  for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

const unquote = (t: SqlToken): string =>
  t.type === 'quoted' ? t.text.slice(1, -1) : t.text

class Walker {
  private lines: string[] = []
  private cur = ''
  private curIndent = 0
  private breakNext = false
  private lineOf: number[]
  private items: RawItem[] = []
  private frames: Frame[] = []
  private depth = 0
  private stmt: Statement | null = null
  private clause: Clause | null = null
  private condition: Condition | null = null
  /** MySQL IF / WHILE / ELSEIF waiting for THEN or DO. */
  private mysqlWait: { closer: string; indent: number; reuse: boolean } | null = null
  private justClosedIf: number | null = null
  private header: 'procedure' | 'function' | 'trigger' | null = null
  private cases: { end: number; indent: number; broken: boolean; depth: number }[] = []
  private readonly match = new Map<number, number>()
  private readonly caseEnd = new Map<number, number>()

  constructor(private readonly t: SqlToken[], private readonly kind: DbKind, private readonly lowerKeywords = false) {
    this.lineOf = new Array(t.length).fill(0)
    this.pair()
  }

  /** Matches parentheses, and each CASE with its END (BEGIN ... END blocks are told apart). */
  private pair(): void {
    const parens: number[] = []
    const ends: { kind: 'case' | 'block'; at: number }[] = []
    for (let i = 0; i < this.t.length; i++) {
      const tok = this.t[i]
      if (tok.type === 'punct') {
        if (tok.text === '(') parens.push(i)
        else if (tok.text === ')' && parens.length) this.match.set(parens.pop()!, i)
        continue
      }
      if (tok.type !== 'word' || this.afterDot(i)) continue
      if (tok.upper === 'CASE' && this.wordAt(i - 1) !== 'END') ends.push({ kind: 'case', at: i })
      else if (tok.upper === 'BEGIN' && !this.isTxBegin(i)) ends.push({ kind: 'block', at: i })
      else if (tok.upper === 'END') {
        const nextWord = this.wordAt(i + 1)
        // MySQL's END IF / END WHILE / END LOOP / END REPEAT close blocks that weren't pushed.
        if (nextWord && ['IF', 'WHILE', 'LOOP', 'REPEAT'].includes(nextWord)) continue
        const top = ends.pop()
        if (top?.kind === 'case') this.caseEnd.set(top.at, i)
      }
    }
  }

  run(): { text: string; items: RawItem[]; lineOf: number[] } {
    for (let i = 0; i < this.t.length; i++) i = this.step(i)
    if (this.cur.trim()) this.lines.push(this.cur)
    return { text: this.lines.join('\n'), items: this.items, lineOf: this.lineOf }
  }

  // ---- token helpers

  private wordAt(i: number): string | null {
    const tok = this.t[i]
    return tok && tok.type === 'word' ? tok.upper : null
  }

  private afterDot(i: number): boolean {
    const prev = this.t[i - 1]
    const next = this.t[i + 1]
    return (prev?.type === 'punct' && prev.text === '.' && !prev.space) || (next?.type === 'punct' && next.text === '.' && !next.space)
  }

  private isPunct(i: number, text: string): boolean {
    const tok = this.t[i]
    return !!tok && tok.type === 'punct' && tok.text === text
  }

  /** The previous token that isn't a comment. */
  private prevIndex(i: number): number {
    let j = i - 1
    while (j >= 0 && (this.t[j].type === 'line-comment' || this.t[j].type === 'block-comment')) j--
    return j
  }

  private nextIndex(i: number): number {
    let j = i + 1
    while (j < this.t.length && (this.t[j].type === 'line-comment' || this.t[j].type === 'block-comment')) j++
    return j
  }

  private prevWord(i: number): string | null {
    return this.wordAt(this.prevIndex(i))
  }

  private isTxBegin(i: number): boolean {
    const next = this.wordAt(this.nextIndex(i))
    return !!next && ['TRAN', 'TRANSACTION', 'DISTRIBUTED', 'DIALOG', 'CONVERSATION', 'WORK'].includes(next)
  }

  /** Length of tokens [from, to] on one line; Infinity if a line comment is in the way. */
  private flatLength(from: number, to: number, skipComments = false): number {
    let n = 0
    for (let k = from; k <= to && k < this.t.length; k++) {
      if (skipComments && (this.t[k].type === 'line-comment' || this.t[k].type === 'block-comment')) continue
      if (this.t[k].type === 'line-comment') return Infinity
      n += this.t[k].text.length + (k > from && this.t[k].space ? 1 : 0)
    }
    return n
  }

  /** Where the clause starting at `from` ends: the next clause or statement word at this depth. */
  private clauseEnd(from: number, logic: boolean): number {
    let d = 0
    for (let k = from + 1; k < this.t.length; k++) {
      const tok = this.t[k]
      if (tok.type === 'punct') {
        if (tok.text === '(') d++
        else if (tok.text === ')') { if (--d < 0) return k }
        else if (tok.text === ';' && d === 0) return k
        continue
      }
      if (tok.type !== 'word' || d > 0) continue
      if (tok.upper === 'CASE') {
        k = this.caseEnd.get(k) ?? k
        continue
      }
      const u = tok.upper
      if (STATEMENTS[this.kind].has(u) || JOIN_WORDS.has(u) || u === 'WHERE' || u === 'FROM' || u === 'GROUP' || u === 'ORDER' ||
        u === 'HAVING' || u === 'UNION' || u === 'INTO' || u === 'OPTION' || u === 'VALUES' || u === 'OUTPUT' || u === 'WHEN' || u === 'LIMIT') {
        if (!(logic && (u === 'AND' || u === 'OR'))) return k
      }
    }
    return this.t.length
  }

  // ---- emitting

  private indentOf(level: number): string {
    return '    '.repeat(Math.max(0, level))
  }

  private newline(indent: number, blank = false): void {
    if (this.cur.trim()) this.lines.push(this.cur)
    if (blank && this.lines.length && this.lines[this.lines.length - 1] !== '') this.lines.push('')
    this.cur = ''
    this.curIndent = indent
    this.breakNext = false
  }

  private base(): number {
    const top = this.frames[this.frames.length - 1]
    return top ? top.indent : 0
  }

  /** Indent for a line that continues a statement (after a comment, say). */
  private continuation(): number {
    return this.base() + (this.stmt || this.condition ? 1 : 0)
  }

  private outlineDepth(): number {
    return this.frames.filter((f) => f.type !== 'paren').length
  }

  private put(i: number): void {
    const tok = this.t[i]
    const glued = tok.type === 'punct' && (tok.text === ';' || tok.text === ',')
    if (this.breakNext && this.cur.trim() && !glued) this.newline(this.continuation())
    if (!glued) this.breakNext = false
    let text = tok.text
    if (tok.type === 'word' && KEYWORDS.has(tok.upper) && !this.afterDot(i)) text = this.lowerKeywords ? tok.upper.toLowerCase() : tok.upper
    this.lineOf[i] = this.lines.length
    if (!this.cur) this.cur = this.indentOf(this.curIndent) + text
    else this.cur += (tok.space ? ' ' : '') + text
    if (text.includes('\n')) {
      const parts = this.cur.split('\n')
      this.cur = parts.pop()!
      this.lines.push(...parts)
    }
    if (tok.type === 'line-comment') this.breakNext = true
  }

  private item(kind: OutlineKind, label: string, token: number, depth = this.outlineDepth()): RawItem {
    const it: RawItem = { kind, label, token, depth }
    this.items.push(it)
    return it
  }

  /** Tokens [from, to) as one line of text, for labels. */
  private flatText(from: number, to: number, max = 60): string {
    let s = ''
    for (let k = from; k < to && k < this.t.length; k++) {
      const tok = this.t[k]
      if (tok.type === 'line-comment' || tok.type === 'block-comment') continue
      const text = tok.type === 'word' && KEYWORDS.has(tok.upper) && !this.afterDot(k) ? tok.upper : tok.text.replace(/\s+/g, ' ')
      s += (s && tok.space ? ' ' : '') + text
      if (s.length > max) return `${s.slice(0, max - 1)}…`
    }
    return s
  }

  /** A dotted name starting at `i`, without brackets or quotes, and the index after it. */
  private chain(i: number): { text: string; next: number } | null {
    const first = this.t[i]
    if (!first || !(first.type === 'word' || first.type === 'quoted' || first.type === 'variable')) return null
    const parts = [unquote(first)]
    let k = i + 1
    while (this.isPunct(k, '.')) {
      const part = this.t[k + 1]
      if (part && (part.type === 'word' || part.type === 'quoted')) {
        parts.push(unquote(part))
        k += 2
      } else if (this.isPunct(k + 1, '.')) {
        parts.push('')
        k += 1
      } else break
    }
    return { text: parts.filter(Boolean).join('.'), next: k }
  }

  /** The table a write statement targets, skipping INTO / FROM / TOP (n) and the like. */
  private target(i: number): string | null {
    let k = this.nextIndex(i)
    for (let guard = 0; guard < 8 && k < this.t.length; guard++) {
      const w = this.wordAt(k)
      if (w && ['INTO', 'FROM', 'TABLE', 'IGNORE', 'LOW_PRIORITY', 'QUICK', 'DELAYED', 'HIGH_PRIORITY', 'PERCENT', 'ONLY'].includes(w)) { k = this.nextIndex(k); continue }
      if (w === 'TOP') {
        k = this.nextIndex(k)
        if (this.isPunct(k, '(')) k = this.nextIndex(this.match.get(k) ?? k)
        else k = this.nextIndex(k)
        continue
      }
      break
    }
    const name = this.chain(k)
    if (!name) return null
    // UPDATE o SET ... FROM dbo.Orders o: name the table, not the alias.
    if (!name.text.includes('.')) {
      const alias = name.text.toLowerCase()
      let d = 0
      for (let j = name.next; j < Math.min(this.t.length, name.next + 400); j++) {
        const tok = this.t[j]
        if (tok.type === 'punct') {
          if (tok.text === '(') d++
          else if (tok.text === ')') d--
          else if (tok.text === ';' && d <= 0) break
          continue
        }
        if (d !== 0 || tok.type !== 'word' || (tok.upper !== 'FROM' && tok.upper !== 'JOIN')) continue
        const table = this.chain(this.nextIndex(j))
        if (!table) continue
        let a = this.nextIndex(table.next - 1)
        if (this.wordAt(a) === 'AS') a = this.nextIndex(a)
        const aliasTok = this.t[a]
        if (aliasTok && (aliasTok.type === 'word' || aliasTok.type === 'quoted') && unquote(aliasTok).toLowerCase() === alias) return table.text
      }
    }
    return name.text
  }

  /** The first table after FROM in the statement starting at `i`, for SELECT labels. */
  private firstFrom(i: number): string | null {
    let d = 0
    for (let j = i + 1; j < Math.min(this.t.length, i + 300); j++) {
      const tok = this.t[j]
      if (tok.type === 'punct') {
        if (tok.text === '(') d++
        else if (tok.text === ')') { if (--d < 0) return null }
        else if (tok.text === ';' && d === 0) return null
        continue
      }
      if (tok.type !== 'word' || d !== 0) continue
      if (tok.upper === 'FROM') return this.chain(this.nextIndex(j))?.text ?? null
      if (STATEMENTS[this.kind].has(tok.upper) && tok.upper !== 'SELECT' && j > i + 1) return null
    }
    return null
  }

  /** Whether the SELECT at `i` has an INTO at its own level before FROM (SELECT ... INTO #t). */
  private selectInto(i: number): string | null {
    let d = 0
    for (let j = i + 1; j < Math.min(this.t.length, i + 400); j++) {
      const tok = this.t[j]
      if (tok.type === 'punct') {
        if (tok.text === '(') d++
        else if (tok.text === ')') { if (--d < 0) return null }
        else if (tok.text === ';' && d === 0) return null
        continue
      }
      if (tok.type !== 'word' || d !== 0) continue
      if (tok.upper === 'INTO') return this.chain(this.nextIndex(j))?.text ?? null
      if (tok.upper === 'FROM' || tok.upper === 'WHERE' || (STATEMENTS[this.kind].has(tok.upper) && j > i + 1)) return null
    }
    return null
  }

  // ---- classification

  /** Whether the word at `i` starts a new statement (rather than being part of one). */
  private startsStatement(i: number): boolean {
    const u = this.t[i].upper
    if (!STATEMENTS[this.kind].has(u) || this.afterDot(i)) return false
    const prev = this.prevWord(i)
    const prevTok = this.t[this.prevIndex(i)]
    const nextIsParen = this.isPunct(i + 1, '(')
    // UPDATE(col) in a trigger, INSERT() / REPLACE() / IF() / REPEAT() as MySQL functions.
    if (nextIsParen && ['INSERT', 'UPDATE', 'REPLACE', 'REPEAT', 'LEFT', 'RIGHT'].includes(u)) return false
    if (nextIsParen && u === 'IF' && this.kind === 'mysql' && (this.stmt || this.condition)) return false
    if (['INSERT', 'UPDATE', 'DELETE', 'SELECT', 'REPLACE'].includes(u)) {
      if (prevTok?.type === 'punct' && prevTok.text === ',' && this.header) return false
      if (prev && ['ON', 'FOR', 'AFTER', 'BEFORE', 'OF', 'GRANT', 'DENY', 'REVOKE', 'INSTEAD'].includes(prev)) return false
      if (prevTok?.type === 'punct' && prevTok.text === ',' && prev === null && this.stmt?.verb === 'GRANT') return false
    }
    if (u === 'MERGE' && this.wordAt(this.nextIndex(i)) === 'JOIN') return false
    if (u === 'IF' && prev && ['TABLE', 'VIEW', 'PROCEDURE', 'PROC', 'FUNCTION', 'TRIGGER', 'INDEX', 'SCHEMA', 'DATABASE', 'TYPE', 'SEQUENCE', 'EXISTS'].includes(prev)) return false
    if (u === 'SET' && prev === 'CHARACTER') return false
    if (u === 'FETCH' && prev && ['ROWS', 'ROW'].includes(prev)) return false
    if ((u === 'CONTINUE' || u === 'EXIT') && prev === 'DECLARE') return false
    if (u === 'SAVE' && !['TRAN', 'TRANSACTION'].includes(this.wordAt(this.nextIndex(i)) ?? '')) return false
    if (u === 'START' && this.wordAt(this.nextIndex(i)) !== 'TRANSACTION') return false
    if (u === 'WITH') return this.isCte(i)
    if (u === 'EXECUTE' && this.wordAt(this.nextIndex(i)) === 'AS' && this.header) return false
    if (u !== 'BEGIN' && this.stmt?.verb === 'DECLARE' && this.t.slice(this.stmt.start, i).some((x) => x.type === 'word' && x.upper === 'HANDLER')) return false
    return true
  }

  /** WITH name AS ( or WITH name (cols) AS (: a common table expression, not a hint or option. */
  private isCte(i: number): boolean {
    let k = this.nextIndex(i)
    const name = this.t[k]
    if (!name || !(name.type === 'word' || name.type === 'quoted')) return false
    k = this.nextIndex(k)
    if (this.isPunct(k, '(')) k = this.nextIndex(this.match.get(k) ?? k)
    return this.wordAt(k) === 'AS' && this.isPunct(this.nextIndex(k), '(')
  }

  /** A statement word that continues the open statement: INSERT ... SELECT, WITH ... SELECT, UNION SELECT. */
  private continues(i: number): boolean {
    const s = this.stmt
    if (!s) return false
    const u = this.t[i].upper
    const prev = this.prevWord(i)
    switch (s.verb) {
      case 'WITH':
        return ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(u)
      case 'INSERT':
      case 'REPLACE':
        if (u === 'SELECT' && !s.hasSelect) return true
        if ((u === 'EXEC' || u === 'EXECUTE') && !s.hasSelect) return true
        if (u === 'UPDATE' && prev === 'KEY') return true
        return u === 'WITH' && !s.hasSelect
      case 'SELECT':
        return u === 'SELECT' && !!prev && ['UNION', 'ALL', 'EXCEPT', 'INTERSECT', 'DISTINCT'].includes(prev)
      case 'DECLARE':
        return u === 'SELECT' && prev === 'FOR'
      case 'CREATE':
        return u === 'SELECT' && prev === 'AS'
      case 'MERGE':
        return (['UPDATE', 'INSERT', 'DELETE'].includes(u) && prev === 'THEN') || u === 'SET'
      case 'UPDATE':
        return u === 'SET'
      default:
        return false
    }
  }

  /** A clause word (FROM, WHERE, JOIN ...) of the open statement. */
  private isClause(i: number): boolean {
    const s = this.stmt
    if (!s) return false
    const u = this.t[i].upper
    const prev = this.prevWord(i)
    if (JOIN_TAKERS.has(s.verb) && JOIN_WORDS.has(u)) {
      if (this.isPunct(i + 1, '(')) return false
      if (u === 'JOIN' && prev && JOIN_WORDS.has(prev)) return false
      if (u === 'JOIN' && prev && ['HASH', 'LOOP', 'MERGE', 'REMOTE'].includes(prev)) return false
      if (u === 'OUTER' && prev && ['LEFT', 'RIGHT', 'FULL'].includes(prev)) return false
      if ((u === 'LEFT' || u === 'RIGHT' || u === 'FULL' || u === 'INNER' || u === 'CROSS' || u === 'NATURAL') && !this.leadsToJoin(i)) return false
      return true
    }
    const set = CLAUSES[s.verb]
    if (!set?.has(u)) return false
    if (u === 'FROM' && s.verb === 'DELETE' && !this.deleteHasTarget(i)) return false
    if (u === 'GROUP' && prev === 'WITHIN') return false
    if (u === 'ON' && this.wordAt(this.nextIndex(i)) !== 'DUPLICATE') return false
    if (u === 'FOR' && s.verb === 'SELECT' && !['XML', 'JSON', 'UPDATE', 'BROWSE', 'SHARE'].includes(this.wordAt(this.nextIndex(i)) ?? '')) return false
    if (u === 'INTO' && s.verb === 'SELECT' && prev === 'INSERT') return false
    return true
  }

  private leadsToJoin(i: number): boolean {
    let k = this.nextIndex(i)
    for (let guard = 0; guard < 3; guard++) {
      const w = this.wordAt(k)
      if (w === 'JOIN' || w === 'APPLY') return true
      if (!w || !['OUTER', 'HASH', 'LOOP', 'MERGE', 'REMOTE'].includes(w)) return false
      k = this.nextIndex(k)
    }
    return false
  }

  /** DELETE x FROM ... names its target before FROM; DELETE FROM x doesn't. */
  private deleteHasTarget(i: number): boolean {
    for (let k = this.stmt!.start + 1; k < i; k++) {
      const tok = this.t[k]
      if ((tok.type === 'word' && !['TOP', 'PERCENT'].includes(tok.upper)) || tok.type === 'quoted') return true
    }
    return false
  }

  // ---- the walk

  private step(i: number): number {
    const tok = this.t[i]

    if (tok.type === 'line-comment' || tok.type === 'block-comment') {
      this.comment(i)
      return i
    }

    if (this.clause?.breakPending && !this.isListLead(i)) {
      this.newline(this.clause.indent)
      this.clause.breakPending = false
    }

    if (tok.type === 'punct') return this.punct(i)

    if (this.header) {
      const handled = this.headerStep(i)
      if (handled !== null) return handled
    }

    if (tok.type === 'variable') {
      this.put(i)
      return i
    }
    if (tok.type !== 'word' || this.afterDot(i)) {
      this.put(i)
      return i
    }
    return this.word(i)
  }

  private comment(i: number): void {
    const tok = this.t[i]
    const ownLine = tok.nl > 0 || i === 0
    if (ownLine) {
      const next = this.nextIndex(i)
      const nextStarts = next < this.t.length && this.t[next].type === 'word' && this.startsStatementLoosely(next)
      const indent = nextStarts || !this.stmt ? this.commentIndent(next) : this.continuation()
      this.newline(indent, tok.nl > 1)
      if (nextStarts || !this.stmt) this.heading(i)
    }
    this.put(i)
    if (ownLine && tok.type === 'block-comment') this.breakNext = true
  }

  /** Statement words, for placing comments before them (without the full checks). */
  private startsStatementLoosely(i: number): boolean {
    const u = this.t[i].upper
    return STATEMENTS[this.kind].has(u) && !this.continues(i)
  }

  /** Where a comment sits before a statement: END and ELSE come out a level. */
  private commentIndent(next: number): number {
    const u = this.wordAt(next)
    const top = this.frames[this.frames.length - 1]
    if ((u === 'END' || u === 'ELSE' || u === 'ELSEIF' || u === 'UNTIL') && top) return top.open
    if (this.condition) return this.condition.indent + 1
    // A single-statement IF body is over once another statement starts.
    for (let f = this.frames.length - 1; f >= 0; f--) if (this.frames[f].type !== 'body') return this.frames[f].indent
    return 0
  }

  /** An own-line comment introducing code becomes an outline heading, unless it's commented-out code. */
  private heading(i: number): void {
    const tok = this.t[i]
    const raw = tok.type === 'line-comment'
      ? tok.text.replace(/^(--|#)/, '')
      : tok.text.replace(/^\/\*+/, '').replace(/\*+\/$/, '').split('\n').map((l) => l.trim()).find((l) => /[A-Za-z0-9]/.test(l.replace(/^[*=\-#~+ ]+/, ''))) ?? ''
    const text = raw.replace(/^[\s*=\-#~+]+|[\s*=\-#~+]+$/g, '').trim()
    if (!text || !/[A-Za-z]/.test(text)) return
    if (/^(SELECT|INSERT|UPDATE|DELETE|EXEC|SET|DECLARE|IF|BEGIN|END|FROM|WHERE|AND|OR|PRINT|RETURN|DROP|CREATE|ALTER|TRUNCATE|MERGE)\b/i.test(text)) return
    // Like the indent: a finished single-statement IF body doesn't count.
    let end = this.frames.length
    if (!this.condition) while (end > 0 && this.frames[end - 1].type === 'body') end--
    const depth = this.frames.slice(0, end).filter((f) => f.type !== 'paren').length
    this.item('comment', text.length > 60 ? `${text.slice(0, 59)}…` : text, i, depth)
  }

  private isListLead(i: number): boolean {
    const tok = this.t[i]
    const prev = this.prevWord(i)
    if (tok.type === 'word' && ['DISTINCT', 'ALL', 'TOP', 'PERCENT', 'WITH', 'TIES', 'BY', 'DISTINCTROW', 'SQL_CALC_FOUND_ROWS'].includes(tok.upper)) return true
    if ((tok.type === 'number' || this.isPunct(i, '(')) && prev === 'TOP') return true
    return false
  }

  private punct(i: number): number {
    const text = this.t[i].text
    if (text === '(') return this.open(i)
    if (text === ')') {
      this.close(i)
      return i
    }
    if (text === ';') {
      const next = this.nextIndex(i)
      if (this.wordAt(next) === 'WITH' && !this.t[next].space && this.isCte(next)) {
        this.newline(this.commentIndent(next))
        this.put(i)
        this.stmt = null
        this.clause = null
        return i
      }
      this.put(i)
      this.stmt = null
      this.clause = null
      this.breakNext = true
      return i
    }
    if (text === ',') {
      this.put(i)
      const top = this.frames[this.frames.length - 1]
      if (top?.type === 'paren' && top.list && this.depth === top.depth) this.newline(top.indent)
      else if (this.clause?.mode === 'list' && !this.cases.length) this.newline(this.clause.indent)
      else if (this.header === 'procedure' && this.depth === 0) this.breakNext = true
      return i
    }
    this.put(i)
    return i
  }

  private open(i: number): number {
    const end = this.match.get(i)
    if (end === undefined) {
      this.put(i)
      this.depth++
      return i
    }
    const next = this.nextIndex(i)
    const subquery = this.wordAt(next) === 'SELECT' || (this.wordAt(next) === 'WITH' && this.isCte(next))
    const prev = this.prevWord(i)
    const prevTok = this.t[this.prevIndex(i)]
    const listable = (this.header && this.depth === 0) || prev === 'TABLE' ||
      (this.stmt?.verb === 'CREATE' && this.depth === 0 && !!prevTok && (prevTok.type === 'word' || prevTok.type === 'quoted')) ||
      ((this.stmt?.verb === 'INSERT' || this.stmt?.verb === 'REPLACE') && !this.stmt.hasSelect && !!prevTok && (prevTok.type === 'word' || prevTok.type === 'quoted') && prev !== 'VALUES')
    const length = this.flatLength(i, end)
    if ((subquery && length > SUBQUERY_WIDTH) || (listable && !subquery && length > LIST_WIDTH + 10)) {
      this.put(i)
      this.depth++
      const indent = this.curIndent + 1
      this.frames.push({ type: 'paren', indent, open: this.curIndent, depth: this.depth, list: !subquery, saved: { stmt: this.stmt, clause: this.clause, condition: this.condition } })
      this.stmt = null
      this.clause = null
      this.condition = null
      this.newline(indent)
      return i
    }
    // Everything else stays on one line: function calls, IN lists, short subqueries.
    for (let k = i; k <= end; k++) {
      const tok = this.t[k]
      if (tok.type === 'line-comment' || tok.type === 'block-comment') {
        if (tok.nl > 0 && this.cur.trim()) this.newline(this.continuation() + 1)
      }
      this.put(k)
    }
    return end
  }

  private close(i: number): void {
    const at = this.frames.map((f) => f.type).lastIndexOf('paren')
    if (at < 0) {
      this.put(i)
      this.depth = Math.max(0, this.depth - 1)
      return
    }
    const frame = this.frames[at] as Extract<Frame, { type: 'paren' }>
    this.frames.length = at
    this.stmt = frame.saved.stmt
    this.clause = frame.saved.clause
    this.condition = frame.saved.condition
    this.depth--
    this.newline(frame.open)
    this.put(i)
  }

  /** CREATE PROCEDURE / FUNCTION / TRIGGER header, up to AS (SQL Server) or the body (MySQL). */
  private headerStep(i: number): number | null {
    const tok = this.t[i]
    const u = tok.type === 'word' ? tok.upper : ''
    if (this.kind === 'mssql') {
      if (tok.type === 'variable' && this.depth === 0 && this.header === 'procedure') {
        const prev = this.t[this.prevIndex(i)]
        if (prev && !(prev.type === 'punct' && prev.text === '=')) {
          this.newline(1)
          this.put(i)
          return i
        }
      }
      if (u === 'AS' && this.depth === 0) {
        const next = this.nextIndex(i)
        const nextWord = this.wordAt(next)
        if (nextWord && BODY_STARTERS.includes(nextWord)) {
          this.newline(0)
          this.put(i)
          this.header = null
          this.breakNext = true
          return i
        }
      }
      if (this.depth === 0 && (u === 'RETURNS' || (u === 'WITH' && this.prevWord(i) !== 'OF') ||
        (this.header === 'trigger' && (u === 'ON' || u === 'AFTER' || (u === 'FOR' && this.prevWord(i) !== 'NOT') || u === 'INSTEAD')))) {
        this.newline(0)
        this.put(i)
        return i
      }
      this.put(i)
      return i
    }
    // MySQL: a trigger's header ends at FOR EACH ROW; a routine's at the first statement word.
    if (this.header === 'trigger') {
      if (u === 'BEFORE' || u === 'AFTER' || (u === 'FOR' && this.wordAt(this.nextIndex(i)) === 'EACH')) this.newline(0)
      this.put(i)
      if (u === 'ROW' && this.prevWord(i) === 'EACH') {
        this.header = null
        this.breakNext = true
      }
      return i
    }
    if (u && STATEMENTS.mysql.has(u) && this.depth === 0 && u !== 'SET') {
      this.header = null
      return null
    }
    this.put(i)
    return i
  }

  private word(i: number): number {
    const tok = this.t[i]
    const u = tok.upper

    // CASE ... END expressions, broken over lines when long.
    if (u === 'CASE' && this.caseEnd.has(i) && !(this.kind === 'mysql' && !this.stmt && !this.condition)) {
      const end = this.caseEnd.get(i)!
      const broken = this.flatLength(i, end) > 60
      this.put(i)
      this.cases.push({ end, indent: this.curIndent, broken, depth: this.depth })
      return i
    }
    const kase = this.cases[this.cases.length - 1]
    if (kase && this.depth === kase.depth) {
      if (u === 'END' && i === kase.end) {
        this.cases.pop()
        if (kase.broken) this.newline(kase.indent)
        this.put(i)
        return i
      }
      if ((u === 'WHEN' || u === 'ELSE') && kase.broken) {
        this.newline(kase.indent + 1)
        this.put(i)
        return i
      }
      if (u === 'WHEN' || u === 'THEN' || u === 'ELSE' || u === 'END') {
        this.put(i)
        return i
      }
    }
    if (this.cases.length) {
      this.put(i)
      return i
    }

    // MySQL IF ... THEN / WHILE ... DO.
    if (this.mysqlWait && ((u === 'THEN' && this.mysqlWait.closer !== 'WHILE') || (u === 'DO' && this.mysqlWait.closer === 'WHILE'))) {
      const wait = this.mysqlWait
      this.mysqlWait = null
      this.condition = null
      this.clause = null
      this.put(i)
      if (!wait.reuse) this.frames.push({ type: 'block', indent: wait.indent + 1, open: wait.indent, closer: wait.closer, isIf: wait.closer === 'IF', mysqlIf: true })
      this.breakNext = true
      return i
    }

    // Logic mode: long conditions break before AND / OR.
    if (this.clause?.mode === 'logic') {
      if (u === 'BETWEEN') this.clause.between = true
      else if (u === 'AND' && this.clause.between) this.clause.between = false
      else if (u === 'AND' || u === 'OR') {
        this.newline(this.clause.indent)
        this.put(i)
        return i
      }
    }

    // A T-SQL IF / WHILE condition runs until the statement that is its body.
    if (this.condition && !this.startsStatement(i)) {
      this.put(i)
      return i
    }

    if (this.stmt && (this.continues(i) || this.isClause(i))) {
      this.clauseWord(i)
      return i
    }

    if (!this.startsStatement(i)) {
      this.put(i)
      return i
    }

    return this.statement(i)
  }

  private clauseWord(i: number): void {
    const s = this.stmt!
    const u = this.t[i].upper
    if (s.verb === 'MERGE') {
      if (u === 'WHEN') s.action = false
      else if (['UPDATE', 'INSERT', 'DELETE'].includes(u)) s.action = true
    }
    const indent = s.indent + (s.verb === 'MERGE' && s.action ? 1 : 0)
    if ((u === 'UPDATE' && this.prevWord(i) === 'KEY') || (u === 'SET' && s.verb === 'MERGE' && this.prevWord(i) === 'UPDATE')) {
      this.put(i)
      this.startClause(i, 'SET', indent)
      return
    }
    if (this.continues(i)) {
      if (s.verb === 'WITH') {
        this.recordStatement(i, u)
        s.verb = u
      } else if ((s.verb === 'INSERT' || s.verb === 'REPLACE') && u !== 'UPDATE') {
        s.hasSelect = true
        if (u === 'SELECT') s.verb = 'SELECT'
      } else if (s.verb === 'DECLARE' || s.verb === 'CREATE') {
        s.verb = 'SELECT'
      }
    }
    this.newline(indent)
    this.put(i)
    this.clause = null
    this.startClause(i, u, indent)
  }

  /** Long SELECT / SET / GROUP BY lists go one item per line; long WHERE / ON conditions break at AND / OR. */
  private startClause(i: number, u: string, indent: number): void {
    const list = ['SELECT', 'SET', 'GROUP', 'ORDER', 'DECLARE'].includes(u)
    const logic = ['WHERE', 'HAVING', 'IF', 'WHILE', 'ELSEIF', 'UNTIL'].includes(u) || JOIN_WORDS.has(u) || u === 'USING' || u === 'WHEN'
    if (!list && !logic) return
    const end = this.clauseEnd(i, logic)
    const length = this.flatLength(i, end - 1, true)
    if (length <= LIST_WIDTH) return
    if (list && u === 'DECLARE' && this.wordAt(this.nextIndex(i)) !== null && this.t[this.nextIndex(i)].type !== 'variable') return
    this.clause = list
      ? { mode: 'list', indent: indent + 1, breakPending: true, between: false }
      : { mode: 'logic', indent: indent + 1, breakPending: false, between: false }
  }

  private statement(i: number): number {
    const tok = this.t[i]
    const u = tok.upper
    const blank = tok.nl >= 2

    // The body of a T-SQL IF / ELSE / WHILE begins.
    let bodyOf: Condition | null = null
    if (this.condition && this.kind === 'mssql') {
      bodyOf = this.condition
      this.condition = null
      this.clause = null
      if (bodyOf.item && bodyOf.word !== 'ELSE') {
        bodyOf.item.label = `${bodyOf.word} ${this.flatText(bodyOf.start, i)}`.trim()
      }
    }

    if (u === 'END') return this.end(i)
    if (u === 'ELSE' && this.kind === 'mssql') return this.tsqlElse(i)
    if ((u === 'ELSE' || u === 'ELSEIF' || u === 'UNTIL') && this.kind === 'mysql') return this.mysqlElse(i)

    if (bodyOf) {
      if (u === 'BEGIN' && !this.isTxBegin(i)) {
        return this.begin(i, bodyOf.indent, bodyOf.isIf)
      }
      this.frames.push({ type: 'body', indent: bodyOf.indent + 1, open: bodyOf.indent, isIf: bodyOf.isIf })
    } else {
      this.popBodies()
    }
    this.justClosedIf = null

    // A MySQL label (name: BEGIN) keeps its word on the same line.
    const labelled = (this.isPunct(i - 1, ':') && !this.t[i].nl) || (this.isPunct(i - 1, ';') && !this.t[i].space && u === 'WITH')
    if (!labelled) this.newline(this.base(), blank && !bodyOf)

    if (u === 'BEGIN' && !this.isTxBegin(i)) return this.begin(i, this.base(), false)

    this.stmt = { verb: u, indent: this.base(), start: i }
    this.clause = null
    this.put(i)
    this.recordStatement(i, u)

    if ((u === 'CREATE' || u === 'ALTER') && !this.frames.length) {
      for (let k = i + 1; k < Math.min(this.t.length, i + 14); k++) {
        const w = this.wordAt(k)
        if (w === 'PROCEDURE' || w === 'PROC') { this.header = 'procedure'; break }
        if (w === 'FUNCTION') { this.header = 'function'; break }
        if (w === 'TRIGGER') { this.header = 'trigger'; break }
        if (w === 'TABLE' || w === 'VIEW' || w === 'INDEX' || this.isPunct(k, '(')) break
      }
      if (this.header) this.stmt = null
    }

    if (u === 'IF' || u === 'WHILE') {
      if (this.kind === 'mssql') {
        const item = this.items[this.items.length - 1]
        this.condition = { indent: this.base(), isIf: u === 'IF', start: i + 1, item, word: u }
        this.stmt = null
        this.startClause(i, u, this.base())
      } else {
        this.mysqlWait = { closer: u, indent: this.base(), reuse: false }
        this.stmt = null
        this.condition = { indent: this.base(), isIf: u === 'IF', start: i + 1, word: u }
        this.startClause(i, u, this.base())
        const item = this.items[this.items.length - 1]
        this.fillMysqlLabel(item, i, u)
      }
    } else if (u === 'LOOP' || u === 'REPEAT') {
      this.frames.push({ type: 'block', indent: this.base() + 1, open: this.base(), closer: u, isIf: false, mysqlIf: true })
      this.stmt = null
      this.breakNext = true
    } else if (u === 'SELECT' || u === 'SET' || u === 'DECLARE' || u === 'UPDATE') {
      if (u !== 'UPDATE') this.startClause(i, u, this.base())
    }
    return i
  }

  /** Labels a MySQL IF / WHILE with its condition (up to THEN / DO). */
  private fillMysqlLabel(item: RawItem | undefined, i: number, u: string): void {
    if (!item) return
    const stop = u === 'WHILE' ? 'DO' : 'THEN'
    let k = i + 1
    let d = 0
    while (k < this.t.length) {
      const tok = this.t[k]
      if (tok.type === 'punct') {
        if (tok.text === '(') d++
        else if (tok.text === ')') d--
      } else if (d === 0 && tok.type === 'word' && tok.upper === stop) break
      k++
    }
    item.label = `${u} ${this.flatText(i + 1, k)}`.trim()
  }

  private popBodies(): void {
    while (this.frames.length && this.frames[this.frames.length - 1].type === 'body') {
      const frame = this.frames.pop()!
      if (frame.type === 'body' && frame.isIf) this.justClosedIf = frame.open
    }
  }

  private begin(i: number, open: number, isIf: boolean): number {
    const next = this.nextIndex(i)
    const kind = this.wordAt(next)
    const closer = kind === 'TRY' || kind === 'CATCH' ? kind : null
    this.newline(open)
    this.put(i)
    if (closer) {
      this.put(next)
      this.item('control', closer === 'TRY' ? 'TRY' : 'CATCH', i)
    }
    this.frames.push({ type: 'block', indent: open + 1, open, closer, isIf })
    this.stmt = null
    this.clause = null
    this.breakNext = true
    return closer ? next : i
  }

  private end(i: number): number {
    this.popBodies()
    const next = this.nextIndex(i)
    const suffix = this.wordAt(next)
    let at = -1
    for (let f = this.frames.length - 1; f >= 0; f--) {
      if (this.frames[f].type === 'block') { at = f; break }
      if (this.frames[f].type === 'paren') break
    }
    const frame = at >= 0 ? this.frames[at] as Extract<Frame, { type: 'block' }> : null
    if (frame) this.frames.length = at
    this.newline(frame ? frame.open : this.base())
    this.put(i)
    let last = i
    if (suffix && (suffix === frame?.closer || ['TRY', 'CATCH', 'IF', 'WHILE', 'LOOP', 'REPEAT', 'CASE'].includes(suffix)) && !this.t[next].nl) {
      this.put(next)
      last = next
    }
    this.stmt = null
    this.clause = null
    this.justClosedIf = frame?.isIf && !frame.mysqlIf ? frame.open : null
    // After END, T-SQL IF bodies that the block was the whole of are complete too.
    this.breakNext = true
    return last
  }

  private tsqlElse(i: number): number {
    let indent: number
    if (this.justClosedIf !== null) {
      indent = this.justClosedIf
    } else {
      const top = this.frames[this.frames.length - 1]
      if (top?.type === 'body') {
        this.frames.pop()
        indent = top.open
      } else {
        indent = this.base()
      }
    }
    this.justClosedIf = null
    this.newline(indent)
    this.put(i)
    this.stmt = null
    this.clause = null
    const next = this.nextIndex(i)
    if (this.wordAt(next) === 'IF') {
      this.put(next)
      const item = this.item('control', 'ELSE IF', i)
      this.condition = { indent, isIf: true, start: next + 1, item, word: 'ELSE IF' }
      this.startClause(next, 'IF', indent)
      return next
    }
    const item = this.item('control', 'ELSE', i)
    this.condition = { indent, isIf: true, start: i + 1, item, word: 'ELSE' }
    return i
  }

  private mysqlElse(i: number): number {
    const u = this.t[i].upper
    this.popBodies()
    const top = this.frames[this.frames.length - 1]
    const open = top?.type === 'block' ? top.open : this.base()
    this.newline(open)
    this.put(i)
    this.stmt = null
    this.clause = null
    if (u === 'ELSEIF') {
      const item = this.item('control', 'ELSEIF', i, Math.max(0, this.outlineDepth() - 1))
      this.fillMysqlLabel(item, i, 'IF')
      this.mysqlWait = { closer: 'IF', indent: open, reuse: true }
      this.condition = { indent: open, isIf: true, start: i + 1, word: 'ELSEIF' }
      this.startClause(i, 'ELSEIF', open)
      item.label = item.label.replace(/^IF/, 'ELSEIF')
    } else if (u === 'ELSE') {
      this.item('control', 'ELSE', i, Math.max(0, this.outlineDepth() - 1))
      this.breakNext = true
    } else {
      this.item('control', `UNTIL ${this.flatText(i + 1, this.clauseEnd(i, true))}`, i, Math.max(0, this.outlineDepth() - 1))
    }
    return i
  }

  /** Adds the outline entry for a statement starting at `i`. */
  private recordStatement(i: number, u: string): void {
    if (this.frames.some((f) => f.type === 'paren')) return
    const next = this.nextIndex(i)
    const nextWord = this.wordAt(next)
    switch (u) {
      case 'IF':
      case 'WHILE':
        this.item('control', u, i)
        return
      case 'LOOP':
      case 'REPEAT':
        this.item('control', u, i)
        return
      case 'SELECT': {
        const into = this.selectInto(i)
        if (into) {
          this.item(into.startsWith('#') ? 'temp' : 'write', `SELECT INTO ${into}`, i)
          return
        }
        const from = this.firstFrom(i)
        this.item('read', from ? `SELECT from ${from}` : `SELECT ${this.flatText(next, this.clauseEnd(i, false), 40)}`, i)
        return
      }
      case 'INSERT':
      case 'UPDATE':
      case 'DELETE':
      case 'MERGE':
      case 'REPLACE':
      case 'TRUNCATE': {
        const target = this.target(i)
        this.item(target?.startsWith('#') || target?.startsWith('@') ? 'temp' : 'write', `${u}${target ? ` ${target}` : ''}`, i)
        return
      }
      case 'EXEC':
      case 'EXECUTE':
      case 'CALL': {
        if (nextWord === 'AS') {
          this.item('call', `${u} AS ${this.flatText(this.nextIndex(next), this.clauseEnd(next, false), 30)}`, i)
          return
        }
        let k = next
        if (this.t[k]?.type === 'variable' && this.isPunct(this.nextIndex(k), '=')) k = this.nextIndex(this.nextIndex(k))
        if (this.isPunct(k, '(') || this.t[k]?.type === 'variable' || this.t[k]?.type === 'string') {
          this.item('call', `${u} dynamic SQL`, i)
          return
        }
        const name = this.chain(k)?.text
        this.item('call', name && /sp_executesql$/i.test(name) ? `${u} dynamic SQL` : `${u} ${name ?? ''}`.trim(), i)
        return
      }
      case 'DECLARE': {
        const name = this.t[next]
        const after = this.wordAt(this.nextIndex(next))
        if (after === 'CURSOR' || (after === 'SCROLL' || after === 'INSENSITIVE')) this.item('cursor', `CURSOR ${name ? unquote(name) : ''}`.trim(), i)
        else if (after === 'TABLE' && name?.type === 'variable') this.item('temp', `DECLARE ${name.text} TABLE`, i)
        // A handler is control flow (what happens on NOT FOUND or an error), not an error being raised.
        else if (this.kind === 'mysql' && (nextWord === 'CONTINUE' || nextWord === 'EXIT')) this.item('control', this.flatText(next, this.clauseEnd(i, false), 50), i)
        return
      }
      case 'CREATE':
      case 'DROP':
      case 'ALTER': {
        if (nextWord !== 'TABLE' || this.header) return
        const name = this.chain(this.nextIndex(next))?.text ?? ''
        const temp = name.startsWith('#') || this.wordAt(this.nextIndex(next)) === 'TEMPORARY'
        this.item(temp ? 'temp' : 'write', `${u} TABLE ${name}`.trim(), i)
        return
      }
      case 'BEGIN':
        if (this.isTxBegin(i)) this.item('tx', 'BEGIN TRANSACTION', i)
        return
      case 'START':
        this.item('tx', 'START TRANSACTION', i)
        return
      case 'COMMIT':
        this.item('tx', 'COMMIT', i)
        return
      case 'ROLLBACK':
        this.item('tx', 'ROLLBACK', i)
        return
      case 'SAVE':
        this.item('tx', `SAVE ${this.flatText(next, this.clauseEnd(i, false), 30)}`, i)
        return
      case 'RAISERROR':
      case 'THROW':
      case 'SIGNAL':
      case 'RESIGNAL': {
        const message = this.t.slice(i + 1, Math.min(this.t.length, i + 8)).find((x) => x.type === 'string')
        this.item('error', message ? `${u} ${message.text.length > 40 ? `${message.text.slice(0, 39)}…'` : message.text}` : u, i)
        return
      }
      case 'RETURN': {
        const rest = this.flatText(next, this.clauseEnd(i, false), 30)
        this.item('return', `RETURN${rest && !/^(END|ELSE)\b/.test(rest) ? ` ${rest}` : ''}`, i)
        return
      }
      case 'LEAVE':
      case 'ITERATE':
      case 'BREAK':
      case 'CONTINUE':
      case 'GOTO':
        this.item('return', `${u}${this.t[next] && this.t[next].type === 'word' && !STATEMENTS[this.kind].has(this.t[next].upper) ? ` ${this.t[next].text}` : ''}`, i)
        return
    }
  }
}
