import { describe, expect, it } from 'vitest'
import { cellStats, formatStat } from './stats'

describe('cellStats', () => {
  it('sums numbers, including big ones sent as digit strings, and skips NULLs', () => {
    expect(cellStats([1, 2, null, '3', 4])).toEqual({ count: 4, distinct: 4, numeric: { sum: 10, average: 2.5, min: 1, max: 4 } })
  })

  it('only counts when any value is not a number', () => {
    expect(cellStats(['a', 'b', 'a', null])).toEqual({ count: 3, distinct: 2 })
    expect(cellStats([1, 'x'])).toEqual({ count: 2, distinct: 2 })
  })

  it('handles an all-NULL selection', () => {
    expect(cellStats([null, null])).toEqual({ count: 0, distinct: 0 })
  })
})

describe('formatStat', () => {
  it('hides float noise', () => {
    expect(formatStat(0.1 + 0.2)).toBe((0.3).toLocaleString())
  })
})
