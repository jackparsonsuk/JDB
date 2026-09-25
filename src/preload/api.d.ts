import type {
  CellValue, ConnectionConfig, ConnectionInput, CrossLink, HistoryEntry, LinkCandidate, LinkEnd, LinkOverlap, QueryResult, RowsRequest, RowsResult,
  SchemaTable, TableDetails, TableInfo, TableRef, ValueLookup
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
  describeSchema(connectionId: string): Promise<SchemaTable[]>
  distinctValues(connectionId: string, table: TableRef, column: string, limit: number, via?: ValueLookup): Promise<CellValue[] | null>
  runQuery(connectionId: string, sql: string): Promise<QueryResult>
  listLinks(): Promise<CrossLink[]>
  saveLinks(links: CrossLink[]): Promise<CrossLink[]>
  deleteLink(id: string): Promise<CrossLink[]>
  discoverLinks(connectionA: string, connectionB: string): Promise<LinkCandidate[]>
  verifyLink(from: LinkEnd, to: LinkEnd): Promise<LinkOverlap>
  listHistory(): Promise<HistoryEntry[]>
  copy(text: string): Promise<void>
}

declare global {
  interface Window {
    api: Api
  }
}
