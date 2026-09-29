import { describe, expect, it } from 'vitest'
import { columnLetter, sheetName, xlsxParts } from './xlsx'

const sheetXml = (columns: string[], rows: (string | number | boolean | null)[][]): string =>
  xlsxParts('Orders', columns, rows).find((p) => p.path === 'xl/worksheets/sheet1.xml')!.content

describe('xlsx', () => {
  it('names columns like Excel', () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA'])
  })

  it('cleans sheet names', () => {
    expect(sheetName('dbo.Orders [live]: 2026/09')).toBe('dbo.Orders  live   2026 09')
    expect(sheetName('a'.repeat(40))).toHaveLength(31)
    expect(sheetName('  ')).toBe('Sheet1')
  })

  it('writes numbers, booleans, dates and text as the right cell types', () => {
    const xml = sheetXml(['a', 'b', 'c', 'd', 'e', 'f', 'g'], [[42, true, '2026-09-29T00:00:00.000Z', '2026-09-29T12:00:00.000Z', '007', '12.50', null]])
    expect(xml).toContain('<c r="A2"><v>42</v></c>')
    expect(xml).toContain('<c r="B2" t="b"><v>1</v></c>')
    // 29 Sep 2026 is Excel day 46294; midday adds half a day.
    expect(xml).toContain('<c r="C2" s="2"><v>46294</v></c>')
    expect(xml).toContain('<c r="D2" s="3"><v>46294.5</v></c>')
    expect(xml).toContain('<c r="E2" t="inlineStr"><is><t>007</t></is></c>')
    expect(xml).toContain('<c r="F2"><v>12.50</v></c>')
    expect(xml).not.toContain('r="G2"')
  })

  it('reads MySQL date text and bare dates as dates', () => {
    const xml = sheetXml(['a', 'b'], [['2026-09-29 12:00:00.000000', '2026-09-29']])
    expect(xml).toContain('<c r="A2" s="3"><v>46294.5</v></c>')
    expect(xml).toContain('<c r="B2" s="2"><v>46294</v></c>')
  })

  it('keeps long numeric text as text so it keeps every digit', () => {
    expect(sheetXml(['id'], [['12345678901234567890']])).toContain('t="inlineStr"><is><t>12345678901234567890</t>')
  })

  it('escapes XML and drops characters XML cannot hold', () => {
    const xml = sheetXml(['<name> & "x"'], [['a\u0001b < c']])
    expect(xml).toContain('&lt;name&gt; &amp; &quot;x&quot;')
    expect(xml).toContain('<t>ab &lt; c</t>')
  })

  it('bolds and freezes the header and adds a filter over the data', () => {
    const xml = sheetXml(['a', 'b'], [[1, 2], [3, 4]])
    expect(xml).toContain('<c r="A1" t="inlineStr" s="1">')
    expect(xml).toContain('state="frozen"')
    expect(xml).toContain('<autoFilter ref="A1:B3"/>')
  })
})
