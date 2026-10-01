import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ThemeSetting } from '@shared/types'
import { ACCENT_PRESETS, CODE_SIZES, DATE_FORMATS, DENSITIES, NULL_TEXTS, QUERY_TIMEOUTS, ROW_CAPS, UI_SCALES, type Appearance, type DateFormat, type Density, type NullText } from '@shared/appearance'
import { formatCell } from '@shared/cellFormat'
import { useAppState } from '../state'
import { APP_NAME } from '@shared/brand'
import { resetAppearance, updateAppearance, useAppearance } from '../lib/appearance'
import { setTheme, THEME_LABELS, THEMES, useTheme } from '../lib/theme'
import { CODE_FONTS, isInstalled, UI_FONTS } from '../lib/fonts'
import { EnvironmentSettings } from './EnvironmentSettings'

type Section = 'theme' | 'env' | 'fonts' | 'grid' | 'editor' | 'queries'

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'theme', label: 'Theme & colours', icon: '◐' },
  { id: 'env', label: 'Environments', icon: '●' },
  { id: 'fonts', label: 'Fonts & size', icon: 'Aa' },
  { id: 'grid', label: 'Grid & values', icon: '▦' },
  { id: 'editor', label: 'SQL editor', icon: '⌨' },
  { id: 'queries', label: 'Queries & startup', icon: '⏱' }
]

/** Every stored setting, for Reset everything. */
const ALL_KEYS: (keyof Appearance)[] = [
  'accent', 'env', 'uiFont', 'uiScale', 'codeFont', 'codeSize', 'ligatures', 'density', 'wordWrap', 'tabSize',
  'dateFormat', 'hideFractions', 'localTime', 'nullText', 'thousands', 'hideLookupLabels',
  'ctrlEnter', 'lowerKeywords', 'hideRunGutter', 'hideRunNotes', 'completeOnRequest',
  'queryTimeout', 'maxRows', 'freshStart', 'defaultConnection'
]

/** Colours each theme card previews: background, panel, text, and a border. */
const THEME_PREVIEW: Record<Exclude<ThemeSetting, 'system'>, [string, string, string, string]> = {
  light: ['#ffffff', '#f6f7f9', '#1f2328', '#d9dde3'],
  dark: ['#15171c', '#1b1e24', '#d8dbe0', '#2e333c'],
  dim: ['#1f2430', '#252b38', '#cdd3de', '#3a4254'],
  midnight: ['#050608', '#0b0d11', '#d6dae1', '#20252e'],
  contrast: ['#000000', '#0a0a0a', '#ffffff', '#8a8a8a'],
  gruvbox: ['#282828', '#32302f', '#ebdbb2', '#504945']
}

const DENSITY_LABELS: Record<Density, string> = { compact: 'Compact', comfortable: 'Comfortable', spacious: 'Spacious' }
const SAMPLE_SQL = "SELECT o.Id, o.Total >= 100 AS Big\nFROM dbo.Orders o -- 0Oo 1lI\nWHERE o.Status != 'closed'"

/** Colours, fonts and sizes, applied as they're changed. */
export function SettingsDialog({ onClose }: { onClose(): void }) {
  const [section, setSection] = useState<Section>('theme')
  const theme = useTheme()
  const a = useAppearance()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog settings" role="dialog" aria-label="Settings" onMouseDown={(e) => e.stopPropagation()}>
        <nav className="settings-nav">
          <h2>Settings</h2>
          {SECTIONS.map((s) => (
            <button key={s.id} className={section === s.id ? 'on' : ''} onClick={() => setSection(s.id)}>
              <span className="settings-nav-icon">{s.icon}</span>{s.label}
            </button>
          ))}
          <div className="settings-nav-foot muted">Changes apply straight away and are kept for next time.</div>
        </nav>
        <div className="settings-body">
          {section === 'theme' && <ThemeSection theme={theme} a={a} />}
          {section === 'env' && <EnvironmentSettings a={a} />}
          {section === 'fonts' && <FontSection a={a} />}
          {section === 'grid' && <GridSection a={a} />}
          {section === 'editor' && <EditorSection a={a} />}
          {section === 'queries' && <QueriesSection a={a} />}
          <div className="settings-actions">
            <button className="ghost" onClick={() => { setTheme('system'); resetAppearance(ALL_KEYS) }}>
              Reset everything
            </button>
            <button className="primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Group({ title, note, onReset, children }: { title: string; note?: string; onReset?: () => void; children: ReactNode }) {
  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <h3>{title}</h3>
        {onReset && <button className="linkish" onClick={onReset}>Reset</button>}
      </div>
      {note && <p className="settings-note">{note}</p>}
      {children}
    </section>
  )
}

function ThemeSection({ theme, a }: { theme: ThemeSetting; a: Appearance }) {
  return (
    <>
      <Group title="Theme" onReset={theme === 'system' ? undefined : () => setTheme('system')}>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button key={t} className={`theme-card ${theme === t ? 'on' : ''}`} onClick={() => setTheme(t)} aria-pressed={theme === t}>
              <ThemeThumb theme={t} accent={a.accent} />
              <span className="theme-card-name">{THEME_LABELS[t]}</span>
              {t === 'system' && <span className="theme-card-note">Follows Windows</span>}
            </button>
          ))}
        </div>
      </Group>
      <Group title="Accent colour" note="Buttons, selections, links and focus rings." onReset={a.accent ? () => updateAppearance({ accent: undefined }) : undefined}>
        <div className="swatches">
          <button className={`swatch default ${!a.accent ? 'on' : ''}`} onClick={() => updateAppearance({ accent: undefined })} title="The theme's own accent">
            <span className="swatch-dot" />Theme
          </button>
          {ACCENT_PRESETS.map((p) => (
            <button key={p.color} className={`swatch ${a.accent === p.color ? 'on' : ''}`} onClick={() => updateAppearance({ accent: p.color })} title={p.name}>
              <span className="swatch-dot" style={{ background: p.color }} />{p.name}
            </button>
          ))}
          <label className={`swatch custom ${a.accent && !ACCENT_PRESETS.some((p) => p.color === a.accent) ? 'on' : ''}`} title="Pick any colour">
            <span className="swatch-dot" style={{ background: a.accent && !ACCENT_PRESETS.some((p) => p.color === a.accent) ? a.accent : 'conic-gradient(#f85149, #d29922, #3fb950, #4c8dff, #a371f7, #f85149)' }} />
            Custom…
            <input type="color" value={a.accent ?? '#4c8dff'} onChange={(e) => updateAppearance({ accent: e.target.value })} />
          </label>
        </div>
        <div className="accent-preview">
          <button className="primary">Primary button</button>
          <span className="chip">A filter chip</span>
          <span className="accent-link">A link</span>
          <span className="accent-selected">A selected row</span>
        </div>
      </Group>
    </>
  )
}

function ThemeThumb({ theme, accent }: { theme: ThemeSetting; accent?: string }) {
  if (theme === 'system') {
    return (
      <span className="theme-thumb split">
        <ThemeThumb theme="light" accent={accent} />
        <ThemeThumb theme="dark" accent={accent} />
      </span>
    )
  }
  const [bg, panel, text, border] = THEME_PREVIEW[theme]
  const dot = accent ?? (theme === 'light' ? '#0969da' : theme === 'contrast' ? '#6cb6ff' : theme === 'gruvbox' ? '#d65d0e' : '#4c8dff')
  return (
    <span className="theme-thumb" style={{ background: bg, borderColor: border }}>
      <span className="thumb-side" style={{ background: panel, borderColor: border }}>
        <span className="thumb-line" style={{ background: text, opacity: 0.6 }} />
        <span className="thumb-line short" style={{ background: text, opacity: 0.35 }} />
        <span className="thumb-line" style={{ background: text, opacity: 0.35 }} />
      </span>
      <span className="thumb-main">
        <span className="thumb-bar" style={{ background: dot }} />
        <span className="thumb-line" style={{ background: text, opacity: 0.5 }} />
        <span className="thumb-line short" style={{ background: text, opacity: 0.3 }} />
      </span>
    </span>
  )
}

function FontSection({ a }: { a: Appearance }) {
  // Measured once: whether each listed font is installed on this PC.
  // The defaults are the first entry already ("Segoe UI (default)"), so they aren't listed again.
  const uiFonts = useMemo(() => UI_FONTS.filter((f) => !f.startsWith('Segoe UI') && isInstalled(f)), [])
  const codeFonts = useMemo(() => CODE_FONTS.filter((f) => f.name !== 'Cascadia Mono' && isInstalled(f.name)), [])
  const codeFont = CODE_FONTS.find((f) => f.name === (a.codeFont ?? 'Cascadia Mono'))
  return (
    <>
      <Group title="Interface size" note="Scales everything: text, buttons, the grid and the editor." onReset={a.uiScale ? () => updateAppearance({ uiScale: undefined }) : undefined}>
        <div className="segmented">
          {UI_SCALES.map((s) => (
            <button key={s} className={(a.uiScale ?? 1) === s ? 'on' : ''} onClick={() => updateAppearance({ uiScale: s === 1 ? undefined : s })}>
              {Math.round(s * 100)}%
            </button>
          ))}
        </div>
      </Group>
      <Group title="Interface font" onReset={a.uiFont ? () => updateAppearance({ uiFont: undefined }) : undefined}>
        <FontPicker value={a.uiFont} fallback="Segoe UI (default)" options={uiFonts} onChange={(uiFont) => updateAppearance({ uiFont })} />
      </Group>
      <Group title="Code font" note="The SQL editor, routine source and the grid." onReset={a.codeFont || a.codeSize || a.ligatures ? () => resetAppearance(['codeFont', 'codeSize', 'ligatures']) : undefined}>
        <FontPicker value={a.codeFont} fallback="Cascadia Mono (default)" options={codeFonts.map((f) => f.name)} onChange={(codeFont) => updateAppearance({ codeFont })} />
        <div className="settings-row">
          <span className="settings-label">Size</span>
          <input
            type="range"
            min={CODE_SIZES.min}
            max={CODE_SIZES.max}
            value={a.codeSize ?? CODE_SIZES.default}
            onChange={(e) => {
              const size = Number(e.target.value)
              updateAppearance({ codeSize: size === CODE_SIZES.default ? undefined : size })
            }}
          />
          <span className="settings-value">{a.codeSize ?? CODE_SIZES.default}px</span>
        </div>
        <label className="toggle">
          <input type="checkbox" checked={!!a.ligatures} onChange={(e) => updateAppearance({ ligatures: e.target.checked || undefined })} />
          <span className="toggle-track"><span className="toggle-thumb" /></span>
          Ligatures
          <span className="muted">{codeFont?.ligatures ? '(joins >= != => into single symbols)' : '(this font has none; try Cascadia Code, JetBrains Mono or Fira Code)'}</span>
        </label>
        <pre className="font-sample">{SAMPLE_SQL}</pre>
      </Group>
    </>
  )
}

/** A font list with the installed options, the default, and a box for any other font name. */
function FontPicker({ value, fallback, options, onChange }: { value?: string; fallback: string; options: string[]; onChange(font: string | undefined): void }) {
  const custom = !!value && !options.includes(value)
  const [other, setOther] = useState(custom ? value : '')
  const [typing, setTyping] = useState(custom)
  return (
    <div className="font-picker">
      <select
        value={typing ? '__other' : value ?? ''}
        onChange={(e) => {
          if (e.target.value === '__other') {
            setTyping(true)
            return
          }
          setTyping(false)
          onChange(e.target.value || undefined)
        }}
      >
        <option value="">{fallback}</option>
        {options.map((f) => <option key={f} value={f} style={{ fontFamily: `"${f}"` }}>{f}</option>)}
        <option value="__other">Another installed font…</option>
      </select>
      {typing && (
        <input
          autoFocus
          placeholder="Font name, e.g. Aptos Mono"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onChange(other.trim() || undefined)}
          onBlur={() => onChange(other.trim() || undefined)}
        />
      )}
      {typing && other.trim() && !isInstalled(other.trim()) && <span className="font-missing">Not found on this PC; the default is used instead.</span>}
    </div>
  )
}

function GridSection({ a }: { a: Appearance }) {
  return (
    <>
      <Group title="Row density" note="How tall rows are in tables and query results." onReset={a.density ? () => updateAppearance({ density: undefined }) : undefined}>
        <div className="density-options">
          {DENSITIES.map((d) => (
            <button key={d} className={`density ${(a.density ?? 'comfortable') === d ? 'on' : ''}`} onClick={() => updateAppearance({ density: d === 'comfortable' ? undefined : d })}>
              <span className={`density-rows ${d}`}><span /><span /><span /></span>
              {DENSITY_LABELS[d]}
            </button>
          ))}
        </div>
      </Group>
      <Group
        title="Dates and times"
        note="How the grid and row details show them. Copying, exporting, filtering and editing still use the value as stored."
        onReset={a.dateFormat || a.hideFractions || a.localTime ? () => resetAppearance(['dateFormat', 'hideFractions', 'localTime']) : undefined}
      >
        <div className="segmented">
          <button className={!a.dateFormat ? 'on' : ''} onClick={() => updateAppearance({ dateFormat: undefined })}>As stored</button>
          {DATE_FORMATS.map((f) => (
            <button key={f} className={a.dateFormat === f ? 'on' : ''} onClick={() => updateAppearance({ dateFormat: f })}>{DATE_LABELS[f]}</button>
          ))}
        </div>
        <Toggle on={!!a.hideFractions} onChange={(on) => updateAppearance({ hideFractions: on || undefined })} label="Hide fractions of a second" />
        <Toggle on={!!a.localTime} onChange={(on) => updateAppearance({ localTime: on || undefined })} label="Show times in this PC's time zone" note="(treats stored times as UTC; leave off for columns that already hold local time)" />
        <div className="settings-sample">
          <span className="muted">Example</span>
          <code>{formatCell(SAMPLE_DATE, 'CreatedOn', a)}</code>
        </div>
      </Group>
      <Group title="Empty values and numbers" onReset={a.nullText || a.thousands ? () => resetAppearance(['nullText', 'thousands']) : undefined}>
        <div className="settings-row">
          <span className="settings-label">NULL shows as</span>
          <div className="segmented">
            <button className={!a.nullText ? 'on' : ''} onClick={() => updateAppearance({ nullText: undefined })}>NULL</button>
            {NULL_TEXTS.map((n) => (
              <button key={n} className={a.nullText === n ? 'on' : ''} onClick={() => updateAppearance({ nullText: n })}>{NULL_LABELS[n]}</button>
            ))}
          </div>
        </div>
        <Toggle on={!!a.thousands} onChange={(on) => updateAppearance({ thousands: on || undefined })} label="Thousands separators" note="(1,227,695; not in columns ending Id, No, Code, Year…)" />
      </Group>
      <Group title="Lookups" onReset={a.hideLookupLabels ? () => updateAppearance({ hideLookupLabels: undefined }) : undefined}>
        <Toggle on={!a.hideLookupLabels} onChange={(on) => updateAppearance({ hideLookupLabels: on ? undefined : true })} label="Show labels beside lookup keys" note="(e.g. Draft beside an OrderStatusId; the key itself is unchanged)" />
      </Group>
      <p className="settings-note about">{APP_NAME} keeps these settings on this PC only; they aren't included when you share connections.</p>
    </>
  )
}

const DATE_LABELS: Record<DateFormat, string> = { iso: '2026-06-15', uk: '15/06/2026', us: '06/15/2026', long: '15 Jun 2026' }
const NULL_LABELS: Record<NullText, string> = { blank: 'Blank', symbol: '∅', paren: '(null)' }
const SAMPLE_DATE = '2026-06-15T09:07:47.890Z'

function Toggle({ on, onChange, label, note }: { on: boolean; onChange(on: boolean): void; label: string; note?: string }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track"><span className="toggle-thumb" /></span>
      {label}
      {note && <span className="muted">{note}</span>}
    </label>
  )
}

function EditorSection({ a }: { a: Appearance }) {
  return (
    <>
      <Group title="Running" onReset={a.ctrlEnter ? () => updateAppearance({ ctrlEnter: undefined }) : undefined}>
        <div className="settings-row">
          <span className="settings-label">Ctrl+Enter runs</span>
          <div className="segmented">
            <button className={!a.ctrlEnter ? 'on' : ''} onClick={() => updateAppearance({ ctrlEnter: undefined })}>The statement at the cursor</button>
            <button className={a.ctrlEnter === 'all' ? 'on' : ''} onClick={() => updateAppearance({ ctrlEnter: 'all' })}>Everything (like SSMS)</button>
          </div>
        </div>
        <p className="settings-note">
          {a.ctrlEnter === 'all'
            ? 'Ctrl+Enter runs the selection or the whole editor; Ctrl+Shift+Enter runs the statement at the cursor.'
            : 'Ctrl+Enter runs the selection or the statement at the cursor; Ctrl+Shift+Enter runs the whole editor.'}
        </p>
      </Group>
      <Group title="Run gutter" note="The ▶ beside each statement, and the ✓ / ✕ note after it runs." onReset={a.hideRunGutter || a.hideRunNotes ? () => resetAppearance(['hideRunGutter', 'hideRunNotes']) : undefined}>
        <Toggle on={!a.hideRunGutter} onChange={(on) => updateAppearance({ hideRunGutter: on ? undefined : true })} label="Show ▶ run buttons" />
        <Toggle on={!a.hideRunNotes} onChange={(on) => updateAppearance({ hideRunNotes: on ? undefined : true })} label="Show how each statement went" note="(✓ 1,204 rows · 85 ms)" />
      </Group>
      <Group title="Typing" onReset={a.lowerKeywords || a.completeOnRequest || a.wordWrap === false || a.tabSize ? () => resetAppearance(['lowerKeywords', 'completeOnRequest', 'wordWrap', 'tabSize']) : undefined}>
        <div className="settings-row">
          <span className="settings-label">Keywords</span>
          <div className="segmented">
            <button className={!a.lowerKeywords ? 'on' : ''} onClick={() => updateAppearance({ lowerKeywords: undefined })}>SELECT</button>
            <button className={a.lowerKeywords ? 'on' : ''} onClick={() => updateAppearance({ lowerKeywords: true })}>select</button>
          </div>
          <span className="muted">in suggestions and Shift+Alt+F formatting</span>
        </div>
        <Toggle on={!a.completeOnRequest} onChange={(on) => updateAppearance({ completeOnRequest: on ? undefined : true })} label="Suggest while typing" note="(off: only on Ctrl+Space)" />
        {/* Wrapping is on unless switched off, so only "off" is stored. */}
        <Toggle on={a.wordWrap !== false} onChange={(on) => updateAppearance({ wordWrap: on ? undefined : false })} label="Wrap long lines" />
        <div className="settings-row">
          <span className="settings-label">Indent</span>
          <div className="segmented">
            <button className={!a.tabSize ? 'on' : ''} onClick={() => updateAppearance({ tabSize: undefined })}>Default</button>
            <button className={a.tabSize === 2 ? 'on' : ''} onClick={() => updateAppearance({ tabSize: 2 })}>2 spaces</button>
            <button className={a.tabSize === 4 ? 'on' : ''} onClick={() => updateAppearance({ tabSize: 4 })}>4 spaces</button>
          </div>
        </div>
      </Group>
    </>
  )
}

function QueriesSection({ a }: { a: Appearance }) {
  const { connections } = useAppState()
  return (
    <>
      <Group title="Limits" note="For query tabs. Tables already page through their rows." onReset={a.queryTimeout || a.maxRows ? () => resetAppearance(['queryTimeout', 'maxRows']) : undefined}>
        <div className="settings-row">
          <span className="settings-label">Stop queries after</span>
          <select value={a.queryTimeout ?? ''} onChange={(e) => updateAppearance({ queryTimeout: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">No limit</option>
            {QUERY_TIMEOUTS.map((s) => <option key={s} value={s}>{s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`}</option>)}
          </select>
        </div>
        <div className="settings-row">
          <span className="settings-label">Keep at most</span>
          <select value={a.maxRows ?? ''} onChange={(e) => updateAppearance({ maxRows: e.target.value ? Number(e.target.value) : undefined })}>
            <option value="">All rows</option>
            {ROW_CAPS.map((n) => <option key={n} value={n}>{n.toLocaleString()} rows</option>)}
          </select>
          <span className="muted">per result</span>
        </div>
        <p className="settings-note">The row limit stops a huge result flooding the window; the server still sends every row, so add a WHERE or TOP / LIMIT for big tables.</p>
      </Group>
      <Group title="Startup" onReset={a.freshStart || a.defaultConnection ? () => resetAppearance(['freshStart', 'defaultConnection']) : undefined}>
        <Toggle on={!a.freshStart} onChange={(on) => updateAppearance({ freshStart: on ? undefined : true })} label="Reopen last session's tabs" />
        <div className="settings-row">
          <span className="settings-label">Ctrl+T with no tab open</span>
          <select value={a.defaultConnection ?? ''} onChange={(e) => updateAppearance({ defaultConnection: e.target.value || undefined })}>
            <option value="">The first connection</option>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </Group>
    </>
  )
}
