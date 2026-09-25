export type TokenType = 'word' | 'number' | 'date' | 'quoted' | 'symbol'

export interface Token {
  /** Original text (without quotes for quoted strings). */
  text: string
  lower: string
  type: TokenType
  start: number
  end: number
}

const PATTERN = /"([^"]*)"?|'([^']*)'?|(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})|(£?-?\d+(?:[.,]\d+)*(?:%|(?:st|nd|rd|th)(?![A-Za-z]))?)|(>=|<=|!=|<>|[<>=])|([A-Za-z][A-Za-z0-9_'’]*)/g

export function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  for (const m of input.matchAll(PATTERN)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    if (m[1] !== undefined || m[2] !== undefined) {
      const text = m[1] ?? m[2]
      tokens.push({ text, lower: text.toLowerCase(), type: 'quoted', start, end })
    } else if (m[3]) {
      tokens.push({ text: m[3], lower: m[3], type: 'date', start, end })
    } else if (m[4]) {
      // Strips currency, thousands separators, percent and ordinal suffixes: £1,200 -> 1200, 12th -> 12.
      const text = m[4].replace(/[£,%]|(st|nd|rd|th)$/g, '')
      tokens.push({ text, lower: text, type: 'number', start, end })
    } else if (m[5]) {
      tokens.push({ text: m[5], lower: m[5], type: 'symbol', start, end })
    } else if (m[6]) {
      const text = m[6].replace(/[’']s$/i, '')
      tokens.push({ text, lower: text.toLowerCase(), type: 'word', start, end })
    }
  }
  return tokens
}
