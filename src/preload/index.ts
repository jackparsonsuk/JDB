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
  listTables: (id) => call('db:tables', id),
  describeTable: (id, table) => call('db:describe', id, table),
  fetchRows: (id, request) => call('db:rows', id, request),
  describeSchema: (id) => call('db:schema', id),
  distinctValues: (id, table, column, limit, via) => call('db:distinct', id, table, column, limit, via),
  runQuery: (id, sql) => call('db:query', id, sql),
  countRelated: (id, requests) => call('db:countRelated', id, requests),
  listLinks: () => call('links:list'),
  saveLinks: (links) => call('links:save', links),
  deleteLink: (id) => call('links:delete', id),
  discoverLinks: (a, b) => call('links:discover', a, b),
  verifyLink: (from, to) => call('links:verify', from, to),
  listHistory: () => call('history:list'),
  copy: (text) => call('clipboard:write', text)
}

contextBridge.exposeInMainWorld('api', api)
