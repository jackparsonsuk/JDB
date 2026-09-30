import { useSyncExternalStore } from 'react'
import { appearanceVars, ROW_HEIGHTS, type Appearance } from '@shared/appearance'
import { isDark, subscribe as onThemeChange } from './theme'

/**
 * Colours, fonts and sizes chosen in Settings. They're applied as CSS custom properties on <html>
 * (overriding the stylesheet's defaults) and as the window's zoom, and saved shortly after the
 * last change so dragging a colour picker doesn't write the file on every step.
 */
let current: Appearance = {}
let applied = new Set<string>()
const listeners = new Set<() => void>()
const SAVE_DELAY_MS = 400
let saveTimer: ReturnType<typeof setTimeout> | undefined

function apply(): void {
  const vars = appearanceVars(current, isDark())
  const style = document.documentElement.style
  // Clear what the last appearance set and this one doesn't, so resets fall back to the theme.
  for (const name of applied) if (!(name in vars)) style.removeProperty(name)
  for (const [name, value] of Object.entries(vars)) style.setProperty(name, value)
  applied = new Set(Object.keys(vars))
  window.api.setZoom(current.uiScale ?? 1).catch(() => undefined)
  listeners.forEach((l) => l())
}

window.api.getAppearance().then((a) => {
  current = a
  apply()
}, () => undefined)
// Accent tints differ between light and dark themes.
onThemeChange(apply)

/** Changes some settings; `undefined` for a key puts it back to its default. */
export function updateAppearance(patch: Partial<Appearance>): void {
  const next: Appearance = { ...current, ...patch }
  for (const key of Object.keys(patch) as (keyof Appearance)[]) if (patch[key] === undefined) delete next[key]
  current = next
  apply()
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    window.api.setAppearance(current).catch(() => undefined)
  }, SAVE_DELAY_MS)
}

export function resetAppearance(keys: (keyof Appearance)[]): void {
  updateAppearance(Object.fromEntries(keys.map((k) => [k, undefined])) as Partial<Appearance>)
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, () => current)
}

/** The grid's row height for the chosen density. */
export function useRowHeight(): number {
  return ROW_HEIGHTS[useAppearance().density ?? 'comfortable']
}
