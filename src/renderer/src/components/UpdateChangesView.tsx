import type { CellValue } from '@shared/types'
import { DIFF_ROW_LIMIT } from '@shared/writeDiff'
import { displayValue, formatCount } from '../lib/format'
import type { UpdateChanges } from '../lib/updateChanges'

const plural = (n: number, word: string): string => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`

function Value({ value }: { value: CellValue }) {
  return <span className={value === null ? 'null' : undefined}>{displayValue(value)}</span>
}

/**
 * The rows an UPDATE changed, each changed value shown as before → after. `saved`: a table grid
 * save, which can also delete and add rows; those are counted rather than listed.
 */
export function UpdateChangesView({ changes, rowsAffected, saved }: { changes: UpdateChanges; rowsAffected: number; saved?: { deleted: number; inserted: number } }) {
  const others = saved && (
    <>
      {saved.deleted > 0 && <span> · <strong>{plural(saved.deleted, 'row')} deleted</strong></span>}
      {saved.inserted > 0 && <span> · <strong>{plural(saved.inserted, 'row')} added</strong></span>}
    </>
  )
  if ('note' in changes) {
    return (
      <div className="update-changes">
        <div className="update-summary">
          {plural(rowsAffected, 'row')} affected{changes.table ? ` in ${changes.table}` : ''}{others}. The changes can't be shown: {changes.note}
        </div>
      </div>
    )
  }
  const { table, diff } = changes
  const matched = diff.changed.length + diff.unchanged + diff.missing
  return (
    <div className="update-changes">
      <div className="update-summary">
        {saved && matched === 0
          ? <>Saved to {table}</>
          : matched === 0
            ? <strong>No rows in {table} matched, so nothing changed.</strong>
            : <><strong>{plural(diff.changed.length, 'row')} changed</strong> in {table}</>}
        {others}
        {diff.unchanged > 0 && <span className="muted"> · {plural(diff.unchanged, 'row')} matched but already had these values</span>}
        {diff.missing > 0 && <span className="muted"> · {plural(diff.missing, 'row')} couldn't be found by key afterwards (the key changed)</span>}
        {diff.truncated && <span className="muted"> · only the first {formatCount(DIFF_ROW_LIMIT)} rows were compared</span>}
      </div>
      {diff.changed.length > 0 && (
        <div className="update-table-wrap">
          <table className="update-table">
            <thead>
              <tr>
                {diff.keyColumns.map((c) => <th key={`k-${c}`} className="key">{c}</th>)}
                {diff.columns.map((c) => <th key={c}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {diff.changed.map((row, r) => {
                const byColumn = new Map(row.cells.map((cell) => [cell.column, cell]))
                return (
                  <tr key={r}>
                    {row.key.map((v, i) => <td key={`k-${i}`} className="key"><Value value={v} /></td>)}
                    {diff.columns.map((c) => {
                      const cell = byColumn.get(c)
                      return (
                        <td key={c}>
                          {cell && (
                            <>
                              <span className="before"><Value value={cell.before} /></span>
                              <span className="arrow">→</span>
                              <span className="after"><Value value={cell.after} /></span>
                            </>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
