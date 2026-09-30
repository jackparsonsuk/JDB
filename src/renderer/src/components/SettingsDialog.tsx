import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { EnvTag, ThemeSetting } from '@shared/types'
import { ACCENT_PRESETS, CODE_SIZES, DEFAULT_ENV_COLORS, DENSITIES, UI_SCALES, type Appearance, type Density } from '@shared/appearance'
import { APP_NAME } from '@shared/brand'
import { resetAppearance, updateAppearance, useAppearance } from '../lib/appearance'
import { setTheme, THEME_LABELS, THEMES, useTheme } from '../lib/theme'
import { CODE_FONTS, isInstalled, UI_FONTS } from '../lib/fonts'

type Section = 'theme' | 'env' | 'fonts' | 'grid'

const SECTIONS: { id: Section; label: string; icon: string }[] = [
  { id: 'theme', label: 'Theme & colours', icon: '◐' },
  { id: 'env', label: 'Environments', icon: '●' },
  { id: 'fonts', label: 'Fonts & size', icon: 'Aa' },
  { id: 'grid', label: 'Grid & editor', icon: '▦' }
]

/** Colours each theme card previews: background, panel, text, and a border. */
const THEME_PREVIEW: Record<Exclude<ThemeSetting, 'system'>, [string, string, string, string]> = {
  light: ['#ffffff', '#f6f7f9', '#1f2328', '#d9dde3'],
  dark: ['#15171c', '#1b1e24', '#d8dbe0', '#2e333c'],
  dim: ['#1f2430', '#252b38', '#cdd3de', '#3a4254'],
  midnight: ['#050608', '#0b0d11', '#d6dae1', '#20252e'],
  contrast: ['#000000', '#0a0a0a', '#ffffff', '#8a8a8a']
}

const ENV_LABELS: Record<EnvTag, string> = { local: 'Local', dev: 'Dev', test: 'Test', prod: 'Prod' }
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
          {section === 'env' && <EnvSection a={a} />}
          {section === 'fonts' && <FontSection a={a} />}
          {section === 'grid' && <GridSection a={a} />}
          <div className="settings-actions">
            <button className="ghost" onClick={() => { setTheme('system'); resetAppearance(['accent', 'env', 'uiFont', 'uiScale', 'codeFont', 'codeSize', 'ligatures', 'density', 'wordWrap', 'tabSize']) }}>
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
  const dot = accent ?? (theme === 'light' ? '#0969da' : theme === 'contrast' ? '#6cb6ff' : '#4c8dff')
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

function EnvSection({ a }: { a: Appearance }) {
  const set = (tag: EnvTag, color: string | undefined): void => {
    const env = { ...a.env }
    if (color && color !== DEFAULT_ENV_COLORS[tag]) env[tag] = color
    else delete env[tag]
    updateAppearance({ env: Object.keys(env).length ? env : undefined })
  }
  return (
    <Group
      title="Environment colours"
      note="Used on tabs, sidebar dots and the banner above each tab, so you can tell at a glance which database you're on. Prod is red by default; pick something unmistakable if you change it."
      onReset={a.env ? () => updateAppearance({ env: undefined }) : undefined}
    >
      <div className="env-rows">
        {(Object.keys(DEFAULT_ENV_COLORS) as EnvTag[]).map((tag) => {
          const color = a.env?.[tag] ?? DEFAULT_ENV_COLORS[tag]
          return (
            <div key={tag} className="env-row">
              <label className="color-well" title={`Pick the ${ENV_LABELS[tag]} colour`}>
                <span style={{ background: color }} />
                <input type="color" value={color} onChange={(e) => set(tag, e.target.value)} />
              </label>
              <span className="env-row-name">{ENV_LABELS[tag]}</span>
              <span className={`env-preview env-${tag}`}>
                <span className="env-dot" />
                <span>Orders {tag}</span>
                <span className="env-name">{tag}</span>
              </span>
              {a.env?.[tag] && <button className="linkish" onClick={() => set(tag, undefined)}>Default</button>}
            </div>
          )
        })}
      </div>
    </Group>
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
      <Group title="SQL editor" onReset={a.wordWrap || a.tabSize ? () => resetAppearance(['wordWrap', 'tabSize']) : undefined}>
        <label className="toggle">
          <input type="checkbox" checked={!!a.wordWrap} onChange={(e) => updateAppearance({ wordWrap: e.target.checked || undefined })} />
          <span className="toggle-track"><span className="toggle-thumb" /></span>
          Wrap long lines
        </label>
        <div className="settings-row">
          <span className="settings-label">Indent</span>
          <div className="segmented">
            <button className={!a.tabSize ? 'on' : ''} onClick={() => updateAppearance({ tabSize: undefined })}>Default</button>
            <button className={a.tabSize === 2 ? 'on' : ''} onClick={() => updateAppearance({ tabSize: 2 })}>2 spaces</button>
            <button className={a.tabSize === 4 ? 'on' : ''} onClick={() => updateAppearance({ tabSize: 4 })}>4 spaces</button>
          </div>
        </div>
      </Group>
      <p className="settings-note about">{APP_NAME} keeps these settings on this PC only; they aren't included when you share connections.</p>
    </>
  )
}
