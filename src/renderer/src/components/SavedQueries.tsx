import { useMemo, useState } from 'react'
import type { SavedQuery } from '@shared/types'
import { useAppState } from '../state'
import { fuzzyScore } from '../lib/fuzzy'
import { SaveQueryDialog } from './SaveQueryDialog'
import { toast } from './Toast'
import { confirm } from './Confirm'

const OPEN_KEY = 'jdb.sidebar.savedOpen'
const CLOSED_FOLDERS_KEY = 'jdb.sidebar.savedClosedFolders'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Only remembers what's expanded.
  }
}

/** The sidebar's saved queries, grouped by folder: click one to open it in a query tab. */
export function SavedQueries() {
  const { savedQueries, connections, activeTabId, tabs, openSaved, deleteQuery } = useAppState()
  const [open, setOpenState] = useState(() => read(OPEN_KEY) !== '0')
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(read(CLOSED_FOLDERS_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<SavedQuery | null>(null)

  const setOpen = (next: boolean): void => {
    setOpenState(next)
    write(OPEN_KEY, next ? '1' : '0')
  }
  const toggleFolder = (folder: string): void => {
    setClosed((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      write(CLOSED_FOLDERS_KEY, JSON.stringify([...next]))
      return next
    })
  }

  const connectionName = new Map(connections.map((c) => [c.id, c]))
  const activeConnection = tabs.find((t) => t.id === activeTabId)?.connectionId

  /** Where a query opens: its own connection, else the one in use, else the first. */
  const target = (q: SavedQuery): string | undefined =>
    (q.connectionId && connectionName.has(q.connectionId) ? q.connectionId : undefined) ?? activeConnection ?? connections[0]?.id

  const visible = useMemo(() => {
    const needle = filter.trim()
    const list = needle
      ? savedQueries
        .map((q) => ({ q, score: fuzzyScore(needle, `${q.folder ?? ''} ${q.name}`) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.q)
      : [...savedQueries].sort((a, b) => a.name.localeCompare(b.name))
    const groups = new Map<string, SavedQuery[]>()
    for (const q of list) {
      const key = q.folder ?? ''
      groups.set(key, [...(groups.get(key) ?? []), q])
    }
    // Loose queries first, then folders A–Z.
    return [...groups.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
  }, [savedQueries, filter])

  const remove = async (q: SavedQuery): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${q.name}?`,
      message: 'Tabs showing it keep their text, as ordinary queries.',
      confirmLabel: 'Delete query',
      tone: 'danger'
    })
    if (!ok) return
    try {
      await deleteQuery(q.id)
      toast(`Deleted ${q.name}`)
    } catch (e) {
      toast(`Couldn't delete it: ${(e as Error).message}`)
    }
  }

  const row = (q: SavedQuery) => {
    const conn = q.connectionId ? connectionName.get(q.connectionId) : undefined
    return (
      <div key={q.id} className="saved-row">
        <button
          className="table-item saved-item"
          title={[q.name, q.description, conn ? `Opens on ${conn.name}` : 'Snippet: opens on the connection in use'].filter(Boolean).join('\n')}
          onClick={() => {
            const at = target(q)
            if (at) openSaved(q, at)
            else toast('Add a connection first')
          }}
        >
          <span className={`saved-icon ${conn ? '' : 'snippet'}`}>{conn ? '▤' : '❮❯'}</span>
          <span className="table-name">{q.name}</span>
          <span className="saved-conn">{conn ? conn.name : 'any'}</span>
        </button>
        <span className="conn-actions saved-actions">
          <button className="icon small" title="Rename, move or change where it runs" onClick={() => setEditing(q)}>✎</button>
          <button className="icon small" title="Delete this saved query" onClick={() => remove(q)}>✕</button>
        </span>
      </div>
    )
  }

  const editConnection = editing ? connectionName.get(editing.connectionId ?? '') ?? connectionName.get(activeConnection ?? '') ?? connections[0] : undefined

  return (
    <section className="saved-queries">
      <button className="saved-head" onClick={() => setOpen(!open)}>
        <span className={`chevron ${open ? 'open' : ''}`}>›</span>
        <span className="group-name">Saved queries</span>
        <span className="table-rows">{savedQueries.length || ''}</span>
      </button>
      {open && (
        <div className="saved-body">
          {savedQueries.length > 6 && (
            <input className="search" placeholder={`Filter ${savedQueries.length} saved queries…`} value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setFilter('')} />
          )}
          {!savedQueries.length && <div className="muted source-hint">Save a query from its tab with <kbd>Ctrl</kbd> <kbd>S</kbd> to open it again here, or to use it as a snippet.</div>}
          {visible.map(([folder, queries]) => folder ? (
            <div key={folder} className="saved-folder">
              <button className="saved-folder-row" onClick={() => toggleFolder(folder)}>
                <span className={`chevron ${filter.trim() || !closed.has(folder) ? 'open' : ''}`}>›</span>
                <span className="folder-icon">{filter.trim() || !closed.has(folder) ? '📂' : '📁'}</span>
                <span className="folder-name">{folder}</span>
                <span className="folder-count">{queries.length}</span>
              </button>
              {(filter.trim() || !closed.has(folder)) && <div className="saved-folder-body">{queries.map(row)}</div>}
            </div>
          ) : <div key="(none)">{queries.map(row)}</div>)}
          {filter.trim() && !visible.length && <div className="muted pad">No matches</div>}
        </div>
      )}
      {editing && editConnection && (
        <SaveQueryDialog connection={editConnection} sql={editing.sql} existing={editing} onClose={() => setEditing(null)} onSaved={(saved) => { setEditing(null); toast(`Saved ${saved.name}`) }} />
      )}
    </section>
  )
}
