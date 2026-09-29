import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { ConnectionConfig, TableInfo } from '@shared/types'
import { useAppState } from '../state'
import { fuzzyScore } from '../lib/fuzzy'
import { appVersion } from '../lib/version'
import { setTheme, useColorScheme } from '../lib/theme'
import { formatCount } from '../lib/format'
import { toast } from './Toast'

/** Drag type for moving a connection between sidebar folders. */
const CONNECTION_DRAG = 'application/x-jdb-connection'

const COLLAPSED_KEY = 'jdb.sidebar.collapsed'
const EMPTY_FOLDERS_KEY = 'jdb.sidebar.folders'

function readList(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]')
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeList(key: string, values: Iterable<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...values]))
  } catch {
    // Only UI conveniences live here; losing them is harmless.
  }
}

export function Sidebar({ onEdit, onNew, onLinks }: { onEdit(c: ConnectionConfig): void; onNew(): void; onLinks(c: ConnectionConfig): void }) {
  const { connections, reloadConnections, setLinks } = useAppState()
  const scheme = useColorScheme()
  const [collapsed, setCollapsed] = useState(() => new Set(readList(COLLAPSED_KEY)))
  /** Folders made with "New folder" that have no connections yet; folders are otherwise implied by connections. */
  const [emptyFolders, setEmptyFolders] = useState(() => readList(EMPTY_FOLDERS_KEY))
  const [menu, setMenu] = useState(false)
  const [naming, setNaming] = useState(false)
  /** The folder a connection is being dragged over; '' is the top level. */
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const used = new Set(connections.map((c) => c.folder).filter((f): f is string => !!f))
  const folders = [...new Set([...used, ...emptyFolders])].sort((a, b) => a.localeCompare(b))
  const loose = connections.filter((c) => !c.folder)

  const rememberEmpty = (next: string[]): void => {
    setEmptyFolders(next)
    writeList(EMPTY_FOLDERS_KEY, next)
  }

  const toggle = (folder: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(folder)) next.delete(folder)
      else next.add(folder)
      writeList(COLLAPSED_KEY, next)
      return next
    })
  }

  const moveTo = async (ids: string[], folder: string): Promise<void> => {
    try {
      await window.api.setFolder(ids, folder)
      await reloadConnections()
      if (folder) rememberEmpty(emptyFolders.filter((f) => f !== folder))
    } catch (e) {
      toast(`Couldn't move it: ${(e as Error).message}`)
    }
  }

  const renameFolder = async (from: string, to: string): Promise<void> => {
    const name = to.trim()
    if (!name || name === from) return
    const ids = connections.filter((c) => c.folder === from).map((c) => c.id)
    if (ids.length) await moveTo(ids, name)
    rememberEmpty(emptyFolders.map((f) => (f === from ? name : f)))
  }

  const removeFolder = async (folder: string): Promise<void> => {
    const ids = connections.filter((c) => c.folder === folder).map((c) => c.id)
    if (ids.length && !window.confirm(`Remove the folder "${folder}"? Its ${ids.length} connection${ids.length === 1 ? '' : 's'} move to the top level.`)) return
    if (ids.length) await moveTo(ids, '')
    rememberEmpty(emptyFolders.filter((f) => f !== folder))
  }

  const exportConnections = async (ids: string[] | null, name: string): Promise<void> => {
    try {
      const result = await window.api.exportConnections(ids, name)
      if (result) {
        toast(`Exported ${result.connections} connection${result.connections === 1 ? '' : 's'}${result.links ? ` and ${result.links} link${result.links === 1 ? '' : 's'}` : ''} (no passwords)`)
      }
    } catch (e) {
      toast(`Export failed: ${(e as Error).message}`)
    }
  }

  const importConnections = async (): Promise<void> => {
    try {
      const summary = await window.api.importConnections()
      if (!summary) return
      await reloadConnections()
      setLinks(await window.api.listLinks())
      const parts = [
        `Imported ${summary.added.length} connection${summary.added.length === 1 ? '' : 's'}`,
        summary.existing.length ? `${summary.existing.length} already here` : '',
        summary.links ? `${summary.links} link${summary.links === 1 ? '' : 's'}` : ''
      ].filter(Boolean)
      const notes = [
        summary.added.length ? 'Add passwords in each connection\'s settings.' : '',
        summary.madeReadOnly.length ? `${summary.madeReadOnly.join(', ')} came in read-only (production).` : ''
      ].filter(Boolean)
      toast(`${parts.join(' · ')}. ${notes.join(' ')}`)
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`)
    }
  }

  /** Drop handlers for a folder header or the top level (''). */
  const dropProps = (folder: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(CONNECTION_DRAG)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      setDropTarget(folder)
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget((t) => (t === folder ? null : t))
    },
    onDrop: (e: DragEvent) => {
      const id = e.dataTransfer.getData(CONNECTION_DRAG)
      setDropTarget(null)
      if (!id) return
      e.preventDefault()
      e.stopPropagation()
      if ((connections.find((c) => c.id === id)?.folder ?? '') !== folder) moveTo([id], folder)
    }
  })

  const node = (c: ConnectionConfig) => <ConnectionNode key={c.id} connection={c} onEdit={() => onEdit(c)} onLinks={() => onLinks(c)} />

  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <span className="brand">JDB</span>
        <button
          className="icon"
          title={`Switch to ${scheme === 'dark' ? 'light' : 'dark'} mode (Ctrl+K "theme" to follow Windows)`}
          onClick={() => setTheme(scheme === 'dark' ? 'light' : 'dark')}
        >
          {scheme === 'dark' ? '☀' : '☾'}
        </button>
        <button className="icon" title="New connection" onClick={onNew}>＋</button>
        <span className="sidebar-menu-wrap">
          <button className="icon" title="Folders, import and export" onClick={() => setMenu((m) => !m)}>⋯</button>
          {menu && (
            <SidebarMenu onClose={() => setMenu(false)}>
              <button onClick={() => { setMenu(false); setNaming(true) }}>New folder</button>
              <div className="menu-sep" />
              <button onClick={() => { setMenu(false); importConnections() }}>Import connections…</button>
              <button disabled={!connections.length} onClick={() => { setMenu(false); exportConnections(null, 'JDB connections') }}>Export all connections…</button>
              <div className="menu-label">Exports leave out passwords</div>
            </SidebarMenu>
          )}
        </span>
      </div>
      <div className={`sidebar-list ${dropTarget === '' ? 'drop-root' : ''}`} {...dropProps('')}>
        {loose.map(node)}
        {naming && (
          <FolderName
            initial=""
            onDone={(name) => {
              setNaming(false)
              const trimmed = name?.trim()
              if (trimmed && !folders.includes(trimmed)) rememberEmpty([...emptyFolders, trimmed])
            }}
          />
        )}
        {folders.map((folder) => {
          const members = connections.filter((c) => c.folder === folder)
          const open = !collapsed.has(folder)
          return (
            <div key={folder} className={`folder ${dropTarget === folder ? 'drop' : ''}`} {...dropProps(folder)}>
              <FolderRow
                name={folder}
                count={members.length}
                open={open}
                onToggle={() => toggle(folder)}
                onRename={(to) => renameFolder(folder, to)}
                onRemove={() => removeFolder(folder)}
                onExport={members.length ? () => exportConnections(members.map((c) => c.id), folder) : undefined}
              />
              {open && (
                <div className="folder-body">
                  {members.map(node)}
                  {!members.length && <div className="muted folder-empty">Drag connections here</div>}
                </div>
              )}
            </div>
          )
        })}
        {!connections.length && <div className="muted pad">No connections yet. Add one with ＋, or import a shared file from ⋯.</div>}
      </div>
      <div className="sidebar-foot muted">
        <span>Ctrl+K to jump anywhere</span>
        <span className="version" title="JDB version">{appVersion}</span>
      </div>
    </nav>
  )
}

function FolderRow({ name, count, open, onToggle, onRename, onRemove, onExport }: {
  name: string
  count: number
  open: boolean
  onToggle(): void
  onRename(to: string): void
  onRemove(): void
  onExport?(): void
}) {
  const [renaming, setRenaming] = useState(false)
  if (renaming) {
    return <FolderName initial={name} onDone={(to) => { setRenaming(false); if (to !== null) onRename(to) }} />
  }
  return (
    <div className="folder-row" onClick={onToggle} onDoubleClick={() => setRenaming(true)} title="Double-click to rename · drop connections here">
      <span className={`chevron ${open ? 'open' : ''}`}>›</span>
      <span className="folder-icon">{open ? '📂' : '📁'}</span>
      <span className="folder-name">{name}</span>
      <span className="folder-count">{count}</span>
      <span className="conn-actions" onClick={(e) => e.stopPropagation()}>
        {onExport && <button className="icon small" title="Export this folder's connections to share" onClick={onExport}>⇪</button>}
        <button className="icon small" title="Rename folder" onClick={() => setRenaming(true)}>✎</button>
        <button className="icon small" title="Remove folder (its connections stay)" onClick={onRemove}>✕</button>
      </span>
    </div>
  )
}

/** Inline folder name input: Enter keeps it, Esc cancels (null). */
function FolderName({ initial, onDone }: { initial: string; onDone(name: string | null): void }) {
  const done = useRef(false)
  const finish = (name: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <div className="folder-row editing">
      <span className="folder-icon">📁</span>
      <input
        className="search"
        autoFocus
        defaultValue={initial}
        placeholder="Folder name"
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(e.currentTarget.value)
          else if (e.key === 'Escape') finish(null)
        }}
        onBlur={(e) => finish(e.currentTarget.value)}
      />
    </div>
  )
}

function SidebarMenu({ children, onClose }: { children: ReactNode; onClose(): void }) {
  useEffect(() => {
    window.addEventListener('mousedown', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  return <div className="menu sidebar-menu" onMouseDown={(e) => e.stopPropagation()}>{children}</div>
}

function ConnectionNode({ connection, onEdit, onLinks }: { connection: ConnectionConfig; onEdit(): void; onLinks(): void }) {
  const { tables, loadTables, forgetTables, openTable, openQuery } = useAppState()
  const [expanded, setExpanded] = useState(false)
  const [filter, setFilter] = useState('')
  const state = tables[connection.id]

  const toggle = (): void => {
    if (!expanded) loadTables(connection.id)
    setExpanded(!expanded)
  }

  const reconnect = async (): Promise<void> => {
    await window.api.disconnect(connection.id)
    forgetTables(connection.id)
    loadTables(connection.id, true)
  }

  const list = filterTables(state?.tables ?? [], filter)
  const schemas = new Set(list.map((t) => t.schema))
  const showSchema = schemas.size > 1

  return (
    <div className={`conn env-${connection.env}`}>
      <div
        className="conn-row"
        onClick={toggle}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(CONNECTION_DRAG, connection.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        title={`${connection.name} · ${connection.env}${connection.readOnly ? ' · read-only' : ''}\nDrag onto a folder to file it`}
      >
        <span className={`chevron ${expanded ? 'open' : ''}`}>›</span>
        <span className="env-dot" title={connection.env} />
        <span className="conn-name">{connection.name}</span>
        {connection.readOnly && <span className="lock" title="Read-only">🔒</span>}
        <span className="conn-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon small" title="Ask in plain English / new query (Ctrl+T)" onClick={() => openQuery(connection.id)}>✦</button>
          <button className="icon small" title="Cross-database links" onClick={onLinks}>🔗</button>
          <button className="icon small" title="Reconnect and refresh" onClick={reconnect}>⟳</button>
          <button className="icon small" title="Edit connection" onClick={onEdit}>✎</button>
        </span>
      </div>

      {expanded && (
        <div className="conn-body">
          {state?.status === 'loading' && <div className="muted pad">Connecting…</div>}
          {state?.status === 'error' && (
            <div className="conn-error">
              <div>{state.error}</div>
              <div className="row-gap">
                <button onClick={() => loadTables(connection.id, true)}>Retry</button>
                <button onClick={onEdit}>Edit connection</button>
              </div>
            </div>
          )}
          {state?.status === 'ready' && (
            <>
              <input
                className="search"
                placeholder={`Filter ${state.tables.length} tables…`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <div className="tables">
                {list.map((t) => (
                  <button
                    key={`${t.schema}.${t.name}`}
                    className="table-item"
                    onClick={() => openTable(connection.id, t)}
                    title={`${t.schema}.${t.name}${t.rowEstimate !== undefined ? ` · ~${formatCount(t.rowEstimate)} rows` : ''}`}
                  >
                    <span className="table-icon">{t.type === 'view' ? '◫' : '▦'}</span>
                    <span className="table-name">
                      {showSchema && <span className="muted">{t.schema}.</span>}
                      {t.name}
                    </span>
                    {t.rowEstimate !== undefined && <span className="table-rows">{compact(t.rowEstimate)}</span>}
                  </button>
                ))}
                {!list.length && <div className="muted pad">No matches</div>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function filterTables(tables: TableInfo[], filter: string): TableInfo[] {
  if (!filter.trim()) return tables
  return tables
    .map((t) => ({ t, score: fuzzyScore(filter, `${t.schema}.${t.name}`) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t)
}

function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
