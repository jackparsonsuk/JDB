import type { CellValue } from './types'

/** Excel-style summary of the selected cells in one column. */
export interface CellStats {
  /** Non-null values. */
  count: number
  /** Only when every non-null value is a number. */
  numeric?: { sum: number; average: number; min: number; max: number }
  distinct: number
}

const NUMERIC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

/** Numbers arrive as numbers, except ones too big for JS (bigint, decimal) which arrive as digit strings. */
function asNumber(value: CellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && NUMERIC.test(value)) return Number(value)
  return null
}

export function cellStats(values: CellValue[]): CellStats {
  const present = values.filter((v) => v !== null)
  const numbers = present.map(asNumber)
  const distinct = new Set(present.map((v) => String(v))).size
  if (!present.length || numbers.some((n) => n === null)) return { count: present.length, distinct }
  const nums = numbers as number[]
  const sum = nums.reduce((a, b) => a + b, 0)
  return {
    count: present.length,
    distinct,
    numeric: { sum, average: sum / nums.length, min: Math.min(...nums), max: Math.max(...nums) }
  }
}

/** Rounds away float noise (0.1 + 0.2) without hiding real decimals; `digits` caps them, e.g. 2 for averages. */
export function formatStat(n: number, digits = 6): string {
  const scale = 10 ** digits
  return (Math.round(n * scale) / scale).toLocaleString(undefined, { maximumFractionDigits: digits })
}
