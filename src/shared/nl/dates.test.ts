import { describe, expect, it } from 'vitest'
import { isoDate, parseDate } from './dates'
import { tokenize } from './tokens'

// Friday 25 September 2026
const NOW = new Date(2026, 8, 25, 14, 30)

function parse(text: string): { from?: string; to?: string; length: number } | null {
  const tokens = tokenize(text)
  const match = parseDate(tokens, 0, NOW)
  if (!match) return null
  return {
    from: match.range.from && isoDate(match.range.from),
    to: match.range.to && isoDate(match.range.to),
    length: match.length
  }
}

describe('parseDate', () => {
  it('reads numeric dates day-first (UK)', () => {
    expect(parse('12/11/2025')).toEqual({ from: '2025-11-12', to: '2025-11-13', length: 1 })
    expect(parse('2025-11-12')).toEqual({ from: '2025-11-12', to: '2025-11-13', length: 1 })
  })

  it('rejects impossible dates', () => {
    expect(parse('31/02/2025')).toBeNull()
  })

  it('reads relative ranges with Monday-start weeks', () => {
    expect(parse('today')).toEqual({ from: '2026-09-25', to: '2026-09-26', length: 1 })
    expect(parse('this week')).toEqual({ from: '2026-09-21', to: '2026-09-28', length: 2 })
    expect(parse('last month')).toEqual({ from: '2026-08-01', to: '2026-09-01', length: 2 })
    expect(parse('last 30 days')).toEqual({ from: '2026-08-26', to: '2026-09-26', length: 3 })
  })

  it('reads weekdays, before today unless asked for this or next week', () => {
    // NOW is Friday 25 September 2026.
    expect(parse('friday')).toEqual({ from: '2026-09-25', to: '2026-09-26', length: 1 })
    expect(parse('thursday')).toEqual({ from: '2026-09-24', to: '2026-09-25', length: 1 })
    expect(parse('last friday')).toEqual({ from: '2026-09-18', to: '2026-09-19', length: 2 })
    expect(parse('last thursday')).toEqual({ from: '2026-09-24', to: '2026-09-25', length: 2 })
    expect(parse('this friday')).toEqual({ from: '2026-09-25', to: '2026-09-26', length: 2 })
    expect(parse('this sunday')).toEqual({ from: '2026-09-27', to: '2026-09-28', length: 2 })
    expect(parse('next friday')).toEqual({ from: '2026-10-02', to: '2026-10-03', length: 2 })
    expect(parse('last tues')).toEqual({ from: '2026-09-22', to: '2026-09-23', length: 2 })
    expect(parse('last week')).toEqual({ from: '2026-09-14', to: '2026-09-21', length: 2 })
  })

  it('reads now as today', () => {
    expect(parse('now')).toEqual({ from: '2026-09-25', to: '2026-09-26', length: 1 })
  })

  it('reads written dates, months and years', () => {
    expect(parse('12th dec 2025')).toEqual({ from: '2025-12-12', to: '2025-12-13', length: 3 })
    expect(parse('december 2025')).toEqual({ from: '2025-12-01', to: '2026-01-01', length: 2 })
    expect(parse('2025')).toEqual({ from: '2025-01-01', to: '2026-01-01', length: 1 })
  })
})
