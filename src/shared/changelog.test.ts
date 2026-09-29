import { describe, expect, it } from 'vitest'
import { changesSince, compareVersions, parseChangelog } from './changelog'

const text = `# Changelog

Intro text that isn't part of any version.

## 0.6.0
- Adds a thing
- A long note that wraps
  onto a second line

## 0.5.10

- Fixes another thing

## v0.5.9
Plain line without a bullet
`

describe('changelog', () => {
  it('reads each version and its notes, joining wrapped lines', () => {
    expect(parseChangelog(text)).toEqual([
      { version: '0.6.0', notes: ['Adds a thing', 'A long note that wraps onto a second line'] },
      { version: '0.5.10', notes: ['Fixes another thing'] },
      { version: '0.5.9', notes: ['Plain line without a bullet'] }
    ])
  })

  it('compares versions numerically, not as text', () => {
    expect(compareVersions('0.5.10', '0.5.9')).toBeGreaterThan(0)
    expect(compareVersions('0.5.9', '0.6.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  it('lists what an update brought, newest first, excluding the version already had', () => {
    const entries = parseChangelog(text)
    expect(changesSince(entries, '0.5.9', '0.6.0').map((e) => e.version)).toEqual(['0.6.0', '0.5.10'])
    expect(changesSince(entries, '0.5.10', '0.5.10')).toEqual([])
  })
})
