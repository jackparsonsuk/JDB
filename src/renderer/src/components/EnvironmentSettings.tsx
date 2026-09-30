import { useState } from 'react'
import { DEFAULT_ENV_COLORS, type Appearance } from '@shared/appearance'
import { allEnvironments, envIdFor, isBuiltinEnv, SAFETY_LABELS, type EnvironmentDef, type EnvSafety } from '@shared/environments'
import { ACCENT_PRESETS } from '@shared/appearance'
import { useAppState } from '../state'
import { updateAppearance } from '../lib/appearance'
import { confirm } from './Confirm'
import { toast } from './Toast'

const SAFETIES: EnvSafety[] = ['relaxed', 'confirm', 'protected']

/**
 * Settings → Environments: the four built-ins (recolour only) and the user's own, each with a
 * name, colour and safety level. Deleting one in use asks where its connections should go.
 */
export function EnvironmentSettings({ a }: { a: Appearance }) {
  const { environments, saveEnvironments, deleteEnvironment, connections } = useAppState()
  const [removing, setRemoving] = useState<{ id: string; moveTo: string } | null>(null)
  const uses = (id: string): number => connections.filter((c) => c.env === id).length

  const save = (next: EnvironmentDef[]): void => {
    saveEnvironments(next).catch((e) => toast(`Couldn't save environments: ${(e as Error).message}`))
  }
  const change = (id: string, patch: Partial<EnvironmentDef>): void => {
    // While no connection uses it, its id follows its name ("New environment" renamed "UAT" becomes uat).
    const renamed = patch.name && !uses(id) ? { id: envIdFor(patch.name, environments.filter((e) => e.id !== id).map((e) => e.id)) } : {}
    save(environments.map((e) => (e.id === id ? { ...e, ...patch, ...renamed } : e)))
  }

  const setBuiltinColor = (id: keyof typeof DEFAULT_ENV_COLORS, color: string | undefined): void => {
    const env = { ...a.env }
    if (color && color !== DEFAULT_ENV_COLORS[id]) env[id] = color
    else delete env[id]
    updateAppearance({ env: Object.keys(env).length ? env : undefined })
  }

  const add = (): void => {
    const name = 'New environment'
    const unused = ACCENT_PRESETS.map((p) => p.color).find((c) => !environments.some((e) => e.color === c)) ?? ACCENT_PRESETS[0].color
    save([...environments, { id: envIdFor(name, environments.map((e) => e.id)), name, safety: 'confirm', color: unused }])
  }

  const remove = async (env: EnvironmentDef, moveTo?: string): Promise<void> => {
    const count = uses(env.id)
    if (!count) {
      const ok = await confirm({ title: `Delete ${env.name}?`, message: 'No connections use it.', confirmLabel: 'Delete environment', tone: 'danger' })
      if (!ok) return
    }
    try {
      await deleteEnvironment(env.id, moveTo ?? 'test')
      setRemoving(null)
      toast(count ? `Deleted ${env.name}; its ${count} connection${count === 1 ? '' : 's'} moved` : `Deleted ${env.name}`)
    } catch (e) {
      toast(`Couldn't delete it: ${(e as Error).message}`)
    }
  }

  return (
    <section className="settings-group">
      <div className="settings-group-head">
        <h3>Environments</h3>
        {a.env && <button className="linkish" onClick={() => updateAppearance({ env: undefined })}>Reset built-in colours</button>}
      </div>
      <p className="settings-note">
        Each connection belongs to one. Its colour marks tabs, dots and banners; its safety decides how careful
        writes are. The four built-ins keep their names and safety, so prod always means protected.
      </p>
      <div className="env-list">
        {allEnvironments(environments).map((env) => {
          const builtin = isBuiltinEnv(env.id)
          const color = builtin ? a.env?.[env.id as keyof typeof DEFAULT_ENV_COLORS] ?? env.color : env.color
          const count = uses(env.id)
          return (
            <div key={env.id} className={`env-item env-${env.id} ${removing?.id === env.id ? 'removing' : ''}`}>
              <div className="env-item-main">
                <label className="color-well" title={`Pick the ${env.name} colour`}>
                  <span style={{ background: color }} />
                  <input
                    type="color"
                    value={color}
                    onChange={(e) => (builtin ? setBuiltinColor(env.id as keyof typeof DEFAULT_ENV_COLORS, e.target.value) : change(env.id, { color: e.target.value }))}
                  />
                </label>
                {builtin ? (
                  <span className="env-item-name">{env.name}<span className="env-lock" title="Built-in: name and safety are fixed">🔒</span></span>
                ) : (
                  <NameInput value={env.name} onCommit={(name) => change(env.id, { name })} />
                )}
                {builtin ? (
                  <span className={`safety-badge ${env.safety}`} title={SAFETY_LABELS[env.safety].note}>{SAFETY_LABELS[env.safety].name}</span>
                ) : (
                  <select className={`safety-select ${env.safety}`} value={env.safety} onChange={(e) => change(env.id, { safety: e.target.value as EnvSafety })} title={SAFETY_LABELS[env.safety].note}>
                    {SAFETIES.map((s) => <option key={s} value={s}>{SAFETY_LABELS[s].name}</option>)}
                  </select>
                )}
                <span className="env-uses muted">{count ? `${count} connection${count === 1 ? '' : 's'}` : 'unused'}</span>
                <span className="env-row-actions">
                  {builtin && a.env?.[env.id as keyof typeof DEFAULT_ENV_COLORS] && (
                    <button className="linkish" onClick={() => setBuiltinColor(env.id as keyof typeof DEFAULT_ENV_COLORS, undefined)}>Default colour</button>
                  )}
                  {!builtin && (
                    <button
                      className="icon small"
                      title={`Delete ${env.name}`}
                      onClick={() => (count ? setRemoving({ id: env.id, moveTo: 'test' }) : remove(env))}
                    >
                      ✕
                    </button>
                  )}
                </span>
              </div>
              <div className="env-item-note muted">{SAFETY_LABELS[env.safety].note}.</div>
              {removing?.id === env.id && (
                <div className="env-remove">
                  <span>Move its {count} connection{count === 1 ? '' : 's'} to</span>
                  <select value={removing.moveTo} onChange={(e) => setRemoving({ id: env.id, moveTo: e.target.value })}>
                    {allEnvironments(environments).filter((e) => e.id !== env.id).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                  <button className="primary danger-solid" onClick={() => remove(env, removing.moveTo)}>Delete {env.name}</button>
                  <button onClick={() => setRemoving(null)}>Cancel</button>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <button className="add-env" onClick={add}>＋ Add environment</button>
    </section>
  )
}

/** A name box that saves when you leave it or press Enter, not on every keystroke. */
function NameInput({ value, onCommit }: { value: string; onCommit(name: string): void }) {
  const [draft, setDraft] = useState(value)
  const commit = (): void => {
    const name = draft.trim().slice(0, 24)
    if (name && name !== value) onCommit(name)
    else setDraft(value)
  }
  return (
    <input
      className="env-name-input"
      value={draft}
      maxLength={24}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(value)
          e.stopPropagation()
        }
      }}
      onFocus={(e) => e.currentTarget.select()}
    />
  )
}
