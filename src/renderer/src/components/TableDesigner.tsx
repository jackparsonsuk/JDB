import { useEffect, useMemo, useState } from 'react'
import type { DesignColumn, TableDesign } from '@shared/types'
import { countChanges, designProblems, designSql, draftsFrom, TYPE_SUGGESTIONS, type ColumnDraft } from '@shared/design'
import { useAppState, useCloseWarning, type Tab } from '../state'
import { LoadingBar } from './DataGrid'
import { SaveChangesDialog } from './SaveChangesDialog'
import { toast } from './Toast'

const NOTES = {
  mssql: 'These run in one transaction, so if any step fails nothing changes. Changing a column\'s type can rewrite and lock the whole table while it runs.',
  mysql: 'MySQL applies this as one ALTER TABLE, so it all happens or none of it does, but it commits at once and can\'t be rolled back afterwards. It can rebuild and lock a big table while it runs.'
}

/** A table's structure: columns (editable on writable connections), indexes, and keys in and out. */
export function TableDesigner({ tab }: { tab: Extract<Tab, { kind: 'design' }> }) {
  const { connection, openTable, openQuery, open, schemaVersions, schemaChanged } = useAppState()
  const conn = connection(tab.connectionId)
  const [design, setDesign] = useState<TableDesign | null>(null)
  const [drafts, setDrafts] = useState<ColumnDraft[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadKey, setReloadKey] = useState(0)
  const [reviewing, setReviewing] = useState<string[] | null>(null)
  const version = schemaVersions[tab.connectionId] ?? 0

  useEffect(() => {
    let live = true
    setLoading(true)
    window.api.describeDesign(tab.connectionId, tab.table)
      .then((d) => {
        if (!live) return
        setDesign(d)
        setDrafts(draftsFrom(d))
        setError(null)
      })
      .catch((e) => live && setError((e as Error).message))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [tab.connectionId, tab.table, reloadKey, version])

  const changes = design ? countChanges(design, drafts) : 0
  const problems = useMemo(() => (design ? designProblems(design, drafts) : []), [design, drafts])
  useCloseWarning(tab.id, changes ? `${changes} unsaved column change${changes === 1 ? '' : 's'} to ${tab.table.name} will be lost.` : null)

  if (!conn) return null
  const editable = !conn.readOnly
  const byName = new Map<string, DesignColumn>(design?.columns.map((c) => [c.name, c]) ?? [])

  const update = (i: number, patch: Partial<ColumnDraft>): void => setDrafts((d) => d.map((draft, j) => (j === i ? { ...draft, ...patch } : draft)))
  const toggleDrop = (i: number): void => {
    const draft = drafts[i]
    if (draft.original === undefined) setDrafts((d) => d.filter((_, j) => j !== i))
    else update(i, { drop: !draft.drop })
  }
  const revert = (i: number): void => {
    const original = drafts[i].original !== undefined ? byName.get(drafts[i].original!) : undefined
    if (original) update(i, { name: original.name, dataType: original.dataType, nullable: original.nullable, default: original.default ?? '', drop: false })
  }
  const addColumn = (): void =>
    setDrafts((d) => [...d, { name: '', dataType: conn.kind === 'mssql' ? 'nvarchar(50)' : 'varchar(255)', nullable: true, default: '' }])

  const refresh = (): void => {
    if (changes && !window.confirm(`Discard ${changes} unsaved change${changes === 1 ? '' : 's'} and reload?`)) return
    setReloadKey((k) => k + 1)
  }

  const review = (): void => {
    if (!design) return
    try {
      setReviewing(designSql(conn.kind, tab.table, design, drafts))
    } catch (e) {
      toast((e as Error).message)
    }
  }

  return (
    <div className="view">
      <div className="toolbar">
        <div className="toolbar-title">
          <span className="muted">{tab.table.schema}.</span>
          <strong>{tab.table.name}</strong>
          <span className="count">{design ? `${design.columns.length} columns · ${design.indexes.length} indexes` : ''}</span>
        </div>
        {!editable && <span className="muted hint">Read-only connection: structure only</span>}
        <div className="toolbar-right">
          {editable && <button className="ghost" onClick={addColumn} disabled={!design}>+ Column</button>}
          <button className="ghost" onClick={() => openTable(tab.connectionId, tab.table)}>Open data</button>
          <button className="ghost" title="Reload the structure" onClick={refresh}>⟳</button>
        </div>
      </div>

      {error && <div className="error-bar">{error}</div>}

      {changes > 0 && (
        <div className={`edit-bar env-${conn.env}`}>
          <span className="env-dot" />
          <strong>{changes} unsaved column change{changes === 1 ? '' : 's'}</strong>
          <span className={problems.length ? 'design-problem' : 'muted'} title={problems.join('\n')}>
            {problems.length ? `${problems[0]}${problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}` : 'Nothing changes until you review and apply'}
          </span>
          <div className="toolbar-right">
            <button onClick={() => design && setDrafts(draftsFrom(design))}>Discard</button>
            <button className="primary" disabled={problems.length > 0} onClick={review}>Review &amp; apply…</button>
          </div>
        </div>
      )}

      <div className="designer">
        {loading && !design && <LoadingBar label="Reading the table structure…" overlay={false} />}
        {design && (
          <>
            <section>
              <h3>Columns</h3>
              <datalist id={`types-${conn.kind}`}>
                {TYPE_SUGGESTIONS[conn.kind].map((t) => <option key={t} value={t} />)}
              </datalist>
              <table className="design-table">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Name</th>
                    <th>Data type</th>
                    <th title="Allows NULL">Null</th>
                    <th>Default</th>
                    <th>Key / notes</th>
                    {editable && <th />}
                  </tr>
                </thead>
                <tbody>
                  {drafts.map((draft, i) => {
                    const original = draft.original !== undefined ? byName.get(draft.original) : undefined
                    const changed = (field: keyof ColumnDraft, value: unknown): string =>
                      original && !draft.drop && String(value) !== String(field === 'default' ? original.default ?? '' : original[field as keyof DesignColumn]) ? 'changed' : ''
                    const computed = !!original?.computed
                    const state = draft.drop ? 'dropped' : !original ? 'added' : ''
                    return (
                      <tr key={i} className={state}>
                        <td className="num muted">{i + 1}</td>
                        <td className={changed('name', draft.name)}>
                          <input value={draft.name} disabled={!editable || draft.drop} placeholder="column name" onChange={(e) => update(i, { name: e.target.value })} />
                        </td>
                        <td className={changed('dataType', draft.dataType)}>
                          <input
                            list={`types-${conn.kind}`}
                            value={draft.dataType}
                            disabled={!editable || draft.drop || computed}
                            onChange={(e) => update(i, { dataType: e.target.value })}
                          />
                        </td>
                        <td className={`center ${changed('nullable', draft.nullable)}`}>
                          <input
                            type="checkbox"
                            checked={draft.nullable}
                            disabled={!editable || draft.drop || computed || !!original?.isPrimaryKey}
                            onChange={(e) => update(i, { nullable: e.target.checked })}
                          />
                        </td>
                        <td className={changed('default', draft.default)}>
                          <input
                            value={draft.default}
                            disabled={!editable || draft.drop || computed || !!original?.isIdentity || !!original?.defaultHidden}
                            title={original?.defaultHidden ? `${original.defaultConstraint}: this login can't read the definition (needs VIEW DEFINITION)` : undefined}
                            placeholder={original?.defaultHidden ? 'has a default (hidden)' : editable && !computed && !original?.isIdentity && !draft.drop ? (conn.kind === 'mssql' ? "e.g. 0, 'text', GETDATE()" : "e.g. 0, 'text', CURRENT_TIMESTAMP") : ''}
                            onChange={(e) => update(i, { default: e.target.value })}
                          />
                        </td>
                        <td className="design-notes">
                          {original?.isPrimaryKey && <span className="badge pk">PK</span>}
                          {original?.isIdentity && <span className="badge" title="Filled in by the database">{conn.kind === 'mssql' ? 'identity' : 'auto_increment'}</span>}
                          {original?.references && (
                            <button
                              className="link"
                              title="Open the referenced table's design"
                              onClick={() => open({ kind: 'design', connectionId: tab.connectionId, table: { schema: original.references!.schema, name: original.references!.name } })}
                            >
                              <span className="badge fk">FK</span> {original.references.name}.{original.references.column}
                            </button>
                          )}
                          {computed && <span className="muted" title={original!.computed}>= {original!.computed}</span>}
                          {original?.extra && !original.isIdentity && <span className="muted">{original.extra}</span>}
                          {original?.comment && <span className="muted" title="Comment">“{original.comment}”</span>}
                        </td>
                        {editable && (
                          <td className="design-actions">
                            {state === '' && (changed('name', draft.name) || changed('dataType', draft.dataType) || changed('nullable', draft.nullable) || changed('default', draft.default)) && (
                              <button className="icon small" title="Undo changes to this column" onClick={() => revert(i)}>↺</button>
                            )}
                            <button className="icon small" title={draft.drop ? 'Keep this column' : original ? 'Drop this column' : 'Remove'} onClick={() => toggleDrop(i)}>
                              {draft.drop ? '↺' : '✕'}
                            </button>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>

            <section>
              <h3>Indexes</h3>
              {design.indexes.length ? (
                <table className="design-table compact">
                  <thead><tr><th>Name</th><th>Columns</th><th>Kind</th></tr></thead>
                  <tbody>
                    {design.indexes.map((ix) => (
                      <tr key={ix.name}>
                        <td className="mono">{ix.name}</td>
                        <td className="mono">
                          {ix.columns.join(', ')}
                          {ix.included.length > 0 && <span className="muted"> include ({ix.included.join(', ')})</span>}
                        </td>
                        <td>{[ix.primary ? 'primary key' : ix.unique ? 'unique' : '', ix.type].filter(Boolean).join(' · ')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="muted pad">No indexes.</div>}
            </section>

            <section>
              <h3>Foreign keys</h3>
              {design.foreignKeys.length ? (
                <table className="design-table compact">
                  <thead><tr><th>Name</th><th>Columns</th><th>References</th><th>On delete / update</th></tr></thead>
                  <tbody>
                    {design.foreignKeys.map((fk) => (
                      <tr key={fk.name}>
                        <td className="mono">{fk.name}</td>
                        <td className="mono">{fk.columns.join(', ')}</td>
                        <td className="mono">
                          <button className="link" onClick={() => open({ kind: 'design', connectionId: tab.connectionId, table: fk.references })}>
                            {fk.references.schema}.{fk.references.name}
                          </button>
                          {' '}({fk.referencedColumns.join(', ')})
                        </td>
                        <td className="muted">{fk.onDelete.toLowerCase()} / {fk.onUpdate.toLowerCase()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="muted pad">No foreign keys.</div>}
            </section>

            <section>
              <h3>Referenced by</h3>
              {design.referencedBy.length ? (
                <table className="design-table compact">
                  <thead><tr><th>Table</th><th>Column</th><th>Points at</th></tr></thead>
                  <tbody>
                    {design.referencedBy.map((r, i) => (
                      <tr key={i}>
                        <td className="mono">
                          <button className="link" onClick={() => open({ kind: 'design', connectionId: tab.connectionId, table: r.table })}>
                            {r.table.schema}.{r.table.name}
                          </button>
                        </td>
                        <td className="mono">{r.column}</td>
                        <td className="mono">{r.referencedColumn}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : <div className="muted pad">No other tables reference this one.</div>}
            </section>
          </>
        )}
      </div>

      {reviewing && (
        <SaveChangesDialog
          connection={conn}
          statements={reviewing}
          noun="statement"
          note={NOTES[conn.kind]}
          run={(statements) => window.api.applyDesign(tab.connectionId, statements)}
          onClose={() => setReviewing(null)}
          onSaved={() => {
            setReviewing(null)
            toast(`Changed ${tab.table.name}`)
            schemaChanged(tab.connectionId)
          }}
          onOpenSql={(sql) => {
            setReviewing(null)
            openQuery(tab.connectionId, sql)
          }}
        />
      )}
    </div>
  )
}
