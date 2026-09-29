import type {
  CellValue, ColumnFilter, ColumnSummary, ConnectionConfig, DbKind, ExportResult, TableExportRequest, ConnectionInput, CrossLink, HistoryEntry, LinkCandidate, LinkEnd, LinkOverlap, RelatedCount, RelatedCountRequest, QueryResult, RowsRequest, RowsResult, SavedSession,
  SchemaTable, TableDesign, TableDetails, TableInfo, TableRef, ThemeSetting, ValueLookup
} from '../shared/types'
import type { ImportSummary } from '../shared/collection'

export interface Api {
  listConnections(): Promise<ConnectionConfig[]>
  saveConnection(input: ConnectionInput): Promise<ConnectionConfig>
  deleteConnection(id: string): Promise<void>
  testConnection(config: ConnectionConfig, password?: string): Promise<void>
  disconnect(id: string): Promise<void>
  /** Moves connections into a sidebar folder; '' takes them out of any folder. */
  setFolder(ids: string[], folder: string): Promise<void>
  /** Saves connections (all when `ids` is null) and their links to a file to share; no passwords. Null if cancelled. */
  exportConnections(ids: string[] | null, suggestedName: string): Promise<{ path: string; connections: number; links: number } | null>
  /** Asks for a connections file and adds what it holds. Null if cancelled. */
  importConnections(): Promise<ImportSummary | null>
  listTables(connectionId: string): Promise<TableInfo[]>
  describeTable(connectionId: string, table: TableRef): Promise<TableDetails>
  describeDesign(connectionId: string, table: TableRef): Promise<TableDesign>
  /** Runs a table designer script: in one transaction on SQL Server, as one ALTER TABLE on MySQL. */
  applyDesign(connectionId: string, statements: string[]): Promise<number>
  fetchRows(connectionId: string, request: RowsRequest): Promise<RowsResult>
  /** Rows matching the filters, or null if counting took too long (a huge table). */
  countRows(connectionId: string, table: TableRef, filters: ColumnFilter[]): Promise<number | null>
  /** Sum/average/min/max/count of a column over every row matching the filters; null if it took too long. */
  summarizeColumn(connectionId: string, table: TableRef, filters: ColumnFilter[], column: string, dataType: string): Promise<ColumnSummary | null>
  describeSchema(connectionId: string): Promise<SchemaTable[]>
  distinctValues(connectionId: string, table: TableRef, column: string, limit: number, via?: ValueLookup): Promise<CellValue[] | null>
  /**
   * `runId` lets the query be stopped with cancelQuery while it runs. With `transactionId` it runs
   * inside that transaction, and its changes are kept only once the transaction is committed.
   */
  runQuery(connectionId: string, sql: string, runId?: string, transactionId?: string): Promise<QueryResult>
  cancelQuery(runId: string): Promise<void>
  /** Runs grid edits in one transaction, rolling all back unless each matches exactly one row. Returns how many ran. */
  applyChanges(connectionId: string, statements: string[]): Promise<number>
  /** Opens a transaction on a connection of its own and returns its id. Refused on read-only connections. */
  beginTransaction(connectionId: string): Promise<string>
  commitTransaction(transactionId: string): Promise<void>
  /** A no-op if the transaction has already ended. */
  rollbackTransaction(transactionId: string): Promise<void>
  /** False once the transaction has ended, including when the server rolled it back after an error. */
  transactionOpen(transactionId: string): Promise<boolean>
  /** Asks where to save and writes the rows; null if the dialog was cancelled. The file's extension picks the format. */
  exportRows(columns: string[], rows: CellValue[][], kind: DbKind, suggestedName: string): Promise<ExportResult | null>
  /** Like exportRows, but fetches every row matching the table view, up to the export cap. */
  exportTable(connectionId: string, kind: DbKind, request: TableExportRequest): Promise<ExportResult | null>
  /** Opens Explorer with the exported file selected. */
  showExported(path: string): Promise<void>
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
  /** What would be lost if the window closed now (open transactions, unsaved edits), so closing can ask. */
  setUnsavedWork(warnings: string[]): void
  /** Forgets saved Entra sign-ins and disconnects, so the next connection signs in again. */
  signOutEntra(): Promise<void>
  getTheme(): Promise<ThemeSetting>
  setTheme(theme: ThemeSetting): Promise<void>
  copy(text: string): Promise<void>
  /** The version of a downloaded update waiting to install, or null. */
  readyUpdate(): Promise<string | null>
  /** Quits and installs the downloaded update. */
  installUpdate(): Promise<void>
  /** Called when an update finishes downloading; returns an unsubscribe. */
  onUpdateReady(listener: (version: string) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}
