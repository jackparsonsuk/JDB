import { useEffect, useMemo, useState } from 'react'
import type { DbKind } from '@shared/types'
import { applyCrossLinks, buildModel, type Model } from '@shared/nl/model'
import { translate, type TranslateResult, type ValueCache } from '@shared/nl/translate'

const VALUE_LIMIT = 60

interface Engine {
  model: Promise<Model>
  values: ValueCache
  pending: Set<string>
}

/** One engine per connection, shared by every query tab, so the schema is read once. */
const engines = new Map<string, Engine>()

function engineFor(connectionId: string, kind: DbKind): Engine {
  let engine = engines.get(connectionId)
  if (!engine) {
    const model = Promise.all([window.api.describeSchema(connectionId), window.api.listLinks()])
      .then(([schema, links]) => applyCrossLinks(buildModel(schema, kind), connectionId, links))
    engine = { model, values: new Map(), pending: new Set() }
    engines.set(connectionId, engine)
    model.catch(() => engines.delete(connectionId))
  }
  return engine
}

/** Drops the cached schema, e.g. after reconnecting or editing the connection. */
export function forgetNlEngine(connectionId: string): void {
  engines.delete(connectionId)
}

/** Links change how columns resolve, so every engine is rebuilt after they're edited. */
export function forgetAllNlEngines(): void {
  engines.clear()
}

export function useNl(connectionId: string, kind: DbKind, text: string): {
  result: TranslateResult | null
  loading: boolean
  error: string | null
} {
  const [model, setModel] = useState<Model | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    setModel(null)
    setError(null)
    engineFor(connectionId, kind).model
      .then((m) => !cancelled && setModel(m))
      .catch((e) => !cancelled && setError((e as Error).message))
    return () => {
      cancelled = true
    }
  }, [connectionId, kind])

  const result = useMemo(
    () => (model && text.trim() ? translate(text, model, engines.get(connectionId)?.values ?? new Map()) : null),
    // version bumps when lookup values arrive, so recognised words update in place
    [model, text, version, connectionId]
  )

  useEffect(() => {
    const engine = engines.get(connectionId)
    if (!engine || !result?.wanted.length) return
    for (const source of result.wanted) {
      if (engine.pending.has(source.key)) continue
      engine.pending.add(source.key)
      window.api
        .distinctValues(connectionId, source.table, source.column, VALUE_LIMIT, source.via)
        .then((list) => engine.values.set(source.key, list ? list.map(String) : null))
        .catch(() => engine.values.set(source.key, null))
        .finally(() => setVersion((v) => v + 1))
    }
  }, [result, connectionId])

  return { result, loading: !model && !error, error }
}
