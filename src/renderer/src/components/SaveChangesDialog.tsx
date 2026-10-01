import { useMemo, useState } from 'react'
import { layoutSql } from '@shared/sqlLayout'
import { SqlPreview } from './SqlPreview'
import { useAppearance } from '../lib/appearance'
import type { ConnectionConfig } from '@shared/types'
import { toast } from './Toast'
import { useAppState } from '../state'

/** How the grid's edits are saved; the designer passes its own. */
const GRID_NOTE = 'These run in one transaction. If any of them fails or matches anything other than exactly one row, nothing is saved.'

/** Shows the SQL for staged changes, then runs it (by default as the grid's all-or-nothing save). */
export function SaveChangesDialog({ connection, statements, onClose, onSaved, onOpenSql, noun = 'change', note = GRID_NOTE, run }: {
  connection: ConnectionConfig
  statements: string[]
  /** What's being saved, for the title: "Save 3 changes". */
  noun?: string
  /** How the statements run and what happens on failure. */
  note?: string
  run?(statements: string[]): Promise<number>
  onClose(): void
  onSaved(count: number): void
  /** Opens the statements in a query tab instead, e.g. to run them in a staged transaction. */
  onOpenSql(sql: string): void
}) {
  const { environment, safety } = useAppState()
  const { lowerKeywords } = useAppearance()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Each statement laid out like a query, with a blank line between them. What runs is the statements as given.
  const sql = useMemo(() => statements.map((s) => {
    const layout = layoutSql(s, connection.kind, true, !!lowerKeywords)
    return layout.formatted ? layout.text.trim() : s
  }).join('\n\n'), [statements, connection.kind, lowerKeywords])
  const n = statements.length

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      onSaved(await (run ? run(statements) : window.api.applyChanges(connection.id, statements)))
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={() => !saving && onClose()}>
      <div className="dialog save-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && !saving && onClose()}>
        <h2>
          Save {n} {noun}{n === 1 ? '' : 's'} to{' '}
          <span className={`pill env-${connection.env}`}><span className="env-dot" />{connection.name}</span>{' '}
          <span className={`env-name env-${connection.env}`}>{environment(connection.env).name}</span>
        </h2>
        <p className="muted">{note}</p>
        <SqlPreview sql={sql} kind={connection.kind} />
        {error && <div className="status error">{error}</div>}
        <div className="dialog-actions">
          <button className={`primary ${safety(connection) === 'protected' ? 'prod' : ''}`} disabled={saving} onClick={save} autoFocus>
            {saving ? 'Saving…' : `Save to ${connection.name}`}
          </button>
          <button disabled={saving} onClick={() => onOpenSql(sql)} title="Open these statements in a query tab to run them yourself">
            Open as SQL
          </button>
          <button
            disabled={saving}
            onClick={() => {
              window.api.copy(sql)
              toast('Copied SQL')
            }}
          >
            Copy SQL
          </button>
          <button className="ghost" disabled={saving} onClick={onClose} style={{ marginLeft: 'auto' }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
