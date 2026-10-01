import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatCell, formatsCells } from './cellFormat'

const MSSQL = '2026-06-15T09:07:47.890Z'
const MYSQL = '2026-06-15 09:07:47.890277'

describe('formatCell', () => {
  it('leaves everything as it was with no settings', () => {
    expect(formatCell(MSSQL, 'CreatedOn', {})).toBe(MSSQL)
    expect(formatCell(null, 'x', {})).toBe('NULL')
    expect(formatCell(1227695, 'Total', {})).toBe('1227695')
    expect(formatsCells({})).toBe(false)
  })

  it('writes dates in the chosen format, from either driver', () => {
    expect(formatCell(MSSQL, 'd', { dateFormat: 'iso' })).toBe('2026-06-15 09:07:47.890')
    expect(formatCell(MYSQL, 'd', { dateFormat: 'uk' })).toBe('15/06/2026 09:07:47.890277')
    expect(formatCell(MYSQL, 'd', { dateFormat: 'us' })).toBe('06/15/2026 09:07:47.890277')
    expect(formatCell(MYSQL, 'd', { dateFormat: 'long', hideFractions: true })).toBe('15 Jun 2026 09:07:47')
    expect(formatCell('2026-06-15', 'd', { dateFormat: 'uk' })).toBe('15/06/2026')
    expect(formatCell('2026-06-15 09:07', 'd', { dateFormat: 'uk' })).toBe('15/06/2026 09:07')
  })

  it('leaves text that only looks a bit like a date alone', () => {
    expect(formatCell('2026-06-15 notes', 'd', { dateFormat: 'uk' })).toBe('2026-06-15 notes')
    expect(formatCell('20260615', 'd', { dateFormat: 'uk' })).toBe('20260615')
  })

  describe('local time', () => {
    beforeEach(() => {
      vi.stubEnv('TZ', 'Europe/London')
    })
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    it('shows stored UTC times in this PC’s zone, keeping the fraction', () => {
      // 15 June is in British Summer Time, an hour ahead of UTC.
      expect(formatCell(MSSQL, 'd', { localTime: true })).toBe('2026-06-15 10:07:47.890')
      expect(formatCell('2026-01-15 09:07:47', 'd', { localTime: true, dateFormat: 'uk' })).toBe('15/01/2026 09:07:47')
      // A date alone has no time to move.
      expect(formatCell('2026-06-15', 'd', { localTime: true })).toBe('2026-06-15')
    })
  })

  it('shows NULL the chosen way', () => {
    expect(formatCell(null, 'x', { nullText: 'blank' })).toBe('')
    expect(formatCell(null, 'x', { nullText: 'symbol' })).toBe('∅')
    expect(formatCell(null, 'x', { nullText: 'paren' })).toBe('(null)')
  })

  it('adds thousands separators, except to ID-like columns', () => {
    expect(formatCell(1227695, 'Total', { thousands: true })).toBe('1,227,695')
    expect(formatCell(-1234.5678, 'Amount', { thousands: true })).toBe('-1,234.5678')
    expect(formatCell(1227695, 'WebhookJobId', { thousands: true })).toBe('1227695')
    expect(formatCell(2026, 'Year', { thousands: true })).toBe('2026')
    expect(formatCell(999, 'Total', { thousands: true })).toBe('999')
  })
})
