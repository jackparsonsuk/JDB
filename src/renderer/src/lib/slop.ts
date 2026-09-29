import { useSyncExternalStore } from 'react'

/**
 * Slop mode: an easter egg from the command palette that dresses the whole app up as an
 * over-the-top AI-generated UI. It is a `slop` class on <html> that the stylesheet reads, plus
 * `SlopLayer` for the floating extras. It lasts for the session only.
 */
let on = false
const listeners = new Set<() => void>()

export function toggleSlop(): boolean {
  on = !on
  document.documentElement.classList.toggle('slop', on)
  listeners.forEach((l) => l())
  return on
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSlop(): boolean {
  return useSyncExternalStore(subscribe, () => on)
}
