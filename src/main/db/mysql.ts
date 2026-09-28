import mysql from 'mysql2/promise'
import type {
  CellValue, ColumnFilter, ColumnInfo, ConnectionConfig, QueryResult, ResultSet, RowsRequest, RowsResult,
  KeyKind, SchemaTable, TableDetails, TableInfo, TableRef, ValueLookup
} from '@shared/types'
import { assembleSchema, chunk, distinctSource, indexKey, KEY_BATCH, QueryCancelledError, SAMPLE_SCAN_ROWS, TimeoutError, toCell, type Driver, type SchemaColumnRow } from './driver'
import { buildWhere } from './filters'

const quote = (identifier: string): string => `\`${identifier.replace(/`/g, '``')}\``
const qualified = (table: TableRef): string => `${quote(table.schema)}.${quote(table.name)}`

const SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys']

export class MysqlDriver implements Driver {
  private readonly pool: mysql.Pool
  private primaryKeys = new Map<string, string[]>()

  private readonly login: mysql.ConnectionOptions

  constructor(private readonly config: ConnectionConfig, password: string | undefined) {
    this.login = {
      host: config.host,
      port: config.port || 3306,
      user: config.user,
      password,
      connectTimeout: 20_000
    }
    this.pool = mysql.createPool({
      ...this.login,
      database: config.database || undefined,
      connectionLimit: 4,
      dateStrings: true,
      // Numbers stay numbers unless they exceed JS precision, then they arrive as strings.
      supportBigNumbers: true,
      decimalNumbers: false,
      multipleStatements: true
    })
    if (config.readOnly) {
      // Server-enforced: every statement on these sessions runs in a read-only transaction.
      this.pool.on('connection', (connection) => {
        connection.query('SET SESSION TRANSACTION READ ONLY')
      })
    }
  }

  /** Limits schema lookups to the configured database, or every user schema when none is set. */
  private schemaFilter(column: string): { sql: string; values: string[] } {
    if (this.config.database) return { sql: `${column} = ?`, values: [this.config.database] }
    return { sql: `${column} NOT IN (${SYSTEM_SCHEMAS.map(() => '?').join(', ')})`, values: SYSTEM_SCHEMAS }
  }

  async listTables(): Promise<TableInfo[]> {
    const filter = this.schemaFilter('table_schema')
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT table_schema AS s, table_name AS n, table_type AS t, table_rows AS r
       FROM information_schema.tables WHERE ${filter.sql} ORDER BY table_schema, table_name`,
      filter.values
    )
    return rows.map((row) => ({
      schema: row.s,
      name: row.n,
      type: row.t === 'VIEW' ? 'view' : 'table',
      rowEstimate: row.r == null ? undefined : Number(row.r)
    }))
  }

  async describeTable(table: TableRef): Promise<TableDetails> {
    const [columnRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT c.column_name AS name, c.column_type AS type, c.is_nullable AS nullable,
              c.column_key AS col_key, c.extra,
              k.referenced_table_schema AS ref_schema, k.referenced_table_name AS ref_table,
              k.referenced_column_name AS ref_column
       FROM information_schema.columns c
       LEFT JOIN information_schema.key_column_usage k
         ON k.table_schema = c.table_schema AND k.table_name = c.table_name
        AND k.column_name = c.column_name AND k.referenced_table_name IS NOT NULL
       WHERE c.table_schema = ? AND c.table_name = ?
       ORDER BY c.ordinal_position`,
      [table.schema, table.name]
    )
    const [reverseRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT table_schema AS s, table_name AS t, column_name AS c, referenced_column_name AS rc
       FROM information_schema.key_column_usage
       WHERE referenced_table_schema = ? AND referenced_table_name = ?
       ORDER BY table_schema, table_name`,
      [table.schema, table.name]
    )

    // A column in several FKs appears once per FK; keep the first.
    const seen = new Set<string>()
    const columns: ColumnInfo[] = []
    for (const c of columnRows) {
      if (seen.has(c.name)) continue
      seen.add(c.name)
      columns.push({
        name: c.name,
        dataType: c.type,
        nullable: c.nullable === 'YES',
        isPrimaryKey: c.col_key === 'PRI',
        isIdentity: String(c.extra).includes('auto_increment'),
        references: c.ref_table ? { schema: c.ref_schema, name: c.ref_table, column: c.ref_column } : undefined
      })
    }
    this.primaryKeys.set(qualified(table), columns.filter((c) => c.isPrimaryKey).map((c) => c.name))

    return {
      columns,
      referencedBy: reverseRows.map((r) => ({
        table: { schema: r.s, name: r.t },
        column: r.c,
        referencedColumn: r.rc
      }))
    }
  }

  async describeSchema(): Promise<SchemaTable[]> {
    const filter = this.schemaFilter('c.table_schema')
    const [tables, [rows]] = await Promise.all([
      this.listTables(),
      this.pool.query<mysql.RowDataPacket[]>(
        `SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS name, c.column_type AS type,
                c.is_nullable AS nullable, c.column_key AS col_key, c.extra,
                k.referenced_table_schema AS ref_schema, k.referenced_table_name AS ref_table,
                k.referenced_column_name AS ref_column
         FROM information_schema.columns c
         LEFT JOIN information_schema.key_column_usage k
           ON k.table_schema = c.table_schema AND k.table_name = c.table_name
          AND k.column_name = c.column_name AND k.referenced_table_name IS NOT NULL
         WHERE ${filter.sql}
         ORDER BY c.table_schema, c.table_name, c.ordinal_position`,
        filter.values
      )
    ])
    return assembleSchema(tables, rows.map((r): SchemaColumnRow => ({
      schema: r.s,
      table: r.t,
      column: r.name,
      dataType: r.type,
      nullable: r.nullable === 'YES',
      isPrimaryKey: r.col_key === 'PRI',
      isIdentity: String(r.extra).includes('auto_increment'),
      refSchema: r.ref_schema,
      refTable: r.ref_table,
      refColumn: r.ref_column
    })))
  }

  async distinctValues(table: TableRef, column: string, limit: number, via?: ValueLookup): Promise<CellValue[] | null> {
    const source = distinctSource(quote, qualified, table, column, via)
    const [rows] = await this.pool.query<mysql.RowDataPacket[][]>({
      sql: `SELECT DISTINCT ${source.expr} FROM ${source.from} LIMIT ${Math.floor(limit) + 1}`,
      rowsAsArray: true
    })
    const values = rows.map((row) => toCell(row[0]))
    return values.length > limit ? null : values
  }

  async sampleDistinct(table: TableRef, column: string, limit: number): Promise<CellValue[]> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[][]>({
      sql: `SELECT DISTINCT v FROM (SELECT ${quote(column)} AS v FROM ${qualified(table)} WHERE ${quote(column)} IS NOT NULL LIMIT ${SAMPLE_SCAN_ROWS}) s LIMIT ${Math.floor(limit)}`,
      rowsAsArray: true
    })
    return rows.map((row) => toCell(row[0]))
  }

  async countMatchingKeys(table: TableRef, column: string, values: string[]): Promise<number> {
    let matched = 0
    for (const batch of chunk(values, KEY_BATCH)) {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT COUNT(*) AS n FROM ${qualified(table)} WHERE ${quote(column)} IN (${batch.map(() => '?').join(', ')})`,
        batch
      )
      matched += Number(rows[0].n)
    }
    return matched
  }

  async indexedColumns(tables: TableRef[]): Promise<Set<string>> {
    const out = new Set<string>()
    for (const batch of chunk(tables, 200)) {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT table_schema AS s, table_name AS t, column_name AS c FROM information_schema.statistics
         WHERE seq_in_index = 1 AND (${batch.map(() => '(table_schema = ? AND table_name = ?)').join(' OR ')})`,
        batch.flatMap((t) => [t.schema, t.name])
      )
      for (const r of rows) out.add(indexKey(r.s, r.t, r.c))
    }
    return out
  }

  async countWhere(table: TableRef, column: string, _dataType: string, value: string, cap: number, timeoutMs: number): Promise<number> {
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT /*+ MAX_EXECUTION_TIME(${Math.floor(timeoutMs)}) */ COUNT(*) AS n FROM (SELECT 1 FROM ${qualified(table)} WHERE ${quote(column)} = ? LIMIT ${Math.floor(cap) + 1}) s`,
        [value]
      )
      return Number(rows[0].n)
    } catch (error) {
      // ER_QUERY_TIMEOUT (3024): the optimizer hint stopped the statement.
      if ((error as { errno?: number }).errno === 3024) throw new TimeoutError()
      throw error
    }
  }

  async fetchRows(req: RowsRequest): Promise<RowsResult> {
    const key = qualified(req.table)
    if (!this.primaryKeys.has(key)) await this.describeTable(req.table)
    const pk = this.primaryKeys.get(key) ?? []

    const where = buildWhere(req.filters, quote, () => '?')
    const orderBy = req.orderBy
      ? `ORDER BY ${quote(req.orderBy)} ${req.orderDir === 'desc' ? 'DESC' : 'ASC'}`
      : pk.length ? `ORDER BY ${pk.map(quote).join(', ')}` : ''
    const offset = Math.max(0, Math.floor(req.offset))
    const limit = Math.max(1, Math.floor(req.limit))

    // One extra row says whether there's a next page without counting the table.
    const [rows, fields] = await this.pool.query<mysql.RowDataPacket[][]>({
      sql: `SELECT * FROM ${key} ${where.sql} ${orderBy} LIMIT ${limit + 1} OFFSET ${offset}`,
      values: where.values,
      rowsAsArray: true
    })

    return {
      columns: fields.map((f) => f.name),
      rows: rows.slice(0, limit).map((row) => row.map(toCell)),
      hasMore: rows.length > limit
    }
  }

  async countRows(table: TableRef, filters: ColumnFilter[], timeoutMs: number): Promise<number> {
    const where = buildWhere(filters, quote, () => '?')
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT /*+ MAX_EXECUTION_TIME(${Math.floor(timeoutMs)}) */ COUNT(*) AS total FROM ${qualified(table)} ${where.sql}`,
        where.values
      )
      return Number(rows[0].total)
    } catch (error) {
      if ((error as { errno?: number }).errno === 3024) throw new TimeoutError()
      throw error
    }
  }

  async query(text: string, signal?: AbortSignal): Promise<QueryResult> {
    const started = Date.now()
    // Hold one connection so we know which server thread to kill if the run is cancelled.
    const connection = await this.pool.getConnection()
    let kill: Promise<void> | null = null
    const onAbort = (): void => {
      kill = this.killQuery(connection.threadId)
    }
    let results: unknown
    let fields: unknown
    try {
      if (signal?.aborted) throw new QueryCancelledError()
      signal?.addEventListener('abort', onAbort, { once: true })
      ;[results, fields] = await connection.query({ sql: text, rowsAsArray: true })
    } catch (error) {
      if (kill) throw new QueryCancelledError()
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
      // Wait for the KILL to land before the connection goes back to the pool, so it can't hit the next query.
      if (kill) await kill
      connection.release()
    }

    // With multipleStatements, several statements return parallel arrays of results and fields.
    // A single SELECT returns a flat FieldPacket[]; non-SELECT statements have undefined fields.
    const multi = Array.isArray(fields) && (fields as unknown[]).some((f) => f === undefined || Array.isArray(f))
    const resultList = (multi ? results : [results]) as unknown[]
    const fieldList = (multi ? fields : [fields]) as (mysql.FieldPacket[] | undefined)[]

    const resultSets: ResultSet[] = []
    const rowsAffected: number[] = []
    resultList.forEach((result, i) => {
      if (Array.isArray(result)) {
        resultSets.push({
          columns: (fieldList[i] ?? []).map((f) => f.name),
          rows: (result as unknown[][]).map((row) => row.map(toCell))
        })
        rowsAffected.push(result.length)
      } else if (result && typeof result === 'object' && 'affectedRows' in result) {
        rowsAffected.push((result as mysql.ResultSetHeader).affectedRows)
      }
    })
    return { resultSets, rowsAffected, durationMs: Date.now() - started }
  }

  /** KILL QUERY on a separate connection, since every pooled one may be busy with long queries. */
  private async killQuery(threadId: number): Promise<void> {
    const connection = await mysql.createConnection(this.login).catch(() => null)
    if (!connection) return
    try {
      await connection.query(`KILL QUERY ${Math.floor(threadId)}`)
    } catch {
      // The query may have already finished; nothing to stop.
    } finally {
      await connection.end().catch(() => undefined)
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
