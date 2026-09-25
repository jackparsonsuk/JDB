import type { CellValue, QueryResult, ResultSet } from '@shared/types'
import { keyPredicate, valueList, type FederatedPlan, type FederatedStep } from '@shared/nl/federated'

/** Values per IN list when looking up extra columns, well under SQL Server's limits. */
const ENRICH_BATCH = 500

export interface StepRun {
  step: FederatedStep
  durationMs: number
  rows: number
}

function distinctStrings(values: CellValue[]): string[] {
  return [...new Set(values.filter((v): v is string | number | boolean => v !== null).map(String))]
}

/**
 * Runs a cross-database plan step by step through the normal (read-only guarded) query path,
 * then merges looked-up columns into the main result so it reads as one grid.
 */
export async function runFederated(plan: FederatedPlan, onStep: (step: FederatedStep) => void): Promise<{ result: QueryResult; runs: StepRun[] }> {
  const keys = new Map<number, string[]>()
  const runs: StepRun[] = []
  let main: ResultSet | null = null
  let rowsAffected: number[] = []
  const started = Date.now()

  for (const step of plan.steps) {
    onStep(step)
    const t0 = Date.now()

    if (step.role === 'keys') {
      const r = await window.api.runQuery(step.connectionId, step.sql)
      const values = distinctStrings((r.resultSets[0]?.rows ?? []).map((row) => row[0]))
      if (values.length > plan.keyLimit) {
        throw new Error(`Step ${step.index} (${step.connectionName}) matched more than ${plan.keyLimit.toLocaleString()} rows. Add a filter to narrow it down.`)
      }
      keys.set(step.index, values)
      runs.push({ step, durationMs: Date.now() - t0, rows: values.length })
    } else if (step.role === 'main') {
      let sql = step.sql
      for (const p of step.placeholders) sql = sql.replace(p.token, keyPredicate(p, keys.get(p.step) ?? [], step.kind))
      const r = await window.api.runQuery(step.connectionId, sql)
      main = r.resultSets[0] ?? { columns: [], rows: [] }
      rowsAffected = r.rowsAffected
      runs.push({ step, durationMs: Date.now() - t0, rows: main.rows.length })
    } else if (step.role === 'enrich' && main && step.enrich) {
      const source = main.columns.findIndex((c) => c.toLowerCase() === step.enrich!.sourceColumn.toLowerCase())
      const lookup = new Map<string, CellValue[]>()
      const values = source >= 0 ? distinctStrings(main.rows.map((row) => row[source])) : []
      for (let i = 0; i < values.length; i += ENRICH_BATCH) {
        const list = valueList(values.slice(i, i + ENRICH_BATCH), step.enrich.keyType, step.kind)
        if (!list) continue
        const r = await window.api.runQuery(step.connectionId, step.sql.replace('{{values}}', list))
        // GUIDs can differ in case between servers, so match keys case-insensitively.
        for (const row of r.resultSets[0]?.rows ?? []) lookup.set(String(row[0]).toLowerCase(), row.slice(1))
      }
      const width = step.enrich.addedColumns.length
      main = {
        columns: [...main.columns, ...step.enrich.addedColumns],
        rows: main.rows.map((row) => {
          const found = source >= 0 && row[source] !== null ? lookup.get(String(row[source]).toLowerCase()) : undefined
          return [...row, ...(found ?? new Array(width).fill(null))]
        })
      }
      runs.push({ step, durationMs: Date.now() - t0, rows: lookup.size })
    }
  }

  return {
    result: { resultSets: main ? [main] : [], rowsAffected, durationMs: Date.now() - started },
    runs
  }
}
