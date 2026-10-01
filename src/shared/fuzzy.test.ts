import { describe, expect, it } from 'vitest'
import { wordScore } from './fuzzy'

const matches = (query: string, text: string): boolean => wordScore(query, text) >= 0

describe('wordScore', () => {
  it('matches substrings anywhere', () => {
    expect(matches('voice', 'queue_invoice_export')).toBe(true)
    expect(matches('EMAIL', 'dbo.ProcessedEmails')).toBe(true)
  })

  it('does not pick letters out of the middle of words', () => {
    expect(matches('next', 'queue_invoice_export')).toBe(false)
    expect(matches('next', 'next_invoice')).toBe(true)
    expect(matches('next', 'NextRun')).toBe(true)
  })

  it('matches word-start shorthand in snake_case, CamelCase and schema names', () => {
    expect(matches('qie', 'queue_invoice_export')).toBe(true)
    expect(matches('pe', 'ProcessedEmails')).toBe(true)
    expect(matches('proem', 'ProcessedEmails')).toBe(true)
    expect(matches('dbo.pe', 'dbo.ProcessedEmails')).toBe(true)
    expect(matches('ol2', 'OrderLines2')).toBe(true)
  })

  it('finds the word-start reading even when the first letter also appears earlier', () => {
    // A greedy match would take the e in "Processed" and then fail.
    expect(matches('pem', 'ProcessedEmails')).toBe(true)
  })

  it('ignores spaces in the filter', () => {
    expect(matches('proc em', 'ProcessedEmails')).toBe(true)
  })

  it('ranks substrings first, then tighter word-start matches', () => {
    const rank = (query: string, names: string[]): string[] => names
      .map((n) => ({ n, s: wordScore(query, n) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.n)
    expect(rank('order', ['CustomerOrders', 'Orders', 'OpenDeliveryRequests'])).toEqual(['Orders', 'CustomerOrders'])
    // Every letter on a word start (an acronym) beats a run inside a word; shorter names first.
    expect(rank('odr', ['OpenDeliveryRequests', 'OrderDraft', 'OrderDetailRows'])).toEqual(['OrderDetailRows', 'OpenDeliveryRequests', 'OrderDraft'])
  })
})
