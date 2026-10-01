export type DbKind = 'mssql' | 'mysql'
export type AuthType = 'sql' | 'entra-browser' | 'entra-default'
/** An environment id: one of the built-ins (local, dev, test, prod) or one the user added; see @shared/environments. */
export type EnvTag = string

export interface ConnectionConfig {
  id: string
  name: string
  kind: DbKind
  host: string
  port: number
  database: string
  user: string
  authType: AuthType
  /** Entra tenant, only used for entra-browser auth. */
  tenantId?: string
  env: EnvTag
  readOnly: boolean
  trustServerCertificate?: boolean
  /** Sidebar folder the connection is grouped under; none shows it at the top level. */
  folder?: string
  /** True when a password is stored; the password itself never leaves the main process. */
  hasPassword?: boolean
}

/** What the renderer sends when saving: password is optional, undefined keeps the stored one. */
export interface ConnectionInput extends ConnectionConfig {
  password?: string
}

export interface TableRef {
  schema: string
  name: string
}

/** The database a connection is using and the others on the same server that it can open. */
export interface DatabaseList {
  /** null on MySQL when no database is set, so every schema is listed. */
  current: string | null
  /** User databases on the server, without system ones (master, mysql, ...). */
  databases: string[]
}

export interface TableInfo extends TableRef {
  type: 'table' | 'view'
  rowEstimate?: number
}

export type RoutineKind = 'procedure' | 'function' | 'trigger'

/** A stored procedure, function or trigger. Names are unique per schema, so schema + name + kind finds it. */
export interface RoutineRef extends TableRef {
  kind: RoutineKind
}

export interface RoutineInfo extends RoutineRef {
  /** Functions: 'scalar' or 'table'; triggers: timing and events, e.g. 'AFTER INSERT, UPDATE'. */
  detail?: string
  /** The table a trigger fires on. */
  parent?: TableRef
  /** When the definition last changed, as the server reports it (ISO or 'YYYY-MM-DD hh:mm:ss'). */
  modified?: string
  /** A trigger that is switched off (SQL Server). */
  disabled?: boolean
}

export interface RoutineParam {
  name: string
  dataType: string
  mode: 'IN' | 'OUT' | 'INOUT'
  /** SQL Server only reports whether a default exists for CLR procs, so this is best effort. */
  hasDefault?: boolean
}

export interface RoutineDefinition {
  routine: RoutineInfo
  /** The full CREATE text, or null when this login can't read it (no VIEW DEFINITION / SHOW_ROUTINE). */
  definition: string | null
  /** True when only the body could be read (MySQL without SHOW CREATE rights), not the full CREATE. */
  bodyOnly?: boolean
  parameters: RoutineParam[]
  /** A function's return type, or 'TABLE' for table-valued functions. */
  returns?: string
  created?: string
}

/** A routine's source for searching; definition is null where it's hidden. */
export interface RoutineSource extends RoutineRef {
  definition: string | null
}

export interface ForeignKeyRef extends TableRef {
  column: string
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  isPrimaryKey: boolean
  isIdentity: boolean
  references?: ForeignKeyRef
}

/** Reads a lookup's display column through a foreign key instead of the raw key values. */
export interface ValueLookup {
  table: TableRef
  /** Key column in the lookup table that the foreign key points at. */
  column: string
  /** Human-readable column in the lookup table, e.g. Name or Label. */
  display: string
}

/** A table with all its columns, used to build the natural-language query engine's model. */
export interface SchemaTable extends TableInfo {
  columns: ColumnInfo[]
}

export interface ReverseReference {
  /** The child table/column that points at this table. */
  table: TableRef
  column: string
  /** The column in this table being referenced. */
  referencedColumn: string
}

export interface TableDetails {
  columns: ColumnInfo[]
  referencedBy: ReverseReference[]
}

/** A column summarised on the server across every row matching the table view's filters. */
export interface ColumnSummary {
  /** Non-null values. */
  count: number
  /** Only for columns whose values can be compared (not text/ntext/image/xml on SQL Server). */
  distinct?: number
  /** Only for numeric columns. */
  numeric?: { sum: number; average: number; min: number; max: number }
}

/** A column as the table designer shows it: ColumnInfo plus what's needed to alter it safely. */
export interface DesignColumn extends ColumnInfo {
  /** SQL expression after DEFAULT, e.g. `((0))` or `CURRENT_TIMESTAMP`; null for none. */
  default: string | null
  /** SQL Server's default constraint, which must be dropped before the default or column can change. */
  defaultConstraint?: string
  /**
   * There is a default, but this login can't read its definition (Azure SQL without VIEW DEFINITION),
   * so it couldn't be put back after a change that drops it.
   */
  defaultHidden?: boolean
  /** Expression of a computed / generated column; these can't be altered in the designer. */
  computed?: string
  /** Kept when altering, so a change of type doesn't silently switch to the database default collation. */
  collation?: string
  /** MySQL column extras to keep on CHANGE COLUMN, e.g. `auto_increment`, `on update CURRENT_TIMESTAMP`. */
  extra?: string
  comment?: string
}

export interface DesignIndex {
  name: string
  columns: string[]
  /** SQL Server INCLUDE columns. */
  included: string[]
  unique: boolean
  primary: boolean
  type: string
}

export interface DesignForeignKey {
  name: string
  columns: string[]
  references: TableRef
  referencedColumns: string[]
  onDelete: string
  onUpdate: string
}

export interface TableDesign {
  columns: DesignColumn[]
  indexes: DesignIndex[]
  foreignKeys: DesignForeignKey[]
  referencedBy: ReverseReference[]
}

export type FilterOp = '=' | '!=' | 'contains' | 'starts' | '>' | '<' | 'is null' | 'not null'

export interface ColumnFilter {
  column: string
  op: FilterOp
  value?: string
}

export interface RowsRequest {
  table: TableRef
  limit: number
  offset: number
  orderBy?: string
  orderDir?: 'asc' | 'desc'
  filters: ColumnFilter[]
}

export type CellValue = string | number | boolean | null

export interface ResultSet {
  columns: string[]
  rows: CellValue[][]
}

export interface RowsResult extends ResultSet {
  /** Whether rows exist past this page. The total is counted separately (countRows), as it can be slow. */
  hasMore: boolean
}

export interface QueryResult {
  resultSets: ResultSet[]
  rowsAffected: number[]
  durationMs: number
  /** Settings' row limit, when a result set had more rows than it and was cut to it. */
  capped?: number
}

/** One side of a cross-database link: a column in a table on a saved connection. */
export interface LinkEnd {
  connectionId: string
  table: TableRef
  column: string
}

/** How many sampled values of the `from` column were found as keys on the `to` side. */
export interface LinkOverlap {
  matched: number
  sampled: number
  checkedAt: string
}

/**
 * A link between databases that can't join natively, e.g. Shop Orders.JobId -> Jobs Job.Id.
 * `from` holds the reference; `to` is the key it points at.
 */
export interface CrossLink {
  id: string
  from: LinkEnd
  to: LinkEnd
  /** Dismissed candidates are remembered so discovery doesn't keep suggesting them. */
  status: 'confirmed' | 'dismissed'
  source: 'auto' | 'manual'
  overlap?: LinkOverlap
}

export interface LinkCandidate {
  from: LinkEnd
  to: LinkEnd
  overlap: LinkOverlap
}

/** How key values are compared across servers, so literals are written safely for each driver. */
export type KeyKind = 'number' | 'guid' | 'text'

export interface RelatedCountRequest {
  table: TableRef
  column: string
  value: string
  /** Count even when the table is large and the column has no index. */
  force?: boolean
}

export type RelatedCount =
  | { status: 'ok'; count: number; capped: boolean }
  | { status: 'skipped'; reason: string }
  | { status: 'timeout' }
  | { status: 'error'; message: string }

/** A table view to save to a file: every row matching its filters, in its sort order, up to the export cap. */
export type TableExportRequest = Omit<RowsRequest, 'limit' | 'offset'>

/** Where an export went; null from the API when the save dialog was cancelled. */
export interface ExportResult {
  path: string
  rows: number
  /** More rows matched than the export cap, so only the first `rows` were saved. */
  truncated: boolean
}

/** A query kept by name, to open again or insert as a snippet. */
export interface SavedQuery {
  id: string
  name: string
  /** Groups it in the sidebar; none shows it at the top level. */
  folder?: string
  sql: string
  description?: string
  /** The connection it runs on; none means it suits any connection (a snippet). */
  connectionId?: string
  createdAt: string
  updatedAt: string
}

/** What the renderer sends to save a query: no id adds a new one. */
export type SavedQueryInput = Omit<SavedQuery, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }

/** How many rows a write would touch, counted before it runs. */
export type WriteCount =
  | { status: 'counted'; rows: number }
  /** Counting took longer than the limit and was stopped. */
  | { status: 'timeout'; seconds: number }
  | { status: 'failed'; error: string }

export interface HistoryEntry {
  id: string
  connectionId: string
  sql: string
  ranAt: string
  durationMs: number
  error?: string
}

export interface TableSort {
  column: string
  dir: 'asc' | 'desc'
}

/** A tab as saved between runs: what it shows, not its results. */
export type SavedTab = (
  | { kind: 'table'; pane: 0 | 1; connectionId: string; table: TableRef; filters: ColumnFilter[]; sort?: TableSort }
  /** `schema`: the database (MySQL) or schema (SQL Server) the query tab was started in, from its sidebar folder. */
  | { kind: 'query'; pane: 0 | 1; connectionId: string; title: string; sql: string; savedId?: string; schema?: string }
  | { kind: 'record'; pane: 0 | 1; connectionId: string; table: TableRef; key: ColumnFilter[] }
  | { kind: 'design'; pane: 0 | 1; connectionId: string; table: TableRef }
  | { kind: 'routine'; pane: 0 | 1; connectionId: string; routine: RoutineRef }
  /** Find value: the value last searched for, searched again only when asked. */
  | { kind: 'search'; pane: 0 | 1; connectionId: string; value: string }
) & { pinned?: boolean }

/** The open tabs and split, saved so the app reopens where it was left. */
export interface SavedSession {
  tabs: SavedTab[]
  /** Index into `tabs` of each pane's active tab. */
  active: [number | null, number | null]
  focused: 0 | 1
  /** Share of the width the left pane takes when split. */
  ratio: number
}

/** 'system' follows the Windows light/dark setting. */
export type ThemeSetting = 'system' | 'light' | 'dark' | 'dim' | 'midnight' | 'contrast' | 'gruvbox'

/** What Windows is told for the title bar and prefers-color-scheme: the dark variants are all dark. */
export const nativeThemeOf = (theme: ThemeSetting): 'system' | 'light' | 'dark' =>
  theme === 'system' || theme === 'light' ? theme : 'dark'

/** The outcome of "Check for updates". */
export type UpdateCheck =
  | { state: 'dev' }
  | { state: 'current'; version: string }
  | { state: 'downloading'; version: string }
  | { state: 'ready'; version: string }
  | { state: 'error'; error: string }
