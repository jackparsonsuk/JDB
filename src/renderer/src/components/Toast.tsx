import { useEffect, useState } from 'react'

export interface ToastAction {
  label: string
  run(): void
}

type Listener = (message: string, isError: boolean, action?: ToastAction) => void
let listener: Listener | null = null

/** Fire-and-forget notification, callable from anywhere; an action adds a button and keeps it up longer. */
export function toast(message: string, isError = false, action?: ToastAction): void {
  listener?.(message, isError, action)
}

export function ToastHost() {
  const [items, setItems] = useState<{ id: number; message: string; isError: boolean; action?: ToastAction }[]>([])

  useEffect(() => {
    let id = 0
    listener = (message, isError, action) => {
      const item = { id: ++id, message, isError, action }
      setItems((prev) => [...prev.slice(-3), item])
      setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== item.id)), isError || action ? 6000 : 2200)
    }
    return () => {
      listener = null
    }
  }, [])

  return (
    <div className="toasts">
      {items.map((item) => (
        <div key={item.id} className={`toast ${item.isError ? 'error' : ''}`}>
          {item.message}
          {item.action && (
            <button
              className="ghost toast-action"
              onClick={() => {
                item.action!.run()
                setItems((prev) => prev.filter((i) => i.id !== item.id))
              }}
            >
              {item.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
