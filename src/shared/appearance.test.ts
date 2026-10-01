import { describe, expect, it } from 'vitest'
import { appearanceVars, parseAppearance, textOn } from './appearance'

describe('parseAppearance', () => {
  it('keeps the value, editor, query and startup settings, and drops anything else', () => {
    expect(parseAppearance({
      dateFormat: 'uk', hideFractions: true, localTime: true, nullText: 'symbol', thousands: true,
      ctrlEnter: 'all', lowerKeywords: true, hideRunGutter: true, hideRunNotes: true, completeOnRequest: true,
      queryTimeout: 60, maxRows: 10_000, freshStart: true, defaultConnection: '0b7c3f2e-1d2a-4c55-9e1a-3f0c2d1b9a77'
    })).toEqual({
      dateFormat: 'uk', hideFractions: true, localTime: true, nullText: 'symbol', thousands: true,
      ctrlEnter: 'all', lowerKeywords: true, hideRunGutter: true, hideRunNotes: true, completeOnRequest: true,
      queryTimeout: 60, maxRows: 10_000, freshStart: true, defaultConnection: '0b7c3f2e-1d2a-4c55-9e1a-3f0c2d1b9a77'
    })
    expect(parseAppearance({
      dateFormat: 'dd-mm', nullText: 'nil', ctrlEnter: 'statement', thousands: 'yes', hideRunGutter: false,
      queryTimeout: 7, maxRows: -1, defaultConnection: '"><script>'
    })).toEqual({})
  })

  it('keeps valid settings and normalises colours', () => {
    expect(parseAppearance({
      accent: '#A371F7', env: { prod: '#FF0000', dev: 'blue' }, uiFont: ' Inter ', codeFont: 'JetBrains Mono',
      uiScale: 1.1, codeSize: 14, ligatures: true, density: 'compact', wordWrap: true, tabSize: 2
    })).toEqual({
      accent: '#a371f7', env: { prod: '#ff0000' }, uiFont: 'Inter', codeFont: 'JetBrains Mono',
      uiScale: 1.1, codeSize: 14, ligatures: true, density: 'compact', wordWrap: true, tabSize: 2
    })
  })

  it('drops anything invalid, including font names that could break out of CSS', () => {
    expect(parseAppearance({
      accent: 'red', uiFont: 'x"; } body { display: none', codeFont: '', uiScale: 3, codeSize: 40,
      density: 'huge', tabSize: 8, ligatures: 'yes', env: 'nope'
    })).toEqual({})
    expect(parseAppearance(null)).toEqual({})
    expect(parseAppearance('dark')).toEqual({})
  })
})

describe('appearanceVars', () => {
  it('sets only what was chosen, plus sizes that always apply', () => {
    expect(appearanceVars({}, true)).toEqual({
      '--code-size': '13px', '--grid-size': '12px', '--mono-ligatures': 'none', '--row-height': '26px'
    })
  })

  it('derives the accent tints for light and dark themes', () => {
    const dark = appearanceVars({ accent: '#e85aad' }, true)
    const light = appearanceVars({ accent: '#e85aad' }, false)
    expect(dark['--accent']).toBe('#e85aad')
    expect(dark['--accent-soft']).toContain('16%')
    expect(light['--accent-soft']).toContain('10%')
  })

  it('puts the chosen fonts first with safe fallbacks', () => {
    const vars = appearanceVars({ uiFont: 'Inter', codeFont: 'Fira Code', codeSize: 15, ligatures: true, density: 'spacious', env: { prod: '#ff00ff' } }, true)
    expect(vars['--sans']).toMatch(/^"Inter", /)
    expect(vars['--mono']).toMatch(/^"Fira Code", .*monospace$/)
    expect(vars).toMatchObject({ '--code-size': '15px', '--grid-size': '14px', '--mono-ligatures': 'normal', '--row-height': '32px', '--env-prod': '#ff00ff' })
  })
})

describe('textOn', () => {
  it('picks readable text for an accent', () => {
    expect(textOn('#1f7a33')).toBe('#fff')
    expect(textOn('#f0e060')).toBe('#000')
  })
})
