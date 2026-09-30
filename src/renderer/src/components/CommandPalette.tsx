import { useEffect, useMemo, useRef, useState } from 'react'
import type { SchemaTable } from '@shared/types'
import { useAppState } from '../state'
import { ROUTINE_LABELS } from '@shared/routines'
import { setTheme, THEME_ICONS, THEME_LABELS, THEMES, useTheme } from '../lib/theme'
import { toast } from './Toast'
import { fuzzyScore } from '../lib/fuzzy'
import { toggleSlop, useSlop } from '../lib/slop'
import { checkForUpdates } from '../lib/useUpdate'
import { openWhatsNew } from '../lib/whatsNew'
import { APP_NAME } from '@shared/brand'

interface Item {
  key: string
  label: string
  detail: string
  icon: string
  /** Text the query is matched against. */
  haystack: string
  /** Actions rank below tables for equal scores so table jumps stay the fast path. */
  bias: number
  run(): void
}

const MAX_RESULTS = 60
/** Column matches only show once this much is typed; there can be tens of thousands. */
const COLUMN_QUERY_MIN = 2

export function CommandPalette({ onClose, onNewConnection, onLinks, onSettings }: { onClose(): void; onNewConnection(): void; onLinks(connectionId: string): void; onSettings(): void }) {
  const { connections, tables, loadTables, routines, loadRoutines, openTable, openQuery, open, savedQueries, openSaved, activeTabId, tabs, environment } = useAppState()
  const theme = useTheme()
  const slop = useSlop()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Columns come from each connected database's schema (cached in the main process after the first read).
  const [schemas, setSchemas] = useState<Record<string, SchemaTable[]>>({})
  const ready = connections.filter((c) => tables[c.id]?.status === 'ready').map((c) => c.id).join(',')
  useEffect(() => {
    let live = true
    for (const id of ready.split(',').filter(Boolean)) {
      loadRoutines(id)
      window.api.describeSchema(id).then((schema) => live && setSchemas((s) => ({ ...s, [id]: schema })), () => undefined)
    }
    return () => {
      live = false
    }
  }, [ready, loadRoutines])

  const columnItems = useMemo<Item[]>(() => {
    const out: Item[] = []
    for (const c of connections) {
      for (const t of schemas[c.id] ?? []) {
        for (const col of t.columns) {
          out.push({
            key: `col:${c.id}:${t.schema}.${t.name}.${col.name}`,
            label: col.name,
            detail: `${t.name}.${col.name} · ${col.dataType} · ${c.name}`,
            icon: '▥',
            haystack: `${col.name} ${t.name}.${col.name}`,
            // Below tables of the same name, above commands.
            bias: -1,
            run: () => open({ kind: 'table', connectionId: c.id, table: { schema: t.schema, name: t.name }, filters: [], column: col.name })
          })
        }
      }
    }
    return out
  }, [connections, schemas, open])

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    for (const c of connections) {
      for (const t of tables[c.id]?.tables ?? []) {
        out.push({
          key: `t:${c.id}:${t.schema}.${t.name}`,
          label: t.name,
          detail: `${t.schema} · ${c.name}`,
          icon: t.type === 'view' ? '◫' : '▦',
          haystack: `${t.name} ${t.schema}.${t.name} ${c.name}`,
          bias: 0,
          run: () => openTable(c.id, t)
        })
      }
      for (const r of routines[c.id]?.routines ?? []) {
        out.push({
          key: `r:${c.id}:${r.kind}:${r.schema}.${r.name}`,
          label: r.name,
          detail: `${ROUTINE_LABELS[r.kind].singular} · ${r.schema} · ${c.name}`,
          icon: 'ƒ',
          haystack: `${r.name} ${r.schema}.${r.name} ${ROUTINE_LABELS[r.kind].singular} ${c.name}`,
          // Just below a table of the same name.
          bias: -0.5,
          run: () => open({ kind: 'routine', connectionId: c.id, routine: { schema: r.schema, name: r.name, kind: r.kind } })
        })
      }
      out.push({
        key: `a:${c.id}`,
        label: `Ask ${c.name}…`,
        detail: 'describe a query in plain English',
        icon: '✦',
        haystack: `ask english natural query ${c.name}`,
        bias: -4,
        run: () => openQuery(c.id)
      })
      if (connections.length > 1) {
        out.push({
          key: `l:${c.id}`,
          label: `Cross-database links for ${c.name}…`,
          detail: 'find and manage links to other databases',
          icon: '🔗',
          haystack: `links cross database join ${c.name}`,
          bias: -6,
          run: () => onLinks(c.id)
        })
      }
      out.push({
        key: `q:${c.id}`,
        label: `New query on ${c.name}`,
        detail: environment(c.env).name,
        icon: '⌨',
        haystack: `new query sql ${c.name}`,
        bias: -5,
        run: () => openQuery(c.id)
      })
      if (!tables[c.id]) {
        out.push({
          key: `c:${c.id}`,
          label: `Connect to ${c.name}`,
          detail: 'load its tables into search',
          icon: '⚡',
          haystack: `connect ${c.name}`,
          bias: -5,
          run: () => loadTables(c.id)
        })
      }
    }
    // Saved queries open on their own connection, or (snippets) on the one in use.
    const inUse = tabs.find((t) => t.id === activeTabId)?.connectionId ?? connections[0]?.id
    for (const q of savedQueries) {
      const own = q.connectionId ? connections.find((c) => c.id === q.connectionId) : undefined
      const at = own?.id ?? inUse
      if (!at) continue
      out.push({
        key: `sq:${q.id}`,
        label: q.name,
        detail: [own ? 'saved query' : 'snippet', q.folder, own?.name].filter(Boolean).join(' · '),
        icon: '▤',
        haystack: `${q.name} ${q.folder ?? ''} saved query snippet ${own?.name ?? ''}`,
        bias: 0,
        run: () => openSaved(q, at)
      })
    }
    out.push({ key: 'new', label: 'New connection…', detail: '', icon: '＋', haystack: 'new connection add', bias: -10, run: onNewConnection })
    if (connections.some((c) => c.authType === 'entra-browser')) {
      out.push({
        key: 'entra-signout',
        label: 'Sign out of Entra',
        detail: 'forget the saved Microsoft sign-in; the next connection asks again',
        icon: '⎋',
        haystack: 'sign out log out entra azure microsoft account switch',
        bias: -10,
        run: () => {
          window.api.signOutEntra().then(() => toast('Signed out of Entra'), (e) => toast(`Sign-out failed: ${(e as Error).message}`))
        }
      })
    }
    out.push({
      key: 'update-check',
      label: 'Check for updates',
      detail: `look for a new ${APP_NAME} release now`,
      icon: '⟳',
      haystack: 'check for updates update upgrade new version release',
      bias: -10,
      run: checkForUpdates
    })
    out.push({
      key: 'settings',
      label: 'Settings…',
      detail: 'theme, accent and environment colours, fonts, size, grid density (Ctrl+,)',
      icon: '⚙',
      haystack: 'settings preferences options appearance theme colour color accent font size zoom density customise customize',
      bias: -8,
      run: onSettings
    })
    out.push({
      key: 'whats-new',
      label: "What's new",
      detail: 'release notes for each version',
      icon: '✎',
      haystack: "whats new what's new release notes changelog changes version",
      bias: -10,
      run: () => openWhatsNew()
    })
    for (const option of THEMES) {
      if (option === theme) continue
      out.push({
        key: `theme:${option}`,
        label: `Theme: ${THEME_LABELS[option]}`,
        detail: option === 'system' ? 'follow Windows' : option === 'dim' ? 'a softer dark' : option === 'midnight' ? 'near-black' : option === 'contrast' ? 'bold text and borders' : '',
        icon: THEME_ICONS[option],
        haystack: `theme appearance colour color ${option} mode`,
        bias: -10,
        run: () => setTheme(option)
      })
    }
    return out
  }, [connections, tables, routines, open, openTable, openQuery, loadTables, onNewConnection, onLinks, onSettings, theme, savedQueries, openSaved, activeTabId, tabs, environment])

  const results = useMemo(() => {
    // The slop easter egg only shows when typed in full, so it never turns up in normal searches.
    if (query.trim().toLowerCase() === 'slop') {
      return [
        {
          key: 'slop',
          label: slop ? 'Unslop' : '✨ Slop mode ✨',
          detail: slop ? 'back to the boring, readable UI' : 'reimagine your data journey with next-gen AI synergy',
          icon: slop ? '🧹' : '🤖',
          haystack: 'slop',
          bias: 0,
          run: () => toast(toggleSlop() ? '🚀✨ Slop mode activated. Your data has never been this delightful! 🎉💯' : 'Slop mode off')
        }
      ]
    }
    if (!query.trim()) return items.slice(0, MAX_RESULTS)
    const pool = query.trim().length >= COLUMN_QUERY_MIN ? [...items, ...columnItems] : items
    return pool
      .map((item) => ({ item, score: fuzzyScore(query, item.label) * 2 + Math.max(0, fuzzyScore(query, item.haystack)) + item.bias }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((x) => x.item)
  }, [items, columnItems, query, slop])

  useEffect(() => setIndex(0), [query])

  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const choose = (item: Item | undefined): void => {
    if (!item) return
    onClose()
    // After the key press is over: a command that opens a dialog moves focus to its button, and the
    // same Enter would then press it (What's new opened and shut at once).
    setTimeout(item.run, 0)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      choose(results[index])
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  const unloaded = connections.filter((c) => !tables[c.id]).length

  return (
    <div className="overlay top" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder="Jump to a table, column, routine or saved query, or run a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="palette-list" ref={listRef}>
          {results.map((item, i) => (
            <button
              key={item.key}
              className={`palette-item ${i === index ? 'on' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(item)}
            >
              <span className="palette-icon">{item.icon}</span>
              <span className="palette-label">{item.label}</span>
              <span className="muted">{item.detail}</span>
            </button>
          ))}
          {!results.length && <div className="muted pad">No matches</div>}
        </div>
        {unloaded > 0 && <div className="palette-foot muted">{unloaded} connection{unloaded === 1 ? ' is' : 's are'} not connected yet, so their tables aren't searchable.</div>}
      </div>
    </div>
  )
}
