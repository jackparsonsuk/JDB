import mysql from 'mysql2/promise'
import type {
  CellValue, ColumnFilter, ColumnInfo, ConnectionConfig, QueryResult, ResultSet, RowsRequest, RowsResult,
  ColumnSummary, DesignColumn, DesignForeignKey, DesignIndex, KeyKind, SchemaTable, TableDesign, TableDetails, TableInfo, TableRef, ValueLookup
} from '@shared/types'
import { assembleSchema, chunk, distinctSource, indexKey, KEY_BATCH, QueryCancelledError, SAMPLE_SCAN_ROWS, summaryFrom, TimeoutError, toCell, type Driver, type DriverTransaction, type SchemaColumnRow } from './driver'
import { buildWhere } from './filters'
import { isNumericType } from '@shared/edits'

const quote = (identifier: string): string => `\`${identifier.replace(/`/g, '``')}\``
const qualified = (table: TableRef): string => `${quote(table.schema)}.${quote(table.name)}`

const SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys']

/**
 * information_schema gives MySQL 8 literal defaults unquoted and expression defaults flagged
 * DEFAULT_GENERATED; MariaDB quotes literals itself. Returns what would follow DEFAULT.
 */
function mysqlDefault(value: unknown, baseType: string, generated: boolean): string | null {
  if (value === null || value === undefined) return null
  const text = String(value)
  if (generated) return /^(current_timestamp|now|localtime)/i.test(text) ? text : `(${text})`
  if (text.startsWith("'") || text === 'NULL') return text === 'NULL' ? null : text
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)$/i.test(baseType) && /^-?[\d.eE+-]+$|^b'[01]+'$/.test(text)) return text
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

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
              c.column_key AS col_key, c.extra AS extra,
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

  async describeDesign(table: TableRef): Promise<TableDesign> {
    const [columnRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT column_name AS name, column_type AS type, data_type AS base, is_nullable AS nullable, column_default AS def,
              extra AS extra, generation_expression AS gen, column_key AS col_key, collation_name AS coll, column_comment AS comment
       FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
      [table.schema, table.name]
    )
    const [indexRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT index_name AS name, non_unique, column_name AS col, index_type AS type
       FROM information_schema.statistics WHERE table_schema = ? AND table_name = ?
       ORDER BY index_name = 'PRIMARY' DESC, index_name, seq_in_index`,
      [table.schema, table.name]
    )
    const [fkRows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT k.constraint_name AS name, k.column_name AS col, k.referenced_table_schema AS rs, k.referenced_table_name AS rt,
              k.referenced_column_name AS rc, r.delete_rule AS on_delete, r.update_rule AS on_update
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name AND r.table_name = k.table_name
       WHERE k.table_schema = ? AND k.table_name = ? AND k.referenced_table_name IS NOT NULL
       ORDER BY k.constraint_name, k.ordinal_position`,
      [table.schema, table.name]
    )

    const fkColumns = new Map<string, { schema: string; name: string; column: string }>()
    for (const fk of fkRows) if (!fkColumns.has(fk.col)) fkColumns.set(fk.col, { schema: fk.rs, name: fk.rt, column: fk.rc })
    const columns: DesignColumn[] = columnRows.map((c) => {
      const extra = String(c.extra ?? '')
      const generated = /\b(VIRTUAL|STORED) GENERATED\b/i.test(extra)
      // What CHANGE COLUMN must restate: auto_increment and ON UPDATE, not the DEFAULT_GENERATED marker.
      const kept = extra.replace(/\bDEFAULT_GENERATED\b/i, '').replace(/\b(VIRTUAL|STORED) GENERATED\b/i, '').trim()
      return {
        name: c.name,
        dataType: c.type,
        nullable: c.nullable === 'YES',
        isPrimaryKey: c.col_key === 'PRI',
        isIdentity: /auto_increment/i.test(extra),
        references: fkColumns.get(c.name),
        default: mysqlDefault(c.def, String(c.base), /DEFAULT_GENERATED/i.test(extra)),
        ...(generated && c.gen && { computed: c.gen }),
        ...(c.coll && { collation: c.coll }),
        ...(kept && { extra: kept }),
        ...(c.comment && { comment: c.comment })
      }
    })

    const indexes = new Map<string, DesignIndex>()
    for (const r of indexRows) {
      let index = indexes.get(r.name)
      if (!index) {
        index = { name: r.name, columns: [], included: [], unique: Number(r.non_unique) === 0, primary: r.name === 'PRIMARY', type: String(r.type).toLowerCase() }
        indexes.set(r.name, index)
      }
      index.columns.push(r.col)
    }
    const foreignKeys = new Map<string, DesignForeignKey>()
    for (const r of fkRows) {
      let fk = foreignKeys.get(r.name)
      if (!fk) {
        fk = { name: r.name, columns: [], references: { schema: r.rs, name: r.rt }, referencedColumns: [], onDelete: String(r.on_delete), onUpdate: String(r.on_update) }
        foreignKeys.set(r.name, fk)
      }
      fk.columns.push(r.col)
      fk.referencedColumns.push(r.rc)
    }
    const { referencedBy } = await this.describeTable(table)
    return { columns, indexes: [...indexes.values()], foreignKeys: [...foreignKeys.values()], referencedBy }
  }

  forgetCaches(): void {
    this.primaryKeys.clear()
  }

  async describeSchema(): Promise<SchemaTable[]> {
    const filter = this.schemaFilter('c.table_schema')
    const [tables, [rows]] = await Promise.all([
      this.listTables(),
      this.pool.query<mysql.RowDataPacket[]>(
        `SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS name, c.column_type AS type,
                c.is_nullable AS nullable, c.column_key AS col_key, c.extra AS extra,
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

  async summarize(table: TableRef, filters: ColumnFilter[], column: string, dataType: string, timeoutMs: number): Promise<ColumnSummary> {
    const numeric = isNumericType(dataType)
    const c = quote(column)
    const parts = [`COUNT(${c}) AS n`, `COUNT(DISTINCT ${c}) AS d`]
    if (numeric) parts.push(`SUM(${c}) AS s`, `AVG(${c}) AS a`, `MIN(${c}) AS lo`, `MAX(${c}) AS hi`)
    const where = buildWhere(filters, quote, () => '?')
    try {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `SELECT /*+ MAX_EXECUTION_TIME(${Math.floor(timeoutMs)}) */ ${parts.join(', ')} FROM ${qualified(table)} ${where.sql}`,
        where.values
      )
      return summaryFrom(rows[0], numeric, true)
    } catch (error) {
      if ((error as { errno?: number }).errno === 3024) throw new TimeoutError()
      throw error
    }
  }

  async query(text: string, signal?: AbortSignal): Promise<QueryResult> {
    // Hold one connection so we know which server thread to kill if the run is cancelled.
    const connection = await this.pool.getConnection()
    try {
      return await this.runOn(connection, text, signal)
    } finally {
      connection.release()
    }
  }

  async begin(): Promise<DriverTransaction> {
    const connection = await this.pool.getConnection()
    try {
      await connection.query('START TRANSACTION')
    } catch (error) {
      connection.release()
      throw error
    }
    let open = true
    /** A broken connection mustn't go back to the pool, where its state could leak into other queries. */
    const end = (broken = false): void => {
      if (!open) return
      open = false
      if (broken) connection.destroy()
      else connection.release()
    }
    // A deadlock victim's whole transaction is rolled back by the server; a fatal error loses the connection.
    const watch = <T>(run: Promise<T>): Promise<T> => run.catch((error) => {
      if ((error as { fatal?: boolean }).fatal) end(true)
      else if ((error as { errno?: number }).errno === 1213) end()
      throw error
    })
    return {
      get open() {
        return open
      },
      query: (text, signal) => watch(this.runOn(connection, text, signal)),
      execute: async (statement) => {
        // mysql2 connects with FOUND_ROWS, so this counts matched rows even when a value didn't change.
        const [result] = await watch(connection.query(statement))
        return (result as mysql.ResultSetHeader).affectedRows
      },
      commit: async () => {
        try {
          await connection.commit()
          end()
        } catch (error) {
          end(true)
          throw error
        }
      },
      rollback: async () => {
        if (!open) return
        try {
          await connection.rollback()
          end()
        } catch (error) {
          end(true)
          throw error
        }
      }
    }
  }

  private async runOn(connection: mysql.PoolConnection, text: string, signal?: AbortSignal): Promise<QueryResult> {
    const started = Date.now()
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
      // Wait for the KILL to land before the connection is used again, so it can't hit the next query.
      if (kill) await kill
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
