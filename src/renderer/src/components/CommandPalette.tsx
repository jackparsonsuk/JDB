import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppState } from '../state'
import { setTheme, THEME_ICONS, THEME_LABELS, useTheme } from '../lib/theme'
import { toast } from './Toast'
import { fuzzyScore } from '../lib/fuzzy'

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

export function CommandPalette({ onClose, onNewConnection, onLinks }: { onClose(): void; onNewConnection(): void; onLinks(connectionId: string): void }) {
  const { connections, tables, loadTables, openTable, openQuery } = useAppState()
  const theme = useTheme()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

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
        detail: c.env,
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
    for (const option of ['system', 'light', 'dark'] as const) {
      if (option === theme) continue
      out.push({
        key: `theme:${option}`,
        label: `Theme: ${THEME_LABELS[option]}`,
        detail: option === 'system' ? 'follow Windows' : '',
        icon: THEME_ICONS[option],
        haystack: `theme appearance colour color ${option} mode`,
        bias: -10,
        run: () => setTheme(option)
      })
    }
    return out
  }, [connections, tables, openTable, openQuery, loadTables, onNewConnection, onLinks, theme])

  const results = useMemo(() => {
    if (!query.trim()) return items.slice(0, MAX_RESULTS)
    return items
      .map((item) => ({ item, score: fuzzyScore(query, item.label) * 2 + Math.max(0, fuzzyScore(query, item.haystack)) + item.bias }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((x) => x.item)
  }, [items, query])

  useEffect(() => setIndex(0), [query])

  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const choose = (item: Item | undefined): void => {
    if (!item) return
    onClose()
    item.run()
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
          placeholder="Jump to a table, or run a command…"
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
