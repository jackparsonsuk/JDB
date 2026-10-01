import type { CellValue } from './types'
import type { Appearance } from './appearance'

/** The Settings that change how a value shows in a grid. What's copied, exported, filtered or edited stays the raw value. */
export type CellFormat = Pick<Appearance, 'dateFormat' | 'hideFractions' | 'localTime' | 'nullText' | 'thousands'>

const NULL_TEXT = { blank: '', symbol: '∅', paren: '(null)' } as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Dates as the drivers send them: SQL Server's ISO strings ending in Z, MySQL's "YYYY-MM-DD HH:MM:SS.ffffff". */
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/

/** Columns whose numbers are identifiers or codes, which read wrongly with separators. */
const ID_LIKE = /(id|no|number|code|year|port|version)$/i

const pad = (n: number): string => String(n).padStart(2, '0')

/** Whether any setting changes how values show, so the grid can skip formatting entirely. */
export function formatsCells(f: CellFormat): boolean {
  return !!(f.dateFormat || f.hideFractions || f.localTime || f.nullText || f.thousands)
}

function formatDate(text: string, f: CellFormat): string | null {
  const m = DATE.exec(text)
  if (!m || !(f.dateFormat || f.hideFractions || f.localTime)) return null
  let [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const hasTime = m[4] !== undefined
  let [h, mi, s] = [Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)]
  const fraction = m[7] ?? ''
  if (hasTime && f.localTime) {
    // Stored times are taken as UTC (SQL Server's already are), unless the value says otherwise.
    const zone = m[8] && m[8] !== 'Z' ? m[8] : '+00:00'
    const at = new Date(`${m[1]}-${m[2]}-${m[3]}T${pad(h)}:${pad(mi)}:${pad(s)}${zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`}`)
    if (!isNaN(at.getTime())) {
      ;[y, mo, d, h, mi, s] = [at.getFullYear(), at.getMonth() + 1, at.getDate(), at.getHours(), at.getMinutes(), at.getSeconds()]
    }
  }
  const date = f.dateFormat === 'uk' ? `${pad(d)}/${pad(mo)}/${y}`
    : f.dateFormat === 'us' ? `${pad(mo)}/${pad(d)}/${y}`
      : f.dateFormat === 'long' ? `${d} ${MONTHS[mo - 1]} ${y}`
        : `${y}-${pad(mo)}-${pad(d)}`
  if (!hasTime) return date
  const seconds = m[6] !== undefined ? `:${pad(s)}${f.hideFractions ? '' : fraction}` : ''
  return `${date} ${pad(h)}:${pad(mi)}${seconds}`
}

function withSeparators(n: number): string {
  const text = String(n)
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text
  const [whole, part] = text.split('.')
  const sign = whole.startsWith('-') ? '-' : ''
  const digits = sign ? whole.slice(1) : whole
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${part !== undefined ? `.${part}` : ''}`
}

/** How a value shows in a grid cell under the Settings in `f`. */
export function formatCell(value: CellValue, column: string, f: CellFormat): string {
  if (value === null) return f.nullText ? NULL_TEXT[f.nullText] : 'NULL'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return f.thousands && !ID_LIKE.test(column) ? withSeparators(value) : String(value)
  return formatDate(value, f) ?? value
}
