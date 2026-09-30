import { app, BrowserWindow, dialog, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildCollection, parseCollection, type ImportSummary } from '@shared/collection'
import * as store from './store'
import { APP_NAME } from '@shared/brand'

const FILTERS = [{ name: `${APP_NAME} connections`, extensions: ['json'] }]

/** Collection files are small; anything bigger is not one and isn't worth parsing. */
const MAX_FILE_BYTES = 5 * 1024 * 1024

/** Saves connections (all, or just `ids`) to a shareable file. Returns the path, or null if cancelled. */
export async function exportConnections(ids: string[] | null, suggestedName: string): Promise<{ path: string; connections: number; links: number; queries: number } | null> {
  const all = store.listConnections()
  const chosen = ids ? all.filter((c) => ids.includes(c.id)) : all
  if (!chosen.length) throw new Error('There are no connections to export.')
  const safeName = suggestedName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
  const options: SaveDialogOptions = {
    title: 'Export connections',
    defaultPath: join(app.getPath('documents'), `${safeName}.jdb.json`),
    filters: FILTERS
  }
  const window = BrowserWindow.getFocusedWindow()
  const choice = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  if (choice.canceled || !choice.filePath) return null
  // Everything goes with a full export; a folder takes the queries tied to its connections.
  const queries = store.listQueries().filter((q) => !ids || (q.connectionId && ids.includes(q.connectionId)))
  const collection = buildCollection(chosen, store.listLinks(), queries, store.listEnvironments())
  await writeFile(choice.filePath, JSON.stringify(collection, null, 2), 'utf8')
  return { path: choice.filePath, connections: collection.connections.length, links: collection.links.length, queries: collection.queries.length }
}

/** Asks for a collection file and adds its connections; null if cancelled. */
export async function importConnections(): Promise<ImportSummary | null> {
  const options: OpenDialogOptions = { title: 'Import connections', properties: ['openFile'], filters: [...FILTERS, { name: 'All files', extensions: ['*'] }] }
  const window = BrowserWindow.getFocusedWindow()
  const choice = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  const path = choice.filePaths[0]
  if (choice.canceled || !path) return null
  const text = await readFile(path, 'utf8')
  if (text.length > MAX_FILE_BYTES) throw new Error(`That file is too big to be an ${APP_NAME} connections file.`)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  return store.importCollection(parseCollection(raw))
}
