import { useEffect, useMemo, useState } from 'react'
import type { ConnectionConfig, CrossLink } from '@shared/types'
import { applyCrossLinks, attachRemote, buildModel, type Model } from '@shared/nl/model'
import { translate, type TranslateResult, type ValueCache } from '@shared/nl/translate'

const VALUE_LIMIT = 60

interface Engine {
  model: Promise<Model>
  values: ValueCache
  pending: Set<string>
}

/**
 * One engine per connection (and set of reachable linked connections), shared by every query tab,
 * so each schema is read once.
 */
const engines = new Map<string, Engine>()

function engineFor(connection: ConnectionConfig, remotes: ConnectionConfig[]): { key: string; engine: Engine } {
  const key = `${connection.id}|${remotes.map((r) => r.id).sort().join(',')}`
  let engine = engines.get(key)
  if (!engine) {
    const model = (async () => {
      const [schema, links] = await Promise.all([window.api.describeSchema(connection.id), window.api.listLinks()])
      const local = buildModel(schema, connection.kind)
      local.connection = { id: connection.id, name: connection.name }
      const loaded = new Map<string, { model: Model; name: string }>()
      await Promise.all(remotes.map(async (r) => {
        try {
          loaded.set(r.id, { model: buildModel(await window.api.describeSchema(r.id), r.kind), name: r.name })
        } catch {
          // A linked database we can't read just isn't included; the local model still works.
        }
      }))
      // Links fix wrong naming guesses even when the other side isn't loaded.
      return attachRemote(applyCrossLinks(local, connection.id, links), connection.id, links, loaded)
    })()
    engine = { model, values: new Map(), pending: new Set() }
    engines.set(key, engine)
    model.catch(() => engines.delete(key))
  }
  return { key, engine }
}

/** The connection's own model (no linked databases), shared with the Ask engine's cache; used by SQL autocompletion. */
export function localModel(connection: ConnectionConfig): Promise<Model> {
  return engineFor(connection, []).engine.model
}

/** Drops cached schemas involving a connection, e.g. after reconnecting or editing it. */
export function forgetNlEngine(connectionId: string): void {
  for (const key of [...engines.keys()]) {
    const [own, remotes] = key.split('|')
    if (own === connectionId || remotes.split(',').includes(connectionId)) engines.delete(key)
  }
}

/** Links change how columns resolve, so every engine is rebuilt after they're edited. */
export function forgetAllNlEngines(): void {
  engines.clear()
}

/** Connections linked to this one, split into those connected this session and those not. */
export function linkedConnections(connectionId: string, links: CrossLink[], connections: ConnectionConfig[], connected: Set<string>) {
  const ids = new Set(links.filter((l) => l.status === 'confirmed').flatMap((l) =>
    l.from.connectionId === connectionId ? [l.to.connectionId] : l.to.connectionId === connectionId ? [l.from.connectionId] : []))
  const linked = connections.filter((c) => ids.has(c.id))
  return { ready: linked.filter((c) => connected.has(c.id)), notConnected: linked.filter((c) => !connected.has(c.id)) }
}

export function useNl(connection: ConnectionConfig, remotes: ConnectionConfig[], text: string): {
  result: TranslateResult | null
  loading: boolean
  error: string | null
} {
  const [model, setModel] = useState<Model | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const remoteKey = remotes.map((r) => r.id).sort().join(',')

  // Keyed on ids so a re-render with equal connections doesn't rebuild the engine.
  const { key, engine } = useMemo(() => engineFor(connection, remotes), [connection.id, connection.kind, remoteKey])

  useEffect(() => {
    let cancelled = false
    setModel(null)
    setError(null)
    engine.model
      .then((m) => !cancelled && setModel(m))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [engine])

  const result = useMemo(
    () => (model && text.trim() ? translate(text, model, engine.values) : null),
    // version bumps when lookup values arrive, so recognised words update in place
    [model, text, version, key]
  )

  useEffect(() => {
    if (!result?.wanted.length) return
    for (const source of result.wanted) {
      if (engine.pending.has(source.key)) continue
      engine.pending.add(source.key)
      window.api
        .distinctValues(connection.id, source.table, source.column, VALUE_LIMIT, source.via)
        .then((list) => engine.values.set(source.key, list ? list.map(String) : null))
        .catch(() => engine.values.set(source.key, null))
        .finally(() => setVersion((v) => v + 1))
    }
  }, [result, connection.id, engine])

  return { result, loading: !model && !error, error }
}
