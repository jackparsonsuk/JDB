import { useMemo, useState } from 'react'
import type { ConnectionConfig, SavedQuery } from '@shared/types'
import { useAppState } from '../state'

/**
 * Names a query to keep: its folder, whether it belongs to this connection or suits any (a
 * snippet), and a note. For a query already saved it edits those details, or saves a copy.
 */
export function SaveQueryDialog({ connection, sql, existing, onSaved, onClose }: {
  connection: ConnectionConfig
  sql: string
  existing?: SavedQuery
  onSaved(saved: SavedQuery): void
  onClose(): void
}) {
  const { savedQueries, saveQuery } = useAppState()
  const [name, setName] = useState(existing?.name ?? suggestName(sql))
  const [folder, setFolder] = useState(existing?.folder ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [anyConnection, setAnyConnection] = useState(existing ? !existing.connectionId : false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const folders = useMemo(() => [...new Set(savedQueries.map((q) => q.folder).filter((f): f is string => !!f))].sort(), [savedQueries])
  const clash = savedQueries.find((q) => q.id !== existing?.id && q.name.trim().toLowerCase() === name.trim().toLowerCase() && (q.folder ?? '') === folder.trim())

  const save = async (asNew: boolean): Promise<void> => {
    if (!name.trim()) {
      setError('Give it a name.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const saved = await saveQuery({
        ...(existing && !asNew && { id: existing.id }),
        name,
        folder,
        description,
        sql,
        ...(!anyConnection && { connectionId: connection.id })
      })
      onSaved(saved)
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={() => !saving && onClose()}>
      <div
        className="dialog save-query"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !saving) onClose()
          if (e.key === 'Enter' && (e.ctrlKey || !(e.target instanceof HTMLTextAreaElement))) {
            e.preventDefault()
            save(false)
          }
        }}
      >
        <h2>{existing ? 'Saved query details' : 'Save query'}</h2>
        <div className="form">
          <label>
            Name
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onFocus={(e) => e.currentTarget.select()} placeholder="e.g. Open jobs for a customer" />
          </label>
          <label>
            Folder
            <input list="saved-query-folders" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="none" />
            <datalist id="saved-query-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
          </label>
          <div className="choice-row" role="radiogroup" aria-label="Where it runs">
            <button role="radio" aria-checked={!anyConnection} className={`choice ${!anyConnection ? 'on' : ''}`} onClick={() => setAnyConnection(false)}>
              <span className="choice-title"><span className={`env-dot env-${connection.env}`} />{connection.name} only</span>
              <span className="choice-note">Opens on this connection</span>
            </button>
            <button role="radio" aria-checked={anyConnection} className={`choice ${anyConnection ? 'on' : ''}`} onClick={() => setAnyConnection(true)}>
              <span className="choice-title">Any connection</span>
              <span className="choice-note">A snippet: opens where you are, and autocompletes by name in any query</span>
            </button>
          </div>
          <label>
            <span>Note <span className="optional">optional</span></span>
            <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it's for, what to change before running it…" />
          </label>
        </div>
        {clash && <div className="status busy">There's already a query called “{clash.name}”{clash.folder ? ` in ${clash.folder}` : ''}. Both will be kept.</div>}
        {error && <div className="status error">{error}</div>}
        <div className="dialog-actions">
          <button className="primary" disabled={saving} onClick={() => save(false)}>{existing ? 'Save changes' : 'Save'}</button>
          {existing && <button disabled={saving} onClick={() => save(true)} title="Keep the original and save this as a new query">Save as new</button>}
          <button className="ghost" disabled={saving} onClick={onClose} style={{ marginLeft: 'auto' }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

/** A starting name from the SQL: the first comment, or the statement's verb and first table. */
function suggestName(sql: string): string {
  const comment = /^\s*--\s*(.+)$/m.exec(sql)?.[1]?.trim()
  if (comment && comment.length <= 60) return comment
  const from = /\b(from|update|into)\s+([\w.[\]`"]+)/i.exec(sql)
  const verb = /^\s*(\w+)/.exec(sql.replace(/^\s*--.*$/gm, ''))?.[1]
  if (verb && from) return `${verb[0].toUpperCase()}${verb.slice(1).toLowerCase()} ${from[2].replace(/[[\]`"]/g, '')}`
  return ''
}
