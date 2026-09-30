/**
 * Environments label connections (local, dev, test, prod, plus any the user adds) and decide how
 * careful the app is with writes:
 * - relaxed: writes run without asking (local)
 * - confirm: writes ask first, saying how many rows they touch (dev, test)
 * - protected: writes are staged in a transaction to commit or roll back, and connections from a
 *   shared file arrive read-only (prod)
 * The four built-ins can't be renamed or have their safety changed, so "prod" always means
 * protected. An environment the app doesn't know (e.g. deleted, or from a newer file) is treated
 * as protected, the safest reading.
 */
export type EnvSafety = 'relaxed' | 'confirm' | 'protected'
export type BuiltinEnv = 'local' | 'dev' | 'test' | 'prod'

export interface EnvironmentDef {
  /** Used in connection configs and CSS classes: lowercase letters, digits and dashes. */
  id: string
  name: string
  safety: EnvSafety
  /** #rrggbb. Built-ins take theirs from the appearance settings instead. */
  color: string
  builtin?: boolean
}

export const DEFAULT_ENV_COLORS: Record<BuiltinEnv, string> = { local: '#3fb950', dev: '#58a6ff', test: '#d29922', prod: '#f85149' }

export const BUILTIN_ENVS: EnvironmentDef[] = [
  { id: 'local', name: 'Local', safety: 'relaxed', color: DEFAULT_ENV_COLORS.local, builtin: true },
  { id: 'dev', name: 'Dev', safety: 'confirm', color: DEFAULT_ENV_COLORS.dev, builtin: true },
  { id: 'test', name: 'Test', safety: 'confirm', color: DEFAULT_ENV_COLORS.test, builtin: true },
  { id: 'prod', name: 'Prod', safety: 'protected', color: DEFAULT_ENV_COLORS.prod, builtin: true }
]

export const SAFETY_LABELS: Record<EnvSafety, { name: string; note: string }> = {
  relaxed: { name: 'Relaxed', note: 'Writes run without asking' },
  confirm: { name: 'Confirm', note: 'Writes ask first, with a row count' },
  protected: { name: 'Protected', note: 'Writes go in a transaction to commit; shared copies arrive read-only' }
}

const SAFETIES: ReadonlySet<string> = new Set<EnvSafety>(['relaxed', 'confirm', 'protected'])
const BUILTIN_IDS: ReadonlySet<string> = new Set(BUILTIN_ENVS.map((e) => e.id))
const ID = /^[a-z][a-z0-9-]{0,23}$/
const HEX = /^#[0-9a-f]{6}$/i
/** How strict each level is, for "never loosen" comparisons. */
const STRICTNESS: Record<EnvSafety, number> = { relaxed: 0, confirm: 1, protected: 2 }
const UNKNOWN_COLOR = '#8b949e'

export const isBuiltinEnv = (id: string): id is BuiltinEnv => BUILTIN_IDS.has(id)

/** An id from a name: "UAT 2" → "uat-2". Adds a number if it's taken. */
export function envIdFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  let base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20)
  if (!base || !/^[a-z]/.test(base)) base = `env-${base}`.replace(/-+$/, '') || 'env'
  let id = base
  for (let n = 2; used.has(id) || BUILTIN_IDS.has(id); n++) id = `${base}-${n}`
  return id
}

/** The user's own environments from storage or a file, keeping only valid ones (never built-ins). */
export function parseEnvironments(raw: unknown): EnvironmentDef[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: EnvironmentDef[] = []
  for (const value of raw) {
    if (typeof value !== 'object' || value === null) continue
    const e = value as Record<string, unknown>
    const id = typeof e.id === 'string' ? e.id : ''
    const name = typeof e.name === 'string' ? e.name.trim() : ''
    if (!ID.test(id) || BUILTIN_IDS.has(id) || seen.has(id) || !name || name.length > 24) continue
    if (typeof e.safety !== 'string' || !SAFETIES.has(e.safety)) continue
    seen.add(id)
    out.push({ id, name, safety: e.safety as EnvSafety, color: typeof e.color === 'string' && HEX.test(e.color) ? e.color.toLowerCase() : UNKNOWN_COLOR })
  }
  return out
}

/** Built-ins then the user's own, in order. */
export function allEnvironments(custom: EnvironmentDef[]): EnvironmentDef[] {
  return [...BUILTIN_ENVS, ...custom]
}

/** An environment by id; one that isn't defined is shown by its id and treated as protected. */
export function envInfo(id: string, custom: EnvironmentDef[]): EnvironmentDef {
  return BUILTIN_ENVS.find((e) => e.id === id) ?? custom.find((e) => e.id === id) ?? { id, name: id, safety: 'protected', color: UNKNOWN_COLOR }
}

export const safetyOf = (id: string, custom: EnvironmentDef[]): EnvSafety => envInfo(id, custom).safety

/**
 * Adds environments from a shared file to the user's own. One already defined here (by id) keeps
 * the user's definition, so a file can never loosen an environment's safety; built-ins are never
 * replaced. Returns the merged list and the names added.
 */
export function mergeEnvironments(mine: EnvironmentDef[], incoming: EnvironmentDef[]): { environments: EnvironmentDef[]; added: string[] } {
  const known = new Set([...BUILTIN_IDS, ...mine.map((e) => e.id)])
  const added: EnvironmentDef[] = []
  for (const e of incoming) {
    if (known.has(e.id)) continue
    known.add(e.id)
    added.push(e)
  }
  return { environments: [...mine, ...added], added: added.map((e) => e.name) }
}

/** Whether `a` is at least as strict as `b`. */
export const atLeastAsStrict = (a: EnvSafety, b: EnvSafety): boolean => STRICTNESS[a] >= STRICTNESS[b]

/** A CSS rule per custom environment, giving its class the colour the built-ins get from the stylesheet. */
export function environmentCss(custom: EnvironmentDef[]): string {
  return custom.filter((e) => ID.test(e.id) && HEX.test(e.color)).map((e) => `.env-${e.id} { --env-color: ${e.color}; }`).join('\n')
}
