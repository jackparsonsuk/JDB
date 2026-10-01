import { DEFAULT_ENV_COLORS, type BuiltinEnv } from './environments'

export { DEFAULT_ENV_COLORS }

/**
 * How the app looks beyond the theme: accent and environment colours, fonts, interface size,
 * grid density and editor behaviour. Anything left out uses the default, so an empty object is
 * the out-of-the-box look. Stored in settings.json and checked with parseAppearance on the way in.
 */
export interface Appearance {
  /** #rrggbb; none uses the theme's own accent. */
  accent?: string
  /** Colours for the built-in environments' dots, tabs and banners (custom ones carry their own). */
  env?: Partial<Record<BuiltinEnv, string>>
  /** A font family name for the interface; none uses Segoe UI. */
  uiFont?: string
  /** Scales the whole interface, grid included. */
  uiScale?: UiScale
  /** A font family name for the SQL editor and grid; none uses Cascadia Mono. */
  codeFont?: string
  /** Editor font size in px; the grid uses one less. */
  codeSize?: number
  /** Programming ligatures (e.g. => as one glyph) in fonts that have them. */
  ligatures?: boolean
  density?: Density
  /** Wrap long lines in the SQL editor. */
  wordWrap?: boolean
  tabSize?: 2 | 4

  // How values show in grids. None of these change what's copied, exported, filtered or edited.
  /** How dates and times show; none shows them as the database sent them. */
  dateFormat?: DateFormat
  /** Leave out fractions of a second. */
  hideFractions?: boolean
  /** Treat stored times as UTC and show them in this PC's time zone. */
  localTime?: boolean
  /** How NULL shows; none shows NULL. */
  nullText?: NullText
  /** Thousands separators in numbers, except columns that look like IDs. */
  thousands?: boolean
  /** Plain rows rather than alternate ones shaded. */
  noStripes?: boolean
  /** Leave out the label shown beside a lookup key ("Draft" beside an OrderStatusId). */
  hideLookupLabels?: boolean

  // The SQL editor.
  /** What Ctrl+Enter runs; none runs the selection or the statement at the cursor. */
  ctrlEnter?: 'all'
  /** Lower-case keywords in autocompletion and formatting; none is upper case. */
  lowerKeywords?: boolean
  /** Hide the ▶ run gutter. */
  hideRunGutter?: boolean
  /** Hide the ✓ / ✕ note after each statement runs. */
  hideRunNotes?: boolean
  /** Autocompletion only on Ctrl+Space, not while typing. */
  completeOnRequest?: boolean

  // Queries and startup.
  /** Stop queries from query tabs after this many seconds; none means no limit. */
  queryTimeout?: number
  /** Keep at most this many rows per result set; none means no limit. */
  maxRows?: number
  /** Start with no tabs rather than reopening the last session's. */
  freshStart?: boolean
  /** Connection id Ctrl+T uses when no tab is open; none uses the first connection. */
  defaultConnection?: string
}

export type DateFormat = 'iso' | 'uk' | 'us' | 'long'
export type NullText = 'blank' | 'symbol' | 'paren'

export const DATE_FORMATS: DateFormat[] = ['iso', 'uk', 'us', 'long']
export const NULL_TEXTS: NullText[] = ['blank', 'symbol', 'paren']
/** Query time limits offered in Settings, in seconds. */
export const QUERY_TIMEOUTS = [30, 60, 120, 300, 600, 1800]
/** Row caps offered in Settings. */
export const ROW_CAPS = [1000, 5000, 10_000, 50_000, 100_000, 500_000]

export type UiScale = 0.9 | 1 | 1.1 | 1.25
export type Density = 'compact' | 'comfortable' | 'spacious'

export const UI_SCALES: UiScale[] = [0.9, 1, 1.1, 1.25]
export const DENSITIES: Density[] = ['compact', 'comfortable', 'spacious']
/** Grid row height per density; comfortable is the original 26px. */
export const ROW_HEIGHTS: Record<Density, number> = { compact: 22, comfortable: 26, spacious: 32 }
export const CODE_SIZES = { min: 10, max: 18, default: 13 }


/** Swatches offered for the accent; any #rrggbb can be picked as well. */
export const ACCENT_PRESETS: { name: string; color: string }[] = [
  { name: 'Blue', color: '#4c8dff' },
  { name: 'Green', color: '#3fb950' },
  { name: 'Teal', color: '#1fb8a6' },
  { name: 'Purple', color: '#a371f7' },
  { name: 'Pink', color: '#e85aad' },
  { name: 'Orange', color: '#f0883e' }
]

const HEX = /^#[0-9a-f]{6}$/i
/** Font family names: letters, digits, spaces and a few safe punctuation marks, so they can't break out of CSS. */
const FONT_NAME = /^[\w .'-]{1,60}$/

/** Keeps only valid settings from whatever was stored or sent; never throws. */
export function parseAppearance(raw: unknown): Appearance {
  if (typeof raw !== 'object' || raw === null) return {}
  const r = raw as Record<string, unknown>
  const out: Appearance = {}
  if (typeof r.accent === 'string' && HEX.test(r.accent)) out.accent = r.accent.toLowerCase()
  if (typeof r.env === 'object' && r.env !== null) {
    const env: Partial<Record<BuiltinEnv, string>> = {}
    for (const tag of Object.keys(DEFAULT_ENV_COLORS) as BuiltinEnv[]) {
      const value = (r.env as Record<string, unknown>)[tag]
      if (typeof value === 'string' && HEX.test(value)) env[tag] = value.toLowerCase()
    }
    if (Object.keys(env).length) out.env = env
  }
  if (typeof r.uiFont === 'string' && FONT_NAME.test(r.uiFont.trim())) out.uiFont = r.uiFont.trim()
  if (typeof r.codeFont === 'string' && FONT_NAME.test(r.codeFont.trim())) out.codeFont = r.codeFont.trim()
  if (UI_SCALES.includes(r.uiScale as UiScale)) out.uiScale = r.uiScale as UiScale
  if (typeof r.codeSize === 'number' && Number.isInteger(r.codeSize) && r.codeSize >= CODE_SIZES.min && r.codeSize <= CODE_SIZES.max) out.codeSize = r.codeSize
  if (typeof r.ligatures === 'boolean') out.ligatures = r.ligatures
  if (DENSITIES.includes(r.density as Density)) out.density = r.density as Density
  if (typeof r.wordWrap === 'boolean') out.wordWrap = r.wordWrap
  if (r.tabSize === 2 || r.tabSize === 4) out.tabSize = r.tabSize
  if (DATE_FORMATS.includes(r.dateFormat as DateFormat)) out.dateFormat = r.dateFormat as DateFormat
  if (NULL_TEXTS.includes(r.nullText as NullText)) out.nullText = r.nullText as NullText
  if (r.ctrlEnter === 'all') out.ctrlEnter = 'all'
  for (const key of ['hideFractions', 'localTime', 'thousands', 'lowerKeywords', 'hideRunGutter', 'hideRunNotes', 'completeOnRequest', 'freshStart', 'hideLookupLabels', 'noStripes'] as const) {
    if (r[key] === true) out[key] = true
  }
  if (QUERY_TIMEOUTS.includes(r.queryTimeout as number)) out.queryTimeout = r.queryTimeout as number
  if (ROW_CAPS.includes(r.maxRows as number)) out.maxRows = r.maxRows as number
  if (typeof r.defaultConnection === 'string' && /^[\w-]{1,64}$/.test(r.defaultConnection)) out.defaultConnection = r.defaultConnection
  return out
}

const quoteFont = (name: string): string => `"${name.replace(/"/g, '')}"`

/**
 * The CSS custom properties an appearance sets on <html>. Values it doesn't set are left to the
 * stylesheet (so the theme's own accent and fonts apply). `dark`: whether the theme is dark, which
 * decides how strongly the accent tints selections.
 */
export function appearanceVars(a: Appearance, dark: boolean): Record<string, string> {
  const vars: Record<string, string> = {}
  if (a.accent) {
    vars['--accent'] = a.accent
    vars['--accent-soft'] = `color-mix(in srgb, ${a.accent} ${dark ? 16 : 10}%, transparent)`
    vars['--selected'] = `color-mix(in srgb, ${a.accent} ${dark ? 22 : 14}%, transparent)`
  }
  for (const [tag, color] of Object.entries(a.env ?? {})) vars[`--env-${tag}`] = color
  if (a.uiFont) vars['--sans'] = `${quoteFont(a.uiFont)}, 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif`
  if (a.codeFont) vars['--mono'] = `${quoteFont(a.codeFont)}, 'Cascadia Mono', Consolas, monospace`
  const size = a.codeSize ?? CODE_SIZES.default
  vars['--code-size'] = `${size}px`
  vars['--grid-size'] = `${size - 1}px`
  vars['--mono-ligatures'] = a.ligatures ? 'normal' : 'none'
  vars['--row-height'] = `${ROW_HEIGHTS[a.density ?? 'comfortable']}px`
  if (a.noStripes) vars['--stripe'] = 'transparent'
  return vars
}

/** Black or white, whichever reads better on `hex` (for text on accent-coloured buttons). */
export function textOn(hex: string): '#000' | '#fff' {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance > 0.45 ? '#000' : '#fff'
}
