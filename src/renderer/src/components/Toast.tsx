import { useEffect, useState } from 'react'

type Listener = (message: string, isError: boolean) => void
let listener: Listener | null = null

/** Fire-and-forget notification, callable from anywhere. */
export function toast(message: string, isError = false): void {
  listener?.(message, isError)
}

export function ToastHost() {
  const [items, setItems] = useState<{ id: number; message: string; isError: boolean }[]>([])

  useEffect(() => {
    let id = 0
    listener = (message, isError) => {
      const item = { id: ++id, message, isError }
      setItems((prev) => [...prev.slice(-3), item])
      setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== item.id)), isError ? 6000 : 2200)
    }
    return () => {
      listener = null
    }
  }, [])

  return (
    <div className="toasts">
      {items.map((item) => (
        <div key={item.id} className={`toast ${item.isError ? 'error' : ''}`}>{item.message}</div>
      ))}
    </div>
  )
}
