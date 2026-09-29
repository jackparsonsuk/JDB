import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** One run inside a staged transaction, listed so it's clear what a commit would keep. */
export interface StagedRun {
  sql: string
  /** Whether it contained a write; reads are listed but don't count as changes. */
  write: boolean
  rowsAffected: number
  durationMs: number
  error?: string
}

export interface StagedTransaction {
  id: string
  startedAt: number
  runs: StagedRun[]
}

/**
 * A query tab's staged transaction. The server holds it (and its locks) on a connection of its
 * own until commit or rollback; closing the tab rolls it back.
 */
export function useTransaction(connectionId: string) {
  const [tx, setTx] = useState<StagedTransaction | null>(null)
  /** Read by callbacks that run before the state update lands. */
  const idRef = useRef<string | null>(null)

  const forget = useCallback(() => {
    idRef.current = null
    setTx(null)
  }, [])

  const begin = useCallback(async (): Promise<string> => {
    const id = await window.api.beginTransaction(connectionId)
    idRef.current = id
    setTx({ id, startedAt: Date.now(), runs: [] })
    return id
  }, [connectionId])

  // The main process closes the transaction whether or not these succeed, so forget it either way.
  const commit = useCallback(async () => {
    const id = idRef.current
    if (!id) return
    try {
      await window.api.commitTransaction(id)
    } finally {
      forget()
    }
  }, [forget])

  const rollback = useCallback(async () => {
    const id = idRef.current
    if (!id) return
    try {
      await window.api.rollbackTransaction(id)
    } finally {
      forget()
    }
  }, [forget])

  const record = useCallback((run: StagedRun) => {
    setTx((t) => t && { ...t, runs: [...t.runs, run] })
  }, [])

  /** After a failed run: false (and forgotten) if the server rolled the transaction back. */
  const stillOpen = useCallback(async (): Promise<boolean> => {
    const id = idRef.current
    if (!id) return false
    const open = await window.api.transactionOpen(id).catch(() => false)
    if (!open) forget()
    return open
  }, [forget])

  useEffect(() => () => {
    if (idRef.current) window.api.rollbackTransaction(idRef.current).catch(() => undefined)
  }, [])

  // Stable between renders so callers can list it as a dependency.
  return useMemo(() => ({ tx, idRef, begin, commit, rollback, record, stillOpen }), [tx, begin, commit, rollback, record, stillOpen])
}

export const stagedChanges = (tx: StagedTransaction): { statements: number; rows: number } => {
  const writes = tx.runs.filter((r) => r.write && !r.error)
  return { statements: writes.length, rows: writes.reduce((n, r) => n + r.rowsAffected, 0) }
}
