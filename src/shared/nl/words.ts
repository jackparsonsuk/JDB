/** Splits identifiers like `InvoiceStatusId`, `created_on` or `VATRates` into lowercase words. */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

/**
 * Crude singularising stemmer so "quotes", "quote", "categories" and "category" compare equal.
 * It only needs to be consistent, not linguistically correct, because both sides go through it.
 */
export function stem(word: string): string {
  const w = word.toLowerCase()
  // "ids" is the one short plural worth reading: "order ids".
  if (w.length <= 3) return w === 'ids' ? 'id' : w
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.endsWith('sses')) return w.slice(0, -2)
  if (/(xes|ches|shes)$/.test(w)) return w.slice(0, -2)
  if (w.endsWith('ss') || w.endsWith('us') || w.endsWith('is')) return w
  if (w.endsWith('s')) return w.slice(0, -1)
  return w
}

export function stems(words: string[]): string[] {
  return words.map(stem)
}

/** True when `needle` appears as a contiguous run inside `haystack`. */
export function containsRun(haystack: string[], needle: string[]): boolean {
  if (!needle.length || needle.length > haystack.length) return false
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

export function sameWords(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i])
}

/** Words that carry no meaning in a request like "show me all the invoices please". */
export const FILLER = new Set([
  'show', 'me', 'all', 'the', 'a', 'an', 'list', 'get', 'find', 'give', 'i', 'want', 'to', 'see', 'display',
  'please', 'records', 'record', 'rows', 'row', 'which', 'that', 'are', 'were', 'was', 'is', 'be', 'been',
  'any', 'every', 'some', 'of', 'attached', 'linked', 'associated', 'related', 'entries', 'entry', 'data',
  'can', 'you', 'what', 'where', 'whose', 'there', 'those', 'these', 'them', 'just', 'only', 'also', 'and',
  'have', 'has', 'had', 'got', 'it', 'its', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'or', 'lookup', 'details'
])

/** Column-name words that describe the kind of column rather than what it is about. */
export const COLUMN_NOISE = new Set(['id', 'date', 'datetime', 'time', 'timestamp', 'on', 'at', 'dt', 'utc', 'is', 'has', 'flag'])

/** Column-name words suggesting a small set of categorical values worth looking up. */
export const CATEGORY_HINTS = new Set([
  'status', 'state', 'type', 'stage', 'category', 'kind', 'priority', 'level', 'phase', 'result', 'outcome',
  'source', 'method', 'channel', 'reason', 'mode', 'class', 'group', 'lookup', 'role'
])

export const SQL_KEYWORDS = new Set([
  'as', 'at', 'by', 'do', 'go', 'if', 'in', 'is', 'no', 'of', 'on', 'or', 'to', 'add', 'all', 'and', 'any',
  'asc', 'end', 'for', 'key', 'not', 'set', 'top', 'use', 'desc', 'from', 'into', 'join', 'left', 'like',
  'null', 'open', 'over', 'plan', 'proc', 'read', 'rule', 'save', 'then', 'tran', 'user', 'view', 'when',
  'with', 'case', 'else', 'drop', 'exec', 'file', 'full', 'goto', 'kill', 'load', 'text', 'char', 'int', 'div', 'mod',
  // Reserved words that are also plain words in table and key names ("OrderId" would alias as `order`).
  'order', 'group', 'select', 'where', 'table', 'limit', 'values', 'union', 'having', 'index', 'check', 'column',
  'default', 'delete', 'insert', 'update', 'create', 'alter', 'grant', 'range', 'rank', 'row', 'rows', 'lines',
  'inner', 'outer', 'cross', 'right', 'match', 'keys', 'interval', 'option', 'current', 'leading', 'convert',
  'function', 'procedure', 'trigger', 'database', 'schema', 'primary', 'foreign', 'references', 'condition', 'release'
])
