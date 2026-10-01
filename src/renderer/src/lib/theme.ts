import { useSyncExternalStore } from 'react'
import type { ThemeSetting } from '@shared/types'

/**
 * The saved theme choice. It is applied straight away as `data-theme` on <html>, which the
 * stylesheet reads; the main process also sets nativeTheme (for the title bar and the next
 * launch), but its change reaches prefers-color-scheme too slowly to rely on for the switch.
 */
let current: ThemeSetting = 'system'
const listeners = new Set<() => void>()
const media = window.matchMedia('(prefers-color-scheme: dark)')

const notify = (): void => listeners.forEach((l) => l())

function apply(theme: ThemeSetting): void {
  current = theme
  if (theme === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
  notify()
}

window.api.getTheme().then(apply).catch(() => undefined)
media.addEventListener('change', notify)

export const THEME_LABELS: Record<ThemeSetting, string> = {
  system: 'System', light: 'Light', dark: 'Dark', dim: 'Dim', midnight: 'Midnight', contrast: 'High contrast', gruvbox: 'Gruvbox'
}
export const THEME_ICONS: Record<ThemeSetting, string> = { system: '◐', light: '☀', dark: '☾', dim: '◑', midnight: '●', contrast: '◧', gruvbox: '◒' }
/** The order themes are offered in. */
export const THEMES: ThemeSetting[] = ['system', 'light', 'dark', 'dim', 'midnight', 'gruvbox', 'contrast']

export function setTheme(theme: ThemeSetting): void {
  apply(theme)
  window.api.setTheme(theme).catch(() => undefined)
}

/** Whether what's shown is a dark theme, for code outside React. */
export const isDark = (): boolean => resolved() === 'dark'

export const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Light or dark as actually shown, with 'system' resolved. */
function resolved(): 'light' | 'dark' {
  if (current === 'system') return media.matches ? 'dark' : 'light'
  return current === 'light' ? 'light' : 'dark'
}

export function useTheme(): ThemeSetting {
  return useSyncExternalStore(subscribe, () => current)
}

export function useColorScheme(): 'light' | 'dark' {
  return useSyncExternalStore(subscribe, resolved)
}
