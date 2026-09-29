import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from './api'

type Envelope<T> = { ok: true; value: T } | { ok: false; error: string }

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>
  if (!result.ok) throw new Error(result.error)
  return result.value
}

const api: Api = {
  listConnections: () => call('connections:list'),
  saveConnection: (input) => call('connections:save', input),
  deleteConnection: (id) => call('connections:delete', id),
  testConnection: (config, password) => call('connections:test', config, password),
  disconnect: (id) => call('connections:disconnect', id),
  setFolder: (ids, folder) => call('connections:setFolder', ids, folder),
  exportConnections: (ids, name) => call('connections:export', ids, name),
  importConnections: () => call('connections:import'),
  listTables: (id) => call('db:tables', id),
  describeTable: (id, table) => call('db:describe', id, table),
  describeDesign: (id, table) => call('db:design', id, table),
  applyDesign: (id, statements) => call('db:applyDesign', id, statements),
  fetchRows: (id, request) => call('db:rows', id, request),
  countRows: (id, table, filters) => call('db:count', id, table, filters),
  summarizeColumn: (id, table, filters, column, dataType) => call('db:summarize', id, table, filters, column, dataType),
  describeSchema: (id) => call('db:schema', id),
  distinctValues: (id, table, column, limit, via) => call('db:distinct', id, table, column, limit, via),
  runQuery: (id, sql, runId, transactionId) => call('db:query', id, sql, runId, transactionId),
  cancelQuery: (runId) => call('db:cancel', runId),
  applyChanges: (id, statements) => call('db:applyChanges', id, statements),
  beginTransaction: (id) => call('tx:begin', id),
  commitTransaction: (transactionId) => call('tx:commit', transactionId),
  rollbackTransaction: (transactionId) => call('tx:rollback', transactionId),
  transactionOpen: (transactionId) => call('tx:open', transactionId),
  exportRows: (columns, rows, kind, name) => call('export:rows', columns, rows, kind, name),
  exportTable: (id, kind, request) => call('export:table', id, kind, request),
  showExported: (path) => call('export:show', path),
  countRelated: (id, requests) => call('db:countRelated', id, requests),
  listLinks: () => call('links:list'),
  saveLinks: (links) => call('links:save', links),
  deleteLink: (id) => call('links:delete', id),
  discoverLinks: (a, b) => call('links:discover', a, b),
  verifyLink: (from, to) => call('links:verify', from, to),
  listHistory: () => call('history:list'),
  loadSession: () => call('session:load'),
  saveSession: (session) => ipcRenderer.send('session:save', session),
  setUnsavedWork: (warnings) => ipcRenderer.send('app:unsaved', warnings),
  signOutEntra: () => call('entra:signOut'),
  getTheme: () => call('theme:get'),
  setTheme: (theme) => call('theme:set', theme),
  copy: (text) => call('clipboard:write', text),
  readyUpdate: () => call('update:ready'),
  installUpdate: () => call('update:install'),
  onUpdateReady: (listener) => {
    const handler = (_event: unknown, version: string): void => listener(version)
    ipcRenderer.on('update:ready', handler)
    return () => ipcRenderer.off('update:ready', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
