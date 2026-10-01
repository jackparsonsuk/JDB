import type { Token } from './tokens'

/** A half-open date range [from, to). Either end may be open. */
export interface DateRange {
  from?: Date
  to?: Date
}

export interface DateMatch {
  range: DateRange
  /** Number of tokens consumed. */
  length: number
  label: string
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const UNITS: Record<string, 'day' | 'week' | 'month' | 'quarter' | 'year'> = {
  day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month',
  quarter: 'quarter', quarters: 'quarter', year: 'year', years: 'year'
}
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  twelve: 12, fourteen: 14, thirty: 30, ninety: 90
}

const day = (y: number, m: number, d: number): Date => new Date(y, m, d)
const addDays = (date: Date, n: number): Date => day(date.getFullYear(), date.getMonth(), date.getDate() + n)
const addMonths = (date: Date, n: number): Date => day(date.getFullYear(), date.getMonth() + n, 1)

function startOf(unit: 'day' | 'week' | 'month' | 'quarter' | 'year', date: Date): Date {
  switch (unit) {
    case 'day': return day(date.getFullYear(), date.getMonth(), date.getDate())
    // Weeks start on Monday (UK convention).
    case 'week': return addDays(startOf('day', date), -((date.getDay() + 6) % 7))
    case 'month': return day(date.getFullYear(), date.getMonth(), 1)
    case 'quarter': return day(date.getFullYear(), Math.floor(date.getMonth() / 3) * 3, 1)
    case 'year': return day(date.getFullYear(), 0, 1)
  }
}

function shift(unit: 'day' | 'week' | 'month' | 'quarter' | 'year', date: Date, n: number): Date {
  switch (unit) {
    case 'day': return addDays(date, n)
    case 'week': return addDays(date, n * 7)
    case 'month': return day(date.getFullYear(), date.getMonth() + n, date.getDate())
    case 'quarter': return day(date.getFullYear(), date.getMonth() + n * 3, date.getDate())
    case 'year': return day(date.getFullYear() + n, date.getMonth(), date.getDate())
  }
}

/** Weekday names, Sunday first like Date.getDay(); abbreviations are read too ("fri", "tues", "thurs"). */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const WEEKDAY_ABBREVIATIONS: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 }

/** The day of the week a word names (0 = Sunday), or null. Plurals count too: "on fridays". */
export function weekdayIndex(word: string, abbreviations = true): number | null {
  const w = word.toLowerCase().replace(/days$/, 'day')
  const full = WEEKDAYS.indexOf(w)
  if (full >= 0) return full
  return abbreviations ? WEEKDAY_ABBREVIATIONS[w] ?? null : null
}

/**
 * The day a weekday means: plain "friday" is the latest one up to today, "last friday" the one
 * before today, "this friday" the one in this (Monday-start) week and "next friday" the next after today.
 */
function weekdayDate(target: number, which: 'plain' | 'last' | 'this' | 'next', now: Date): Date {
  const today = startOf('day', now)
  const back = (today.getDay() - target + 7) % 7
  switch (which) {
    case 'plain': return addDays(today, -back)
    case 'last': return addDays(today, -(back || 7))
    case 'next': return addDays(today, (target - today.getDay() + 7) % 7 || 7)
    case 'this': return addDays(startOf('week', now), (target + 6) % 7)
  }
}

function monthIndex(word: string): number {
  return MONTHS.indexOf(word.slice(0, 3))
}

function isMonthWord(word: string): boolean {
  const i = monthIndex(word)
  return i >= 0 && (word.length === 3 || MONTH_FULL[i].startsWith(word) || word === 'sept')
}
const MONTH_FULL = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y
}

/** Parses 12/12/2025 (UK day-first), 2025-12-12 and 12-12-25. */
function parseNumericDate(text: string): Date | null {
  let m = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) return valid(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (m) return valid(fullYear(Number(m[3])), Number(m[2]) - 1, Number(m[1]))
  return null
}

function valid(y: number, m: number, d: number): Date | null {
  const date = day(y, m, d)
  return date.getFullYear() === y && date.getMonth() === m && date.getDate() === d ? date : null
}

function ordinal(word: string): number | null {
  const m = word.match(/^(\d{1,2})(st|nd|rd|th)?$/)
  return m ? Number(m[1]) : null
}

function count(token: Token | undefined): number | null {
  if (!token) return null
  if (token.type === 'number') return Number(token.text)
  return NUMBER_WORDS[token.lower] ?? null
}

/** Formats a range as a short human label for the UI. */
function fmt(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * Tries to read a date expression starting at tokens[i]. Handles explicit dates,
 * "12 dec 2025", "december 2025", "2025", "today", "now", "this week", "last 30 days", "3 months ago",
 * "friday", "last friday", "next tue".
 */
export function parseDate(tokens: Token[], i: number, now: Date): DateMatch | null {
  const t = tokens[i]
  if (!t) return null
  const w = t.lower
  const next = tokens[i + 1]?.lower
  const today = startOf('day', now)

  if (t.type === 'date') {
    const date = parseNumericDate(t.text)
    return date ? { range: { from: date, to: addDays(date, 1) }, length: 1, label: fmt(date) } : null
  }

  if (w === 'today') return { range: { from: today, to: addDays(today, 1) }, length: 1, label: 'today' }
  if (w === 'yesterday') return { range: { from: addDays(today, -1), to: today }, length: 1, label: 'yesterday' }
  if (w === 'tomorrow') return { range: { from: addDays(today, 1), to: addDays(today, 2) }, length: 1, label: 'tomorrow' }
  // Dates here are whole days, so "now" is today: "between last friday and now" includes today.
  if (w === 'now') return { range: { from: today, to: addDays(today, 1) }, length: 1, label: 'now' }

  // [last / this / next] friday
  const qualifier = w === 'last' || w === 'previous' ? 'last' : w === 'this' || w === 'current' ? 'this' : w === 'next' ? 'next' : null
  const weekday = weekdayIndex(qualifier ? next ?? '' : w)
  if (weekday !== null) {
    const date = weekdayDate(weekday, qualifier ?? 'plain', now)
    const name = WEEKDAYS[weekday]
    return { range: { from: date, to: addDays(date, 1) }, length: qualifier ? 2 : 1, label: `${qualifier ? `${w} ` : ''}${name} (${fmt(date)})` }
  }

  // this / last / next <unit>
  if ((w === 'this' || w === 'last' || w === 'next' || w === 'previous' || w === 'current') && next && UNITS[next]) {
    const unit = UNITS[next]
    const offset = w === 'last' || w === 'previous' ? -1 : w === 'next' ? 1 : 0
    const from = shift(unit, startOf(unit, now), offset)
    return { range: { from, to: shift(unit, from, 1) }, length: 2, label: `${w} ${unit}` }
  }

  // last / past N <unit>  (rolling window ending today)
  if ((w === 'last' || w === 'past') && count(tokens[i + 1]) !== null && tokens[i + 2] && UNITS[tokens[i + 2].lower]) {
    const n = count(tokens[i + 1])!
    const unit = UNITS[tokens[i + 2].lower]
    return { range: { from: shift(unit, today, -n), to: addDays(today, 1) }, length: 3, label: `last ${n} ${unit}s` }
  }

  // N <unit> ago
  if (count(t) !== null && next && UNITS[next] && tokens[i + 2]?.lower === 'ago') {
    const unit = UNITS[next]
    const date = shift(unit, today, -count(t)!)
    return { range: { from: date, to: addDays(date, 1) }, length: 3, label: `${count(t)} ${unit}s ago` }
  }

  // 12 dec [2025] / 12th december [2025]
  const d = ordinal(w)
  if (d !== null && next && isMonthWord(next)) {
    const yearToken = tokens[i + 2]
    const hasYear = yearToken?.type === 'number' && /^\d{2,4}$/.test(yearToken.text)
    const year = hasYear ? fullYear(Number(yearToken.text)) : now.getFullYear()
    const date = valid(year, monthIndex(next), d)
    if (date) return { range: { from: date, to: addDays(date, 1) }, length: hasYear ? 3 : 2, label: fmt(date) }
  }

  if (isMonthWord(w)) {
    // dec 12 [2025]
    const dd = next ? ordinal(next) : null
    const yearToken = tokens[i + 2]
    if (dd !== null && dd <= 31 && tokens[i + 1].type !== 'date') {
      const hasYear = yearToken?.type === 'number' && /^\d{4}$/.test(yearToken.text)
      const date = valid(hasYear ? Number(yearToken.text) : now.getFullYear(), monthIndex(w), dd)
      if (date && !(tokens[i + 1].type === 'number' && /^\d{4}$/.test(tokens[i + 1].text))) {
        return { range: { from: date, to: addDays(date, 1) }, length: hasYear ? 3 : 2, label: fmt(date) }
      }
    }
    // december [2025]
    const hasYear = tokens[i + 1]?.type === 'number' && /^\d{4}$/.test(tokens[i + 1].text)
    const year = hasYear ? Number(tokens[i + 1].text) : now.getFullYear()
    const from = day(year, monthIndex(w), 1)
    return { range: { from, to: addMonths(from, 1) }, length: hasYear ? 2 : 1, label: `${MONTH_FULL[monthIndex(w)]} ${year}` }
  }

  // bare year, only plausible ones
  if (t.type === 'number' && /^(19|20)\d{2}$/.test(t.text)) {
    const from = day(Number(t.text), 0, 1)
    return { range: { from, to: day(Number(t.text) + 1, 0, 1) }, length: 1, label: t.text }
  }

  return null
}

export function formatRangeLabel(range: DateRange): string {
  if (range.from && range.to) {
    return addDays(range.from, 1).getTime() === range.to.getTime() ? fmt(range.from) : `${fmt(range.from)} – ${fmt(addDays(range.to, -1))}`
  }
  if (range.from) return `from ${fmt(range.from)}`
  if (range.to) return `before ${fmt(range.to)}`
  return ''
}

export function isoDate(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}
