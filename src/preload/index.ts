import { contextBridge, ipcRenderer } from 'electron'
import type { Api } from './api'

type Envelope<T> = { ok: true; value: T } | { ok: false; error: string; sqlLine?: number }

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>
  if (!result.ok) throw Object.assign(new Error(result.error), result.sqlLine ? { sqlLine: result.sqlLine } : {})
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
  listDatabases: (id) => call('db:databases', id),
  describeTable: (id, table) => call('db:describe', id, table),
  describeDesign: (id, table) => call('db:design', id, table),
  listRoutines: (id) => call('db:routines', id),
  describeRoutine: (id, routine) => call('db:routine', id, routine),
  routineSources: (id) => call('db:routineSources', id),
  applyDesign: (id, statements) => call('db:applyDesign', id, statements),
  fetchRows: (id, request) => call('db:rows', id, request),
  countRows: (id, table, filters) => call('db:count', id, table, filters),
  summarizeColumn: (id, table, filters, column, dataType) => call('db:summarize', id, table, filters, column, dataType),
  describeSchema: (id) => call('db:schema', id),
  distinctValues: (id, table, column, limit, via) => call('db:distinct', id, table, column, limit, via),
  runQuery: (id, sql, runId, transactionId) => call('db:query', id, sql, runId, transactionId),
  cancelQuery: (runId) => call('db:cancel', runId),
  countForWrite: (id, sql) => call('db:countForWrite', id, sql),
  snapshotRows: (id, sql, transactionId) => call('db:snapshotRows', id, sql, transactionId),
  applyChanges: (id, statements) => call('db:applyChanges', id, statements),
  beginTransaction: (id) => call('tx:begin', id),
  commitTransaction: (transactionId) => call('tx:commit', transactionId),
  rollbackTransaction: (transactionId) => call('tx:rollback', transactionId),
  transactionOpen: (transactionId) => call('tx:open', transactionId),
  exportRows: (columns, rows, kind, name) => call('export:rows', columns, rows, kind, name),
  exportTable: (id, kind, request) => call('export:table', id, kind, request),
  showExported: (path) => call('export:show', path),
  countRelated: (id, requests) => call('db:countRelated', id, requests),
  planValueSearch: (id, value) => call('db:planValueSearch', id, value),
  listLinks: () => call('links:list'),
  listLookups: () => call('lookups:list'),
  saveLookup: (link) => call('lookups:save', link),
  deleteLookup: (id) => call('lookups:delete', id),
  saveLinks: (links) => call('links:save', links),
  deleteLink: (id) => call('links:delete', id),
  discoverLinks: (a, b) => call('links:discover', a, b),
  verifyLink: (from, to) => call('links:verify', from, to),
  listHistory: () => call('history:list'),
  listEnvironments: () => call('envs:list'),
  saveEnvironments: (environments) => call('envs:save', environments),
  deleteEnvironment: (id, moveTo) => call('envs:delete', id, moveTo),
  listQueries: () => call('queries:list'),
  saveQuery: (input) => call('queries:save', input),
  deleteQuery: (id) => call('queries:delete', id),
  loadSession: () => call('session:load'),
  saveSession: (session) => ipcRenderer.send('session:save', session),
  openWindow: (session, carried) => call('window:open', session, carried),
  takeCarried: () => call('window:carried'),
  onStoreChanged: (listener) => {
    const handler = (_event: unknown, topics: string[]): void => listener(topics)
    ipcRenderer.on('store:changed', handler)
    return () => ipcRenderer.removeListener('store:changed', handler)
  },
  setUnsavedWork: (warnings) => ipcRenderer.send('app:unsaved', warnings),
  signOutEntra: () => call('entra:signOut'),
  getTheme: () => call('theme:get'),
  setTheme: (theme) => call('theme:set', theme),
  getAppearance: () => call('appearance:get'),
  setAppearance: (appearance) => call('appearance:set', appearance),
  setZoom: (factor) => ipcRenderer.invoke('app:zoom', factor),
  copy: (text) => call('clipboard:write', text),
  pasteText: () => call('clipboard:read'),
  readyUpdate: () => call('update:ready'),
  installUpdate: () => call('update:install'),
  checkForUpdates: () => call('update:check'),
  onUpdateReady: (listener) => {
    const handler = (_event: unknown, version: string): void => listener(version)
    ipcRenderer.on('update:ready', handler)
    return () => ipcRenderer.off('update:ready', handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
