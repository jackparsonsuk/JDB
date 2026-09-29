import { app, BrowserWindow, dialog, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import type { CellValue, DbKind, ExportResult, TableExportRequest, TableRef } from '@shared/types'
import { formatRows, type CopyFormat } from '@shared/rows'
import { xlsxParts } from '@shared/xlsx'
import { zip } from './zip'
import * as db from './db'

/** Table exports stop here: test databases are often shared, so even an explicit export stays bounded. */
export const EXPORT_ROW_LIMIT = 100_000
const EXPORT_BATCH = 5000

type FileFormat = CopyFormat | 'xlsx'

const FORMATS: { format: FileFormat; name: string; ext: string }[] = [
  { format: 'xlsx', name: 'Excel workbook', ext: 'xlsx' },
  { format: 'csv', name: 'CSV', ext: 'csv' },
  { format: 'tsv', name: 'Tab-separated', ext: 'tsv' },
  { format: 'json', name: 'JSON', ext: 'json' },
  { format: 'markdown', name: 'Markdown table', ext: 'md' },
  { format: 'insert', name: 'SQL INSERT statements', ext: 'sql' }
]

let lastFormat: FileFormat = 'xlsx'
let lastDir: string | undefined

/** Asks where to save; the chosen file's extension picks the format, and the last choice is offered first next time. */
async function chooseFile(suggestedName: string): Promise<{ path: string; format: FileFormat } | null> {
  const first = FORMATS.find((f) => f.format === lastFormat) ?? FORMATS[0]
  const ordered = [first, ...FORMATS.filter((f) => f !== first)]
  const safeName = suggestedName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
  const date = new Date().toISOString().slice(0, 10)
  const options = {
    title: 'Export rows',
    defaultPath: join(lastDir ?? app.getPath('downloads'), `${safeName} ${date}.${first.ext}`),
    filters: ordered.map((f) => ({ name: f.name, extensions: [f.ext] }))
  }
  const window = BrowserWindow.getFocusedWindow()
  const choice = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  if (choice.canceled || !choice.filePath) return null

  const ext = extname(choice.filePath).slice(1).toLowerCase()
  const format = FORMATS.find((f) => f.ext === ext)?.format ?? 'csv'
  lastFormat = format
  lastDir = dirname(choice.filePath)
  return { path: choice.filePath, format }
}

async function write(
  path: string,
  format: FileFormat,
  columns: string[],
  rows: CellValue[][],
  target: { kind: DbKind; table?: TableRef; sheet: string }
): Promise<void> {
  if (format === 'xlsx') {
    const parts = xlsxParts(target.sheet, columns, rows)
    await writeFile(path, zip(parts.map((p) => ({ path: p.path, data: Buffer.from(p.content, 'utf8') }))))
    return
  }
  const text = formatRows(format, columns, rows, target)
  // A byte-order mark makes Excel open CSV and TSV as UTF-8 instead of the local code page.
  await writeFile(path, format === 'csv' || format === 'tsv' ? `﻿${text}\r\n` : `${text}\n`, 'utf8')
}

/** Saves rows the renderer already holds, such as a query's result set. */
export async function exportRows(columns: string[], rows: CellValue[][], kind: DbKind, suggestedName: string): Promise<ExportResult | null> {
  const file = await chooseFile(suggestedName)
  if (!file) return null
  await write(file.path, file.format, columns, rows, { kind, sheet: suggestedName })
  return { path: file.path, rows: rows.length, truncated: false }
}

/** Saves every row of a table view, fetched in pages after the file is chosen. */
export async function exportTable(connectionId: string, kind: DbKind, request: TableExportRequest): Promise<ExportResult | null> {
  const file = await chooseFile(request.table.name)
  if (!file) return null

  let columns: string[] = []
  const rows: CellValue[][] = []
  let hasMore = true
  while (hasMore && rows.length < EXPORT_ROW_LIMIT) {
    const limit = Math.min(EXPORT_BATCH, EXPORT_ROW_LIMIT - rows.length)
    const page = await db.fetchRows(connectionId, { ...request, limit, offset: rows.length })
    columns = page.columns
    rows.push(...page.rows)
    hasMore = page.hasMore
  }
  await write(file.path, file.format, columns, rows, { kind, table: request.table, sheet: request.table.name })
  return { path: file.path, rows: rows.length, truncated: hasMore }
}

export function showExported(path: string): void {
  shell.showItemInFolder(path)
}
