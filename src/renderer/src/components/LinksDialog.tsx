import { useEffect, useMemo, useState } from 'react'
import type { ColumnInfo, ConnectionConfig, CrossLink, LinkCandidate, LinkEnd, LinkOverlap } from '@shared/types'
import { useAppState } from '../state'
import { toast } from './Toast'
import { APP_NAME } from '@shared/brand'

interface Group {
  key: string
  from: { connectionId: string; column: string }
  to: LinkEnd
  items: LinkCandidate[]
}

/** Groups candidates like "JobId in 28 tables -> Jobs Job.Id" so they can be reviewed at once. */
function groupCandidates(candidates: LinkCandidate[]): Group[] {
  const groups = new Map<string, Group>()
  for (const c of candidates) {
    const key = `${c.from.connectionId}|${c.from.column}|${c.to.connectionId}|${c.to.table.schema}.${c.to.table.name}.${c.to.column}`
    const group = groups.get(key) ?? { key, from: { connectionId: c.from.connectionId, column: c.from.column }, to: c.to, items: [] }
    group.items.push(c)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => ratio(b.items) - ratio(a.items) || b.items.length - a.items.length)
}

function ratio(items: { overlap: LinkOverlap }[]): number {
  const matched = items.reduce((s, i) => s + i.overlap.matched, 0)
  const sampled = items.reduce((s, i) => s + i.overlap.sampled, 0)
  return sampled ? matched / sampled : 0
}

const pct = (items: { overlap: LinkOverlap }[]): string => `${Math.round(ratio(items) * 100)}%`
const linkKey = (from: LinkEnd, to: LinkEnd): string =>
  `${from.connectionId}|${from.table.schema}.${from.table.name}.${from.column}>${to.connectionId}|${to.table.schema}.${to.table.name}.${to.column}`

/** Auto-ticked when nearly every sampled value exists on the other side. */
const STRONG = 0.9

export function LinksDialog({ connectionId, onClose }: { connectionId: string; onClose(): void }) {
  const { connections, links, setLinks } = useAppState()
  const others = connections.filter((c) => c.id !== connectionId)
  const self = connections.find((c) => c.id === connectionId)
  const [otherId, setOtherId] = useState(others[0]?.id ?? '')
  const [candidates, setCandidates] = useState<LinkCandidate[] | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const name = (id: string): string => connections.find((c) => c.id === id)?.name ?? '?'
  const env = (id: string): string => connections.find((c) => c.id === id)?.env ?? 'local'
  const groups = useMemo(() => groupCandidates(candidates ?? []), [candidates])
  const pairLinks = links.filter((l) =>
    l.status === 'confirmed' &&
    [l.from.connectionId, l.to.connectionId].includes(connectionId) &&
    (!otherId || [l.from.connectionId, l.to.connectionId].includes(otherId)))
  const confirmedGroups = useMemo(
    () => groupCandidates(pairLinks.map((l) => ({ from: l.from, to: l.to, overlap: l.overlap ?? { matched: 0, sampled: 0, checkedAt: '' } }))),
    [pairLinks]
  )

  const discover = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setCandidates(null)
    try {
      const found = await window.api.discoverLinks(connectionId, otherId)
      setCandidates(found)
      setSelected(new Set(found.filter((c) => c.overlap.matched / c.overlap.sampled >= STRONG).map((c) => linkKey(c.from, c.to))))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const toggle = (keys: string[], on: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const k of keys) {
        if (on) next.add(k)
        else next.delete(k)
      }
      return next
    })
  }

  const save = async (status: 'confirmed' | 'dismissed', items: LinkCandidate[]): Promise<void> => {
    const toSave: CrossLink[] = items.map((c) => ({ id: '', from: c.from, to: c.to, status, source: 'auto', overlap: c.overlap }))
    setLinks(await window.api.saveLinks(toSave))
    const saved = new Set(items.map((c) => linkKey(c.from, c.to)))
    setCandidates((prev) => prev?.filter((c) => !saved.has(linkKey(c.from, c.to))) ?? null)
    toast(status === 'confirmed' ? `Saved ${items.length} link${items.length === 1 ? '' : 's'}` : `Won't suggest ${items.length} again`)
  }

  const removeGroup = async (group: Group): Promise<void> => {
    const ids = pairLinks.filter((l) => group.items.some((i) => linkKey(i.from, i.to) === linkKey(l.from, l.to))).map((l) => l.id)
    let next = links
    for (const id of ids) next = await window.api.deleteLink(id)
    setLinks(next)
  }

  const chosen = (candidates ?? []).filter((c) => selected.has(linkKey(c.from, c.to)))

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog links-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>Cross-database links</h2>
        <p className="muted small">
          Links let {APP_NAME} jump between databases that can't join each other, e.g. an order in one database to its job in another.
          Discovery matches column names, then checks real values on both sides. Everything is read-only.
        </p>

        {others.length === 0 ? (
          <div className="muted">Add a second connection to link databases.</div>
        ) : (
          <div className="links-pair">
            <span className={`pill env-${self?.env}`}><span className="env-dot" />{self?.name}</span>
            <span className="muted">and</span>
            <select value={otherId} onChange={(e) => { setOtherId(e.target.value); setCandidates(null) }}>
              {others.map((c: ConnectionConfig) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="primary" disabled={busy || !otherId} onClick={discover}>
              {busy ? 'Checking both databases…' : 'Find links'}
            </button>
          </div>
        )}

        {error && <div className="status error">{error}</div>}

        {candidates && (
          <section className="links-section">
            <div className="section-title">Suggested ({groups.length})</div>
            {!groups.length && <div className="muted pad">No new links found. Anything already saved or dismissed isn't suggested again.</div>}
            {groups.map((g) => {
              const keys = g.items.map((i) => linkKey(i.from, i.to))
              const all = keys.every((k) => selected.has(k))
              const some = keys.some((k) => selected.has(k))
              const open = expanded.has(g.key)
              return (
                <div key={g.key} className="link-group">
                  <div className="link-row">
                    <input
                      type="checkbox"
                      checked={all}
                      ref={(el) => { if (el) el.indeterminate = some && !all }}
                      onChange={(e) => toggle(keys, e.target.checked)}
                    />
                    <LinkLabel group={g} name={name} env={env} />
                    <span className={`overlap ${ratio(g.items) >= STRONG ? 'strong' : ''}`} title="Share of sampled values found on the other side">{pct(g.items)}</span>
                    <button className="link small" onClick={() => setExpanded((prev) => { const n = new Set(prev); if (open) n.delete(g.key); else n.add(g.key); return n })}>
                      {open ? 'hide' : `${g.items.length} table${g.items.length === 1 ? '' : 's'}`}
                    </button>
                    <button className="link small muted" title="Don't suggest these again" onClick={() => save('dismissed', g.items)}>dismiss</button>
                  </div>
                  {open && (
                    <div className="link-items">
                      {g.items.map((i) => {
                        const k = linkKey(i.from, i.to)
                        return (
                          <label key={k} className="link-item">
                            <input type="checkbox" checked={selected.has(k)} onChange={(e) => toggle([k], e.target.checked)} />
                            <span>{i.from.table.name}</span>
                            <span className="muted">{i.overlap.matched}/{i.overlap.sampled} values found</span>
                          </label>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
            {groups.length > 0 && (
              <div className="dialog-actions">
                <span className="grow muted">{chosen.length} selected</span>
                <button className="primary" disabled={!chosen.length} onClick={() => save('confirmed', chosen)}>Save selected</button>
              </div>
            )}
          </section>
        )}

        <section className="links-section">
          <div className="section-title">Saved links ({pairLinks.length})</div>
          {!pairLinks.length && <div className="muted pad">None yet.</div>}
          {confirmedGroups.map((g) => (
            <div key={g.key} className="link-row">
              <LinkLabel group={g} name={name} env={env} />
              {g.items[0].overlap.sampled > 0 && <span className="overlap strong">{pct(g.items)}</span>}
              <span className="muted small">{g.items.length} table{g.items.length === 1 ? '' : 's'}</span>
              <button className="icon small" title="Remove these links" onClick={() => removeGroup(g)}>✕</button>
            </div>
          ))}
          <ManualLink connectionId={connectionId} otherId={otherId} />
        </section>

        <div className="dialog-actions">
          <span className="grow" />
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}

function LinkLabel({ group, name, env }: { group: Group; name(id: string): string; env(id: string): string }) {
  return (
    <span className="link-label">
      <span className={`env-${env(group.from.connectionId)}`}><span className="env-dot" /></span>
      <strong>{name(group.from.connectionId)}</strong>
      <code>{group.items.length === 1 ? `${group.items[0].from.table.name}.` : ''}{group.from.column}</code>
      <span className="muted">→</span>
      <span className={`env-${env(group.to.connectionId)}`}><span className="env-dot" /></span>
      <strong>{name(group.to.connectionId)}</strong>
      <code>{group.to.table.name}.{group.to.column}</code>
    </span>
  )
}

/** Hand-entered link for columns whose names don't give the relationship away. */
function ManualLink({ connectionId, otherId }: { connectionId: string; otherId: string }) {
  const { tables, loadTables, setLinks, connections } = useAppState()
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState({ connectionId, table: '', column: '' })
  const [to, setTo] = useState({ connectionId: otherId, table: '', column: '' })
  const [status, setStatus] = useState<string | null>(null)

  useEffect(() => setTo((t) => ({ ...t, connectionId: otherId })), [otherId])
  useEffect(() => {
    if (!open) return
    loadTables(from.connectionId)
    loadTables(to.connectionId)
  }, [open, from.connectionId, to.connectionId, loadTables])

  const parse = (end: { connectionId: string; table: string; column: string }): LinkEnd | null => {
    const found = tables[end.connectionId]?.tables.find((t) => `${t.schema}.${t.name}`.toLowerCase() === end.table.toLowerCase() || t.name.toLowerCase() === end.table.toLowerCase())
    return found && end.column ? { connectionId: end.connectionId, table: { schema: found.schema, name: found.name }, column: end.column } : null
  }

  const add = async (): Promise<void> => {
    const f = parse(from)
    const t = parse(to)
    if (!f || !t) {
      setStatus('Pick a table and column on both sides.')
      return
    }
    setStatus('Checking values…')
    try {
      const overlap = await window.api.verifyLink(f, t)
      setLinks(await window.api.saveLinks([{ id: '', from: f, to: t, status: 'confirmed', source: 'manual', overlap }]))
      setStatus(`Saved. ${overlap.matched} of ${overlap.sampled} sampled values found on the other side.`)
    } catch (e) {
      setStatus((e as Error).message)
    }
  }

  if (!open) return <button className="link small" onClick={() => setOpen(true)}>+ Add a link by hand</button>

  return (
    <div className="manual-link">
      <EndPicker label="From (the column holding the reference)" end={from} onChange={setFrom} connections={connections} />
      <EndPicker label="To (the key it points at)" end={to} onChange={setTo} connections={connections} />
      <div className="row-gap">
        <button className="primary" onClick={add}>Check and save</button>
        <button onClick={() => setOpen(false)}>Cancel</button>
        {status && <span className="muted small">{status}</span>}
      </div>
    </div>
  )
}

function EndPicker({ label, end, onChange, connections }: {
  label: string
  end: { connectionId: string; table: string; column: string }
  onChange(end: { connectionId: string; table: string; column: string }): void
  connections: ConnectionConfig[]
}) {
  const { tables, loadTables } = useAppState()
  const [columns, setColumns] = useState<ColumnInfo[]>([])
  const list = tables[end.connectionId]?.tables ?? []
  const match = list.find((t) => t.name.toLowerCase() === end.table.toLowerCase() || `${t.schema}.${t.name}`.toLowerCase() === end.table.toLowerCase())
  const listId = `tables-${label.length}-${end.connectionId}`

  useEffect(() => {
    if (!match) return setColumns([])
    window.api.describeTable(end.connectionId, match).then((d) => setColumns(d.columns)).catch(() => setColumns([]))
  }, [end.connectionId, match?.schema, match?.name])

  return (
    <div className="end-picker">
      <div className="muted small">{label}</div>
      <div className="form-row">
        <select value={end.connectionId} onChange={(e) => { loadTables(e.target.value); onChange({ connectionId: e.target.value, table: '', column: '' }) }}>
          {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input list={listId} placeholder="table" value={end.table} onChange={(e) => onChange({ ...end, table: e.target.value, column: '' })} />
        <datalist id={listId}>{list.map((t) => <option key={`${t.schema}.${t.name}`} value={`${t.schema}.${t.name}`} />)}</datalist>
        <select value={end.column} onChange={(e) => onChange({ ...end, column: e.target.value })} disabled={!columns.length}>
          <option value="">column</option>
          {columns.map((c) => <option key={c.name} value={c.name}>{c.name} ({c.dataType})</option>)}
        </select>
      </div>
    </div>
  )
}
