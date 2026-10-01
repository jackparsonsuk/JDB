import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { ConnectionConfig, DatabaseList, RoutineInfo, RoutineKind, RoutineSource, TableInfo } from '@shared/types'
import { ROUTINE_LABELS, searchSources } from '@shared/routines'
import { useOpenLink } from '../lib/openLink'
import { SavedQueries } from './SavedQueries'
import { Logo } from './Logo'
import { confirm } from './Confirm'
import { useAppState } from '../state'
import { wordScore } from '@shared/fuzzy'
import { appVersion } from '../lib/version'
import { useUpdate } from '../lib/useUpdate'
import { setTheme, useColorScheme } from '../lib/theme'
import { formatCount, selectSql } from '../lib/format'
import { pinKey, usePinnedTables } from '../lib/pinnedTables'
import { toast } from './Toast'
import { APP_NAME } from '@shared/brand'

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

export function Sidebar({ onEdit, onNew, onLinks, onSettings }: { onEdit(c: ConnectionConfig): void; onNew(): void; onLinks(c: ConnectionConfig): void; onSettings(): void }) {
  const { connections, reloadConnections, setLinks, reloadQueries, reloadEnvironments } = useAppState()
  const scheme = useColorScheme()
  const update = useUpdate()
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
    if (ids.length && !(await confirm({
      title: `Remove the folder ${folder}?`,
      message: `Its ${ids.length} connection${ids.length === 1 ? '' : 's'} move to the top level; none are deleted.`,
      confirmLabel: 'Remove folder'
    }))) return
    if (ids.length) await moveTo(ids, '')
    rememberEmpty(emptyFolders.filter((f) => f !== folder))
  }

  const exportConnections = async (ids: string[] | null, name: string): Promise<void> => {
    try {
      const result = await window.api.exportConnections(ids, name)
      if (result) {
        const extras = [
          result.links ? `${result.links} link${result.links === 1 ? '' : 's'}` : '',
          result.queries ? `${result.queries} saved quer${result.queries === 1 ? 'y' : 'ies'}` : ''
        ].filter(Boolean)
        toast(`Exported ${result.connections} connection${result.connections === 1 ? '' : 's'}${extras.length ? ` with ${extras.join(' and ')}` : ''} (no passwords)`)
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
      await reloadQueries()
      reloadEnvironments()
      setLinks(await window.api.listLinks())
      const parts = [
        `Imported ${summary.added.length} connection${summary.added.length === 1 ? '' : 's'}`,
        summary.existing.length ? `${summary.existing.length} already here` : '',
        summary.links ? `${summary.links} link${summary.links === 1 ? '' : 's'}` : '',
        summary.queries ? `${summary.queries} saved quer${summary.queries === 1 ? 'y' : 'ies'}` : '',
        summary.environments.length ? `environment${summary.environments.length === 1 ? '' : 's'} ${summary.environments.join(', ')}` : ''
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
        <Logo className="brand" size={22} />
        <button
          className="icon"
          title={`Switch to ${scheme === 'dark' ? 'light' : 'dark'} mode (Ctrl+K "theme" to follow Windows)`}
          onClick={() => setTheme(scheme === 'dark' ? 'light' : 'dark')}
        >
          {scheme === 'dark' ? '☀' : '☾'}
        </button>
        <button className="icon" title="Settings: theme, colours, fonts (Ctrl+,)" onClick={onSettings}>⚙</button>
        <button className="icon" title="New connection" onClick={onNew}>＋</button>
        <span className="sidebar-menu-wrap">
          <button className="icon" title="Folders, import and export" onClick={() => setMenu((m) => !m)}>⋯</button>
          {menu && (
            <SidebarMenu onClose={() => setMenu(false)}>
              <button onClick={() => { setMenu(false); onSettings() }}>Settings…<kbd>Ctrl+,</kbd></button>
              <div className="menu-sep" />
              <button onClick={() => { setMenu(false); setNaming(true) }}>New folder</button>
              <div className="menu-sep" />
              <button onClick={() => { setMenu(false); importConnections() }}>Import connections…</button>
              <button disabled={!connections.length} onClick={() => { setMenu(false); exportConnections(null, `${APP_NAME} connections`) }}>Export all connections…</button>
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
        {connections.length > 0 && <SavedQueries />}
      </div>
      <div className="sidebar-foot muted">
        <span>Ctrl+K to jump anywhere</span>
        {update.version ? (
          <button className="update" title={`${APP_NAME} ${update.version} has downloaded; restart to install it`} onClick={update.install}>
            Restart to update
          </button>
        ) : (
          <span className="version" title={`${APP_NAME} version`}>{appVersion}</span>
        )}
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

/** A connection's right-click menu, at the pointer and kept on screen. */
function ConnectionMenu({ x, y, onClose, children }: { x: number; y: number; onClose(): void; children(act: (run: () => void) => () => void): ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setPosition({ left: Math.min(x, window.innerWidth - el.offsetWidth - 8), top: Math.min(y, window.innerHeight - el.offsetHeight - 8) })
  }, [x, y])
  const act = (run: () => void) => (): void => {
    onClose()
    run()
  }
  return <div ref={ref} className="menu tab-menu" style={position} onMouseDown={(e) => e.stopPropagation()}>{children(act)}</div>
}

function ConnectionNode({ connection, onEdit, onLinks }: { connection: ConnectionConfig; onEdit(): void; onLinks(): void }) {
  const { tables, loadTables, forgetTables, routines, loadRoutines, openTable, openQuery, open, environment } = useAppState()
  const [expanded, setExpanded] = useState(false)
  const [filter, setFilter] = useState('')
  const [mode, setMode] = useState<'tables' | 'routines'>('tables')
  const [inSource, setInSource] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  /** Open database / schema folders (lowercased): the connection's own database to start with. */
  const [openSchemas, setOpenSchemas] = useState<Set<string>>(() => new Set([(connection.database || (connection.kind === 'mssql' ? 'dbo' : '')).toLowerCase()]))
  const toggleSchema = useCallback((schema: string) => setOpenSchemas((s) => toggled(s, schema.toLowerCase())), [])
  /** Tables / Views folders the user closed inside a schema, as "schema|type". */
  const [closedTypes, setClosedTypes] = useState<Set<string>>(() => new Set())
  const state = tables[connection.id]
  const routineState = routines[connection.id]

  // Read the routine list once the tables are in, so the switch can show its count.
  useEffect(() => {
    if (expanded && state?.status === 'ready') loadRoutines(connection.id)
  }, [expanded, state?.status, connection.id, loadRoutines])

  const toggle = (): void => {
    if (!expanded) loadTables(connection.id)
    setExpanded(!expanded)
  }

  const reconnect = async (): Promise<void> => {
    await window.api.disconnect(connection.id)
    forgetTables(connection.id)
    loadTables(connection.id, true)
  }

  const { pinned, setPinned } = usePinnedTables(connection.id)
  const [tableMenu, setTableMenu] = useState<{ x: number; y: number; table: TableInfo } | null>(null)
  const filtered = filterTables(state?.tables ?? [], filter)
  // Pinned tables sit at the top, in the order they were pinned, and leave the list below.
  const pinnedList = pinned.flatMap((key) => filtered.find((t) => pinKey(t) === key) ?? [])
  const list = pinnedList.length ? filtered.filter((t) => !pinned.includes(pinKey(t))) : filtered
  // Grouped by database (MySQL) or schema (SQL Server) once there's more than one, like DBeaver's tree.
  const showSchema = new Set((state?.tables ?? []).map((t) => t.schema)).size > 1
  const schemaLabel = connection.kind === 'mysql' ? 'database' : 'schema'
  const queryIn = (schema: string): void => openQuery(connection.id, '', schema)

  const tableItem = (t: TableInfo, withSchema: boolean): ReactNode => (
    <button
      key={`${t.schema}.${t.name}`}
      className="table-item"
      onClick={() => openTable(connection.id, t)}
      onContextMenu={(e) => {
        e.preventDefault()
        setTableMenu({ x: e.clientX, y: e.clientY, table: t })
      }}
      title={`${t.schema}.${t.name}${t.rowEstimate !== undefined ? ` · ~${formatCount(t.rowEstimate)} rows` : ''}\nRight-click to pin it to the top`}
    >
      <span className="table-icon">{t.type === 'view' ? '◫' : '▦'}</span>
      <span className="table-name">
        {withSchema && <span className="muted">{t.schema}.</span>}
        {t.name}
      </span>
      {t.rowEstimate !== undefined && <span className="table-rows">{compact(t.rowEstimate)}</span>}
    </button>
  )

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
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        title={`${connection.name} · ${environment(connection.env).name}${connection.readOnly ? ' · read-only' : ''}\nDrag onto a folder to file it · right-click for more`}
      >
        <span className={`chevron ${expanded ? 'open' : ''}`}>›</span>
        <span className="env-dot" title={environment(connection.env).name} />
        <span className="conn-name">{connection.name}</span>
        {connection.readOnly && <span className="lock" title="Read-only">🔒</span>}
        <span className="conn-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon small" title="Cross-database links" onClick={onLinks}>🔗</button>
          <button className="icon small" title="Reconnect and refresh" onClick={reconnect}>⟳</button>
          <button className="icon small" title="Edit connection" onClick={onEdit}>✎</button>
        </span>
        <button
          className="icon small conn-query"
          title="New query (Ctrl+T)"
          onClick={(e) => {
            e.stopPropagation()
            openQuery(connection.id)
          }}
        >
          ⌨
        </button>
      </div>

      {menu && (
        <ConnectionMenu {...menu} onClose={() => setMenu(null)}>
          {(act) => (
            <>
              <button onClick={act(() => openQuery(connection.id))}>New query<kbd>Ctrl+T</kbd></button>
              <button onClick={act(() => open({ kind: 'search', connectionId: connection.id, value: '' }))}>Find a value…</button>
              <div className="menu-sep" />
              <button onClick={act(onLinks)}>Cross-database links</button>
              <button onClick={act(reconnect)}>Reconnect and refresh</button>
              <button onClick={act(onEdit)}>Edit connection</button>
            </>
          )}
        </ConnectionMenu>
      )}

      {tableMenu && (() => {
        const t = tableMenu.table
        const isPinned = pinned.includes(pinKey(t))
        return (
          <ConnectionMenu x={tableMenu.x} y={tableMenu.y} onClose={() => setTableMenu(null)}>
            {(act) => (
              <>
                <div className="menu-label">{t.schema}.{t.name}</div>
                <button onClick={act(() => setPinned(t, !isPinned))}>{isPinned ? 'Unpin' : 'Pin to top'}</button>
                <div className="menu-sep" />
                <button onClick={act(() => openTable(connection.id, t))}>Open</button>
                <button onClick={act(() => openQuery(connection.id, selectSql(connection.kind, t, [], undefined, undefined, 100)))}>New query on this {t.type === 'view' ? 'view' : 'table'}</button>
                <button onClick={act(() => window.api.copy(t.name))}>Copy name</button>
              </>
            )}
          </ConnectionMenu>
        )
      })()}

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
              <div className="conn-switch" role="tablist">
                <button role="tab" className={mode === 'tables' ? 'on' : ''} onClick={() => setMode('tables')}>
                  Tables <span className="switch-count">{state.tables.length.toLocaleString()}</span>
                </button>
                <button role="tab" className={mode === 'routines' ? 'on' : ''} onClick={() => setMode('routines')} title="Stored procedures, functions and triggers">
                  Routines <span className="switch-count">{routineState?.status === 'ready' ? routineState.routines.length.toLocaleString() : '…'}</span>
                </button>
              </div>
              <div className="search-wrap">
                <input
                  className="search"
                  placeholder={mode === 'tables'
                    ? `Filter ${state.tables.length} tables…`
                    : inSource ? 'Search inside the source…' : routineState?.status === 'ready' ? `Filter ${routineState.routines.length} routines…` : 'Filter routines…'}
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setFilter('')
                  }}
                />
                {mode === 'routines' && (
                  <button
                    className={`source-toggle ${inSource ? 'on' : ''}`}
                    title={inSource ? 'Searching inside the source. Click to filter by name instead' : 'Search inside the source: which routines mention a table, column or any text'}
                    onClick={() => setInSource((v) => !v)}
                  >
                    {'{ }'}
                  </button>
                )}
              </div>
              {mode === 'routines' && (
                <RoutineList
                  connectionId={connection.id}
                  filter={filter}
                  inSource={inSource}
                  schemas={{ open: openSchemas, onToggle: toggleSchema, label: schemaLabel, onQuery: queryIn }}
                />
              )}
              <div className="tables" hidden={mode !== 'tables'}>
                {pinnedList.length > 0 && (
                  <div className="routine-group pinned-group">
                    <div className="group-head"><span className="pin-icon">📌</span><span className="group-name">Pinned</span></div>
                    {pinnedList.map((t) => tableItem(t, showSchema))}
                  </div>
                )}
                {showSchema ? (
                  <SchemaGroups items={list} open={openSchemas} filtering={!!filter.trim()} onToggle={toggleSchema} label={schemaLabel} onQuery={queryIn}>
                    {(group, schema) => (['table', 'view'] as const).map((type) => {
                      const items = group.filter((t) => t.type === type)
                      if (!items.length) return null
                      const key = `${schema}|${type}`.toLowerCase()
                      const open = !!filter.trim() || !closedTypes.has(key)
                      return (
                        <div key={type} className="routine-group">
                          <button className="group-head" onClick={() => setClosedTypes((c) => toggled(c, key))}>
                            <span className={`chevron ${open ? 'open' : ''}`}>›</span>
                            <span className="table-icon">{type === 'view' ? '◫' : '▦'}</span>
                            <span className="group-name">{type === 'view' ? 'Views' : 'Tables'}</span>
                            <span className="table-rows">{items.length.toLocaleString()}</span>
                          </button>
                          {open && items.map((t) => tableItem(t, false))}
                        </div>
                      )
                    })}
                  </SchemaGroups>
                ) : list.map((t) => tableItem(t, false))}
                {!state.tables.length
                  ? <NoTables connection={connection} onEdit={onEdit} />
                  : !list.length && <div className="muted pad">No matches</div>}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * A connection that lists no tables has usually landed in the wrong database: on Azure SQL a
 * blank Database means master. Says which database it's in and offers the others on the server.
 */
function NoTables({ connection, onEdit }: { connection: ConnectionConfig; onEdit(): void }) {
  const { forgetTables, reloadConnections, loadTables } = useAppState()
  const [list, setList] = useState<DatabaseList | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    window.api.listDatabases(connection.id).then((l) => live && setList(l), () => undefined)
    return () => { live = false }
  }, [connection.id])

  const use = async (database: string): Promise<void> => {
    setSwitching(database)
    try {
      await window.api.saveConnection({ ...connection, database })
      forgetTables(connection.id)
      await reloadConnections()
      loadTables(connection.id, true)
      toast(`${connection.name} now uses ${database}`)
    } catch (e) {
      toast(`Couldn't switch database: ${(e as Error).message}`)
      setSwitching(null)
    }
  }

  const current = list?.current
  const others = list?.databases.filter((d) => d !== current) ?? []
  return (
    <div className="no-tables">
      <div>
        {current === 'master'
          ? <>Connected to <strong>master</strong>, which has no tables of its own. {connection.database ? '' : 'With no Database set, Azure SQL starts there.'}</>
          : <>No tables or views visible{current ? <> in <strong>{current}</strong></> : ''}. The login may not have permission to see them.</>}
      </div>
      {others.length > 0 && (
        <>
          <div className="muted">Use a database on this server:</div>
          <div className="no-tables-dbs">
            {others.map((d) => (
              <button key={d} disabled={!!switching} onClick={() => use(d)}>{switching === d ? 'Switching…' : d}</button>
            ))}
          </div>
        </>
      )}
      <button className="ghost" onClick={onEdit}>Edit connection</button>
    </div>
  )
}

/** Source search shows at most this many routines; more than that and the search needs narrowing. */
const SOURCE_LIMIT = 200

/** How many routines show per group before "Show all"; big databases can have thousands. */
const ROUTINE_PAGE = 300

type Sources = { status: 'loading' | 'ready' | 'error'; list: RoutineSource[]; error?: string }

/** A connection's procedures, functions and triggers grouped by kind, or matches inside their source. */
function RoutineList({ connectionId, filter, inSource, schemas }: { connectionId: string; filter: string; inSource: boolean; schemas: SchemaFolders }) {
  const { routines, loadRoutines } = useAppState()
  const link = useOpenLink()
  const state = routines[connectionId]
  /** Kind groups the user closed, and those showing every routine: "kind", or "schema|kind" when grouped. */
  const [closed, setClosed] = useState<Set<string>>(() => new Set())
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set())
  const [sources, setSources] = useState<Sources | null>(null)
  const needle = useDeferredValue(filter)

  useEffect(() => {
    loadRoutines(connectionId)
  }, [connectionId, loadRoutines])

  // A changed routine list (after DDL, or a reconnect) means the sources need reading again.
  const list = state?.routines
  useEffect(() => {
    setSources(null)
  }, [list])

  // Sources are read when source search is first used; the main process caches them too.
  useEffect(() => {
    if (!inSource || sources) return
    let live = true
    setSources({ status: 'loading', list: [] })
    window.api.routineSources(connectionId).then(
      (found) => live && setSources({ status: 'ready', list: found }),
      (e) => live && setSources({ status: 'error', list: [], error: (e as Error).message })
    )
    return () => {
      live = false
    }
  }, [inSource, connectionId, sources])

  if (!state || state.status === 'loading') return <div className="muted pad">Reading routines…</div>
  if (state.status === 'error') {
    return (
      <div className="conn-error">
        <div>{state.error}</div>
        <div className="row-gap"><button onClick={() => loadRoutines(connectionId, true)}>Retry</button></div>
      </div>
    )
  }
  if (!state.routines.length) return <div className="muted pad">No procedures, functions or triggers here.</div>

  const showSchema = new Set(state.routines.map((r) => r.schema)).size > 1

  if (inSource) {
    if (!sources || sources.status === 'loading') {
      return <div className="muted pad">Reading the source of {state.routines.length.toLocaleString()} routines…</div>
    }
    if (sources.status === 'error') return <div className="conn-error">{sources.error}</div>
    const hidden = sources.list.filter((s) => s.definition === null).length
    const term = needle.trim()
    const { matches, total } = term.length >= 2 ? searchSources(sources.list, term, SOURCE_LIMIT) : { matches: [], total: 0 }
    return (
      <div className="tables">
        {term.length < 2 && <div className="muted source-hint">Type a table, column or any text to find the routines that mention it.</div>}
        {matches.map((m) => (
          <button
            key={`${m.source.kind}:${m.source.schema}.${m.source.name}`}
            className="table-item source-hit"
            {...link({ kind: 'routine', connectionId, routine: { schema: m.source.schema, name: m.source.name, kind: m.source.kind }, find: term })}
            title={`${m.source.schema}.${m.source.name} · ${m.count} match${m.count === 1 ? '' : 'es'}\nShift+click opens beside · drag to a pane`}
          >
            <span className="source-hit-head">
              <span className={`kind-dot kind-${m.source.kind}`} />
              <span className="table-name">
                {showSchema && <span className="muted">{m.source.schema}.</span>}
                {m.source.name}
              </span>
              {m.count > 1 && <span className="table-rows">×{m.count}</span>}
            </span>
            <code className="source-snippet">
              {m.snippet.slice(0, m.start)}<mark>{m.snippet.slice(m.start, m.end)}</mark>{m.snippet.slice(m.end)}
            </code>
          </button>
        ))}
        {term.length >= 2 && !matches.length && <div className="muted pad">Not found in any routine's source</div>}
        {total > matches.length && (
          <div className="muted source-hint">
            Showing the {matches.length.toLocaleString()} with the most matches of {total.toLocaleString()}. Type more to narrow it down.
          </div>
        )}
        {hidden > 0 && (
          <div className="muted source-hint">
            {hidden.toLocaleString()} of {sources.list.length.toLocaleString()} can't be searched because this login can't read their source.
          </div>
        )}
      </div>
    )
  }

  const visible = filterRoutines(state.routines, needle)

  /** The kind groups for a list of routines; `prefix` keeps each schema's open state apart. */
  const kindGroups = (routines: RoutineInfo[], prefix: string, withSchema: boolean): ReactNode => ROUTINE_KINDS.map((kind) => {
        const group = routines.filter((r) => r.kind === kind)
        if (!group.length) return null
        const key = `${prefix}${kind}`
        // Filtering opens every group, so a match is never tucked away.
        const open = !!needle.trim() || !closed.has(key)
        const shown = showAll.has(key) ? group : group.slice(0, ROUTINE_PAGE)
        return (
          <div key={kind} className="routine-group">
            <button className="group-head" onClick={() => setClosed((c) => toggled(c, key))}>
              <span className={`chevron ${open ? 'open' : ''}`}>›</span>
              <span className={`kind-dot kind-${kind}`} />
              <span className="group-name">{ROUTINE_LABELS[kind].plural}</span>
              <span className="table-rows">{group.length.toLocaleString()}</span>
            </button>
            {open && shown.map((r) => (
              <button
                key={`${r.schema}.${r.name}`}
                className={`table-item routine-item ${r.disabled ? 'disabled' : ''}`}
                {...link({ kind: 'routine', connectionId, routine: { schema: r.schema, name: r.name, kind: r.kind } })}
                title={[
                  `${r.schema}.${r.name}`,
                  r.kind === 'trigger' && r.parent ? `${r.detail ?? ''} on ${r.parent.schema}.${r.parent.name}` : r.detail === 'table' ? 'table-valued function' : '',
                  r.disabled ? 'disabled' : ''
                ].filter(Boolean).join(' · ')}
              >
                <span className="table-name">
                  {withSchema && <span className="muted">{r.schema}.</span>}
                  {r.name}
                </span>
                {r.kind === 'trigger' && r.parent && <span className="routine-aside">{r.parent.name}</span>}
                {r.kind === 'function' && r.detail === 'table' && <span className="routine-aside">table</span>}
                {r.disabled && <span className="routine-aside off">off</span>}
              </button>
            ))}
            {open && group.length > shown.length && (
              <button className="show-more" onClick={() => setShowAll((s) => toggled(s, key))}>
                Show all {group.length.toLocaleString()}
              </button>
            )}
          </div>
        )
      })

  return (
    <div className="tables">
      {showSchema
        ? (
          <SchemaGroups items={visible} filtering={!!needle.trim()} {...schemas}>
            {(group, schema) => kindGroups(group, `${schema.toLowerCase()}|`, false)}
          </SchemaGroups>
        )
        : kindGroups(visible, '', false)}
      {!visible.length && <div className="muted pad">No matches by name. Try {'{ }'} to search inside the source.</div>}
    </div>
  )
}

const ROUTINE_KINDS: RoutineKind[] = ['procedure', 'function', 'trigger']

function toggled(set: Set<string>, key: string): Set<string> {
  const next = new Set(set)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/** Folder state for grouping a list by database / schema. */
interface SchemaFolders {
  /** Lowercased names of the open folders. */
  open: Set<string>
  onToggle(schema: string): void
  /** "database" or "schema", for tooltips. */
  label: string
  /** Starts a query tab for that database / schema. */
  onQuery?(schema: string): void
}

/** Items in a collapsible folder per database / schema, alphabetically. A filter opens every folder with a match. */
function SchemaGroups<T extends { schema: string }>({ items, open, filtering, onToggle, label, onQuery, children }: SchemaFolders & {
  items: T[]
  filtering: boolean
  children(group: T[], schema: string): ReactNode
}) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const group = groups.get(item.schema)
    if (group) group.push(item)
    else groups.set(item.schema, [item])
  }
  const names = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
  return (
    <>
      {names.map((schema) => {
        const isOpen = filtering || open.has(schema.toLowerCase())
        const group = groups.get(schema)!
        return (
          <div key={schema} className="schema-group">
            <button className="group-head schema-head" onClick={() => onToggle(schema)} title={`${schema} (${label})`}>
              <span className={`chevron ${isOpen ? 'open' : ''}`}>›</span>
              <span className="schema-icon">⛁</span>
              <span className="group-name">{schema}</span>
              <span className="table-rows">{group.length.toLocaleString()}</span>
              {onQuery && (
                <span
                  role="button"
                  className="schema-query"
                  title={`New query for ${schema}: its tables come first in suggestions, written with the ${label}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onQuery(schema)
                  }}
                >
                  ⌨
                </span>
              )}
            </button>
            {isOpen && <div className="schema-body">{children(group, schema)}</div>}
          </div>
        )
      })}
    </>
  )
}

function filterRoutines(routines: RoutineInfo[], filter: string): RoutineInfo[] {
  if (!filter.trim()) return routines
  return routines
    .map((r) => ({ r, score: wordScore(filter, `${r.schema}.${r.name}`) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r)
}

function filterTables(tables: TableInfo[], filter: string): TableInfo[] {
  if (!filter.trim()) return tables
  return tables
    .map((t) => ({ t, score: wordScore(filter, `${t.schema}.${t.name}`) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t)
}

function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}
