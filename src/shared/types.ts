export type DbKind = 'mssql' | 'mysql'
export type AuthType = 'sql' | 'entra-browser' | 'entra-default'
export type EnvTag = 'local' | 'dev' | 'test' | 'prod'

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

export interface TableInfo extends TableRef {
  type: 'table' | 'view'
  rowEstimate?: number
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
  total: number
}

export interface QueryResult {
  resultSets: ResultSet[]
  rowsAffected: number[]
  durationMs: number
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
 * A link between databases that can't join natively, e.g. Shop Orders.JobId -> TestDB Job.Id.
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

export interface HistoryEntry {
  id: string
  connectionId: string
  sql: string
  ranAt: string
  durationMs: number
  error?: string
}
