import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionConfig, WriteCount } from '@shared/types'
import { previewWrite } from '@shared/writePreview'
import { formatCount } from '../lib/format'
import { useAppState } from '../state'
import { SqlPreview } from './SqlPreview'

const VERBS = { update: 'update', delete: 'delete', insert: 'insert' } as const

/**
 * Asks before a write runs on a shared connection, saying how many rows it would touch: the
 * statement's own WHERE is counted first. Cancel has the focus, so a stray Enter never runs it.
 */
export function WriteConfirmDialog({ connection, sql, keyword, onRun, onCancel }: {
  connection: ConnectionConfig
  sql: string
  /** The write keyword the guard found, e.g. UPDATE. */
  keyword: string
  onRun(): void
  onCancel(): void
}) {
  const { environment, safety } = useAppState()
  const preview = useMemo(() => previewWrite(sql, connection.kind), [sql, connection.kind])
  const [count, setCount] = useState<WriteCount | null>(null)
  const [showSql, setShowSql] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if ('unsupported' in preview || !preview.countSql) return
    let live = true
    window.api.countForWrite(connection.id, preview.countSql).then(
      (c) => live && setCount(c),
      (e) => live && setCount({ status: 'failed', error: (e as Error).message })
    )
    return () => {
      live = false
    }
  }, [preview, connection.id])

  useEffect(() => {
    cancelRef.current?.focus()
  }, [])

  // The caller passes a new onCancel each render; a ref keeps the listener from being rebound.
  const cancel = useRef(onCancel)
  cancel.current = onCancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') cancel.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const known = 'unsupported' in preview ? null : preview
  const rows = known?.rows ?? (count?.status === 'counted' ? count.rows : null)
  const counting = !!known?.countSql && !count
  const big = rows !== null && rows >= 1000
  const none = rows === 0

  return (
    <div className="overlay" onMouseDown={onCancel}>
      <div className={`dialog write-confirm env-${connection.env}`} onMouseDown={(e) => e.stopPropagation()}>
        <h2>
          Run {keyword} on{' '}
          <span className={`pill env-${connection.env}`}><span className="env-dot" />{connection.name}</span>{' '}
          <span className={`env-name env-${connection.env}`}>{environment(connection.env).name}</span>
        </h2>

        <div className={`write-impact ${big || known?.noWhere ? 'warn' : ''} ${none ? 'none' : ''}`}>
          {!known && <span className="impact-text muted">{'unsupported' in preview ? preview.unsupported : ''}</span>}
          {known && (
            <>
              <span className="impact-number">
                {counting ? <span className="counting" aria-label="Counting" /> : rows !== null ? formatCount(rows) : '?'}
              </span>
              <span className="impact-text">
                {counting
                  ? `Counting the rows this would ${VERBS[known.verb]}…`
                  : rows !== null
                    ? <>row{rows === 1 ? '' : 's'} to {VERBS[known.verb]} in <strong>{known.target}</strong>{known.approximate && rows > 0 ? ' (joins can count a row more than once)' : ''}</>
                    : count?.status === 'timeout'
                      ? `Counting took over ${count.seconds} seconds, so it was stopped. The number of rows isn't known.`
                      : `Couldn't count the rows first: ${count?.status === 'failed' ? count.error : 'unknown error'}`}
              </span>
            </>
          )}
        </div>

        {known?.noWhere && known.verb !== 'insert' && (
          <div className="status error">There's no WHERE clause, so this {VERBS[known.verb]}s every row in {known.target}.</div>
        )}
        {none && <div className="status ok">Nothing matches, so running it changes no rows.</div>}

        <SqlPreview className="write-sql" sql={sql.trim()} kind={connection.kind} />
        {known?.countSql && (
          <button className="linkish" onClick={() => setShowSql((s) => !s)}>{showSql ? 'Hide' : 'Show'} how it was counted</button>
        )}
        {showSql && known?.countSql && <SqlPreview className="count-sql" sql={known.countSql} kind={connection.kind} />}

        <div className="dialog-actions">
          <button className={`primary ${safety(connection) === 'protected' || big || known?.noWhere ? 'prod' : ''}`} onClick={onRun}>
            {rows !== null && known ? `${known.verb[0].toUpperCase()}${known.verb.slice(1)} ${formatCount(rows)} row${rows === 1 ? '' : 's'}` : `Run ${keyword}`}
          </button>
          <button ref={cancelRef} onClick={onCancel} style={{ marginLeft: 'auto' }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
