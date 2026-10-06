import { useEffect, useState } from 'react'
import type { AuthType, ConnectionConfig, ConnectionInput, DbKind, EnvTag } from '@shared/types'
import { useAppState } from '../state'
import { toast } from './Toast'
import { confirm } from './Confirm'
import { allEnvironments, envInfo, SAFETY_LABELS } from '@shared/environments'
import { APP_NAME } from '@shared/brand'

const DEFAULT_PORTS: Record<DbKind, number> = { mssql: 1433, mysql: 3306 }

const AUTH_LABELS: Record<AuthType, string> = {
  sql: 'Username and password',
  'entra-browser': 'Microsoft Entra ID (sign in with browser)',
  'entra-default': 'Microsoft Entra ID (Visual Studio / VS Code / env login)'
}

function blank(): ConnectionConfig {
  return {
    id: '',
    name: '',
    kind: 'mssql',
    host: '',
    port: 1433,
    database: '',
    user: '',
    authType: 'sql',
    env: 'test',
    readOnly: true
  }
}

export function ConnectionDialog({ initial, onClose }: { initial: ConnectionConfig | null; onClose(): void }) {
  const { connections, reloadConnections, forgetTables, environments } = useAppState()
  const folders = [...new Set(connections.map((c) => c.folder).filter((f): f is string => !!f))].sort()
  const [form, setForm] = useState<ConnectionConfig>(initial ?? blank())
  const [password, setPassword] = useState<string | undefined>(undefined)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'busy'; message: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const set = <K extends keyof ConnectionConfig>(key: K, value: ConnectionConfig[K]): void =>
    setForm((f) => ({ ...f, [key]: value }))

  const setKind = (kind: DbKind): void =>
    setForm((f) => ({
      ...f,
      kind,
      port: f.port === DEFAULT_PORTS[f.kind] ? DEFAULT_PORTS[kind] : f.port,
      authType: kind === 'mysql' ? 'sql' : f.authType
    }))

  const test = async (): Promise<void> => {
    setStatus({ kind: 'busy', message: form.authType === 'entra-browser' ? 'Waiting for browser sign-in…' : 'Connecting…' })
    try {
      await window.api.testConnection(form, password)
      setStatus({ kind: 'ok', message: 'Connected successfully' })
    } catch (e) {
      setStatus({ kind: 'error', message: (e as Error).message })
    }
  }

  const save = async (): Promise<void> => {
    // Saving twice (a double click, or Enter held down) would add the connection twice.
    if (saving || status?.kind === 'busy') return
    if (!form.name.trim() || !form.host.trim()) {
      setStatus({ kind: 'error', message: 'Name and host are required' })
      return
    }
    const folder = form.folder?.trim()
    const input: ConnectionInput = { ...form, folder: folder || undefined, password }
    setSaving(true)
    try {
      const saved = await window.api.saveConnection(input)
      forgetTables(saved.id)
      await reloadConnections()
      toast(`Saved ${saved.name}`)
      onClose()
    } catch (e) {
      setStatus({ kind: 'error', message: (e as Error).message })
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    const ok = await confirm({
      title: `Delete ${form.name}?`,
      message: `This only removes the connection from ${APP_NAME}; nothing changes on the server. Its saved queries stay, as queries for any connection.`,
      confirmLabel: 'Delete connection',
      tone: 'danger'
    })
    if (!ok) return
    try {
      await window.api.deleteConnection(form.id)
      forgetTables(form.id)
      await reloadConnections()
      onClose()
    } catch (e) {
      setStatus({ kind: 'error', message: (e as Error).message })
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // A question on top (e.g. Delete's) answers its own keys.
      if (document.querySelector('.confirm-overlay')) return
      if (e.key === 'Escape') onClose()
      else if (e.key === 'Enter' && !e.isComposing && e.target instanceof HTMLInputElement && e.target.closest('.connection-dialog') && !['checkbox', 'radio'].includes(e.target.type)) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const needsCredentials = form.authType === 'sql'

  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog connection-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h2>{initial ? 'Edit connection' : 'New connection'}</h2>

        <div className="form">
          <label>Name<input autoFocus value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Orders (test)" /></label>

          <label>Type
            <select value={form.kind} onChange={(e) => setKind(e.target.value as DbKind)}>
              <option value="mssql">SQL Server / Azure SQL</option>
              <option value="mysql">MySQL / MariaDB</option>
            </select>
          </label>

          <div className="form-row">
            <label className="grow">Host<input value={form.host} onChange={(e) => set('host', e.target.value)} placeholder="server.database.windows.net" /></label>
            <label className="narrow">Port<input type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value))} /></label>
          </div>

          <label>Database<input value={form.database} onChange={(e) => set('database', e.target.value)} placeholder={form.kind === 'mysql' ? 'blank = all schemas' : 'blank = default'} />
            {form.kind === 'mssql' && !form.database.trim() && /\.database\.windows\.net$/i.test(form.host.trim()) && (
              <span className="field-hint field-warn">Azure SQL connects to master when this is blank, and master has no tables of its own. Enter the database's name.</span>
            )}
          </label>

          {form.kind === 'mssql' && (
            <label>Authentication
              <select value={form.authType} onChange={(e) => set('authType', e.target.value as AuthType)}>
                {(Object.keys(AUTH_LABELS) as AuthType[]).map((a) => <option key={a} value={a}>{AUTH_LABELS[a]}</option>)}
              </select>
            </label>
          )}

          {form.authType === 'entra-browser' && (
            <label><span>Tenant ID <span className="muted">(optional)</span></span>
              <input value={form.tenantId ?? ''} onChange={(e) => set('tenantId', e.target.value)} placeholder="organisation tenant, if sign-in picks the wrong one" />
            </label>
          )}

          {needsCredentials && (
            <div className="form-row">
              <label className="grow">User<input value={form.user} onChange={(e) => set('user', e.target.value)} /></label>
              <label className="grow">Password
                <input
                  type="password"
                  value={password ?? ''}
                  placeholder={form.hasPassword ? '•••••• saved (leave blank to keep)' : ''}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
            </div>
          )}

          <div className="form-row">
            <label className="grow"><span>Folder <span className="muted">(optional)</span></span>
              <input
                list="connection-folders"
                value={form.folder ?? ''}
                onChange={(e) => set('folder', e.target.value || undefined)}
                placeholder="e.g. Clients or Local"
              />
              <datalist id="connection-folders">
                {folders.map((f) => <option key={f} value={f} />)}
              </datalist>
            </label>
            <label className="grow">Environment
              <select value={form.env} onChange={(e) => set('env', e.target.value as EnvTag)}>
                {allEnvironments(environments).map((e) => (
                  <option key={e.id} value={e.id}>{e.name} · {SAFETY_LABELS[e.safety].name.toLowerCase()}</option>
                ))}
                {!allEnvironments(environments).some((e) => e.id === form.env) && <option value={form.env}>{form.env} (not defined, treated as protected)</option>}
              </select>
              <span className="field-hint">{SAFETY_LABELS[envInfo(form.env, environments).safety].note}. Add your own in Settings → Environments.</span>
            </label>
          </div>

          <label className="check">
            <input type="checkbox" checked={form.readOnly} onChange={(e) => set('readOnly', e.target.checked)} />
            <span>Read-only <span className="muted">— blocks INSERT, UPDATE, DELETE, DDL and EXEC from this app</span></span>
          </label>

          {form.kind === 'mssql' && (
            <label className="check">
              <input type="checkbox" checked={form.trustServerCertificate ?? false} onChange={(e) => set('trustServerCertificate', e.target.checked)} />
              <span>Trust server certificate <span className="muted">— only for local/self-signed servers</span></span>
            </label>
          )}
        </div>

        {status && <div className={`status ${status.kind}`}>{status.message}</div>}

        <div className="dialog-actions">
          {initial && <button className="danger" onClick={remove}>Delete</button>}
          <span className="grow" />
          <button onClick={test} disabled={status?.kind === 'busy'}>Test</button>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save} disabled={saving || status?.kind === 'busy'}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}
