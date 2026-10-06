import { useEffect, useState } from 'react'
import type { EnvTag } from '@shared/types'
import { formatCount, formatDuration } from '../lib/format'
import { stagedChanges, type StagedTransaction } from '../lib/useTransaction'

/** Past this, the bar warns that the transaction's locks may be blocking other people. */
const LONG_OPEN_MS = 60_000

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** Shows an open transaction's staged statements, with Commit and Roll back. */
export function TransactionBar({ tx, env, busy, onCommit, onRollback, onPick }: {
  tx: StagedTransaction
  env: EnvTag
  /** A query is running in the transaction, so it can't be ended yet. */
  busy: boolean
  onCommit(): void
  onRollback(): void
  onPick(sql: string): void
}) {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const open = now - tx.startedAt
  const { statements, rows } = stagedChanges(tx)
  const long = open > LONG_OPEN_MS

  return (
    <div className={`tx-bar env-${env}`}>
      <div className="tx-head">
        <span className="tx-dot" />
        <strong>Transaction open</strong>
        <span className="muted">
          {elapsed(open)} · {statements} change{statements === 1 ? '' : 's'} · {formatCount(rows)} row{rows === 1 ? '' : 's'} affected
        </span>
        {tx.runs.length > 0 && (
          <button className="ghost" onClick={() => setExpanded((e) => !e)}>
            {expanded ? 'Hide' : 'Show'} {tx.runs.length} run{tx.runs.length === 1 ? '' : 's'}
          </button>
        )}
        <span className={`tx-note ${long ? 'warn' : ''}`}>
          {long ? 'Rows it changed stay locked until you commit or roll back' : 'Nothing is kept until you commit'}
        </span>
        <div className="toolbar-right">
          <button disabled={busy} title={busy ? 'Wait for the query to finish, or cancel it' : 'Undo everything run since the transaction began'} onClick={onRollback}>
            Roll back
          </button>
          <button className="primary" disabled={busy} title={busy ? 'Wait for the query to finish, or cancel it' : 'Keep the changes'} onClick={onCommit}>
            Commit
          </button>
        </div>
      </div>
      {expanded && (
        <ol className="tx-runs">
          {tx.runs.map((run, i) => (
            <li key={i} className={run.error ? 'failed' : ''} title={run.error}>
              <button className="tx-run" onClick={() => onPick(run.sql)} title="Put this back in the editor">
                <code>{run.sql.length > 400 ? `${run.sql.slice(0, 400)}…` : run.sql}</code>
              </button>
              <span className="muted">
                {run.error ? 'failed' : run.write ? `${formatCount(run.rowsAffected)} row${run.rowsAffected === 1 ? '' : 's'}` : 'read'} · {formatDuration(run.durationMs)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
