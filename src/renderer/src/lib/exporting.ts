import type { ExportResult } from '@shared/types'
import { toast } from '../components/Toast'
import { formatCount } from './format'

/** Runs an export and reports where it went; a cancelled save dialog says nothing. */
export async function runExport(start: () => Promise<ExportResult | null>): Promise<void> {
  try {
    const result = await start()
    if (!result) return
    const name = result.path.split(/[\\/]/).pop()
    const rows = `${formatCount(result.rows)} row${result.rows === 1 ? '' : 's'}`
    toast(
      result.truncated ? `Saved the first ${rows} to ${name} (the export limit)` : `Saved ${rows} to ${name}`,
      false,
      { label: 'Show in folder', run: () => void window.api.showExported(result.path) }
    )
  } catch (e) {
    toast(`Export failed: ${(e as Error).message}`, true)
  }
}
