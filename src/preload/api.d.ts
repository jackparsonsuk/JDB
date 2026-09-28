import type {
  CellValue, ColumnFilter, ConnectionConfig, ConnectionInput, CrossLink, HistoryEntry, LinkCandidate, LinkEnd, LinkOverlap, RelatedCount, RelatedCountRequest, QueryResult, RowsRequest, RowsResult, SavedSession,
  SchemaTable, TableDetails, TableInfo, TableRef, ThemeSetting, ValueLookup
} from '../shared/types'

export interface Api {
  listConnections(): Promise<ConnectionConfig[]>
  saveConnection(input: ConnectionInput): Promise<ConnectionConfig>
  deleteConnection(id: string): Promise<void>
  testConnection(config: ConnectionConfig, password?: string): Promise<void>
  disconnect(id: string): Promise<void>
  listTables(connectionId: string): Promise<TableInfo[]>
  describeTable(connectionId: string, table: TableRef): Promise<TableDetails>
  fetchRows(connectionId: string, request: RowsRequest): Promise<RowsResult>
  /** Rows matching the filters, or null if counting took too long (a huge table). */
  countRows(connectionId: string, table: TableRef, filters: ColumnFilter[]): Promise<number | null>
  describeSchema(connectionId: string): Promise<SchemaTable[]>
  distinctValues(connectionId: string, table: TableRef, column: string, limit: number, via?: ValueLookup): Promise<CellValue[] | null>
  /** `runId` lets the query be stopped with cancelQuery while it runs. */
  runQuery(connectionId: string, sql: string, runId?: string): Promise<QueryResult>
  cancelQuery(runId: string): Promise<void>
  countRelated(connectionId: string, requests: RelatedCountRequest[]): Promise<RelatedCount[]>
  listLinks(): Promise<CrossLink[]>
  saveLinks(links: CrossLink[]): Promise<CrossLink[]>
  deleteLink(id: string): Promise<CrossLink[]>
  discoverLinks(connectionA: string, connectionB: string): Promise<LinkCandidate[]>
  verifyLink(from: LinkEnd, to: LinkEnd): Promise<LinkOverlap>
  listHistory(): Promise<HistoryEntry[]>
  /** The last saved session, unchecked; pass it through parseSession. */
  loadSession(): Promise<unknown>
  saveSession(session: SavedSession): void
  /** Forgets saved Entra sign-ins and disconnects, so the next connection signs in again. */
  signOutEntra(): Promise<void>
  getTheme(): Promise<ThemeSetting>
  setTheme(theme: ThemeSetting): Promise<void>
  copy(text: string): Promise<void>
}

declare global {
  interface Window {
    api: Api
  }
}
