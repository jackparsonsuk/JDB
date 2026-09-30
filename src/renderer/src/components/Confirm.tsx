import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'

/** A question JDB asks in its own styled dialog, instead of the browser's plain confirm box. */
export interface ConfirmOptions {
  title: string
  message?: ReactNode
  /** Items listed under the message, e.g. the tabs that would lose work. */
  items?: string[]
  confirmLabel: string
  cancelLabel?: string
  /** danger: deleting or discarding; warning: something to think twice about; default otherwise. */
  tone?: 'danger' | 'warning' | 'default'
}

interface Pending extends ConfirmOptions {
  resolve(ok: boolean): void
}

let pending: Pending | null = null
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())

/** Asks, and resolves true when confirmed. A second question waits until the first is answered. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const ask = (): void => {
      pending = { ...options, resolve }
      emit()
    }
    if (!pending) ask()
    else queue.push(ask)
  })
}

const queue: (() => void)[] = []

function answer(ok: boolean): void {
  const current = pending
  pending = null
  current?.resolve(ok)
  const next = queue.shift()
  if (next) next()
  else emit()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const ICONS = { danger: '!', warning: '!', default: '?' }

/** Mounted once in App; shows whichever question is waiting. */
export function ConfirmHost() {
  const current = useSyncExternalStore(subscribe, () => pending)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const tone = current?.tone ?? 'default'

  useEffect(() => {
    if (!current) return
    // Destructive questions start on Cancel, so Enter doesn't delete anything by accident.
    ;(tone === 'default' ? okRef : cancelRef).current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        answer(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, tone])

  if (!current) return null
  return (
    <div className="overlay confirm-overlay" onMouseDown={() => answer(false)}>
      <div className={`dialog confirm tone-${tone}`} role="alertdialog" aria-labelledby="confirm-title" onMouseDown={(e) => e.stopPropagation()}>
        <div className="confirm-head">
          <span className="confirm-icon" aria-hidden>{ICONS[tone]}</span>
          <h2 id="confirm-title">{current.title}</h2>
        </div>
        {current.message && <div className="confirm-message">{current.message}</div>}
        {current.items && current.items.length > 0 && (
          <ul className="confirm-items">{current.items.map((item, i) => <li key={i}>{item}</li>)}</ul>
        )}
        <div className="dialog-actions confirm-actions">
          <button ref={cancelRef} onClick={() => answer(false)}>{current.cancelLabel ?? 'Cancel'}</button>
          <button ref={okRef} className={`primary ${tone === 'danger' ? 'danger-solid' : tone === 'warning' ? 'warn-solid' : ''}`} onClick={() => answer(true)}>
            {current.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
