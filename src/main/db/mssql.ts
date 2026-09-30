import sql from 'mssql'
import type { AccessToken } from '@azure/identity'
import { keyKind } from '@shared/links'
import type {
  CellValue, ColumnFilter, ColumnInfo, ConnectionConfig, DatabaseList, QueryResult, ResultSet, RowsRequest, RowsResult,
  ColumnSummary, DesignColumn, DesignForeignKey, DesignIndex, KeyKind, SchemaTable, TableDesign, TableDetails, TableInfo, TableRef, ValueLookup,
  RoutineDefinition, RoutineInfo, RoutineKind, RoutineParam, RoutineRef, RoutineSource
} from '@shared/types'
import { assembleSchema, chunk, distinctSource, indexKey, KEY_BATCH, QueryCancelledError, MSSQL_UNCOMPARABLE, SAMPLE_SCAN_ROWS, summaryFrom, TimeoutError, toCell, type Driver, type DriverTransaction, type SchemaColumnRow } from './driver'
import { buildWhere } from './filters'
import { isNumericType } from '@shared/edits'
import { getEntraToken } from './entra'
import { APP_NAME } from '@shared/brand'

const AZURE_SQL_SCOPE = 'https://database.windows.net/.default'
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000

const quote = (identifier: string): string => `[${identifier.replace(/]/g, ']]')}]`
const qualified = (table: TableRef): string => `${quote(table.schema)}.${quote(table.name)}`

export class MssqlDriver implements Driver {
  private pool: sql.ConnectionPool | null = null
  private connecting: Promise<sql.ConnectionPool> | null = null
  private token: AccessToken | null = null
  private primaryKeys = new Map<string, string[]>()
  /** Transactions pin a pooled connection, so the pool mustn't be swapped out under them. */
  private openTransactions = 0

  constructor(
    private readonly config: ConnectionConfig,
    private readonly password: string | undefined
  ) {}

  private async buildConfig(): Promise<sql.config> {
    const base: sql.config = {
      server: this.config.host,
      port: this.config.port || 1433,
      database: this.config.database || undefined,
      connectionTimeout: 20_000,
      requestTimeout: 120_000,
      options: {
        encrypt: true,
        trustServerCertificate: this.config.trustServerCertificate ?? false,
        appName: APP_NAME
      }
    }

    switch (this.config.authType) {
      case 'sql':
        return { ...base, user: this.config.user, password: this.password }
      case 'entra-default':
        return { ...base, authentication: { type: 'azure-active-directory-default', options: {} } }
      case 'entra-browser': {
        // Silent from the saved sign-in when possible; opens the browser only when it has to.
        this.token = await getEntraToken(AZURE_SQL_SCOPE, this.config.tenantId || undefined)
        return {
          ...base,
          authentication: { type: 'azure-active-directory-access-token', options: { token: this.token.token } }
        }
      }
    }
  }

  private tokenExpiring(): boolean {
    return this.token !== null && this.token.expiresOnTimestamp - Date.now() < TOKEN_REFRESH_MARGIN_MS
  }

  private async getPool(): Promise<sql.ConnectionPool> {
    if (this.pool && this.tokenExpiring() && this.openTransactions === 0) {
      // Pooled connections reuse the token they were created with, so rebuild before it lapses.
      // Existing connections stay signed in, so a pool holding a transaction waits until it ends.
      const old = this.pool
      this.pool = null
      await old.close().catch(() => undefined)
    }
    if (this.pool) return this.pool
    // Callers arriving while a connection is being made share it. Otherwise each builds its own
    // pool and signs in separately, and a sign-in that never completes leaves its caller hanging.
    if (!this.connecting) {
      this.connecting = (async () => {
        const pool = new sql.ConnectionPool(await this.buildConfig())
        await pool.connect()
        this.pool = pool
        return pool
      })().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async request(): Promise<sql.Request> {
    return (await this.getPool()).request()
  }

  async listTables(): Promise<TableInfo[]> {
    const result = await (await this.request()).query(`
      SELECT s.name AS [schema], o.name, o.type, SUM(p.rows) AS row_estimate
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      LEFT JOIN sys.partitions p ON p.object_id = o.object_id AND p.index_id IN (0, 1)
      WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
      GROUP BY s.name, o.name, o.type
      ORDER BY s.name, o.name`)
    return result.recordset.map((row) => ({
      schema: row.schema,
      name: row.name,
      type: row.type.trim() === 'V' ? 'view' : 'table',
      rowEstimate: row.row_estimate == null ? undefined : Number(row.row_estimate)
    }))
  }

  async listDatabases(): Promise<DatabaseList> {
    // On Azure SQL, master lists every database on the server; a user database lists itself and master.
    const result = await (await this.request()).query(`
      SELECT DB_NAME() AS current_db;
      SELECT name FROM sys.databases WHERE name NOT IN ('master', 'tempdb', 'model', 'msdb') ORDER BY name`)
    const sets = result.recordsets as unknown as { current_db?: string; name?: string }[][]
    return { current: sets[0]?.[0]?.current_db ?? null, databases: (sets[1] ?? []).map((r) => String(r.name)) }
  }

  async listRoutines(): Promise<RoutineInfo[]> {
    // SSMS's diagram support procs are marked with an extended property rather than is_ms_shipped.
    const result = await (await this.request()).query(`
      SELECT s.name AS [schema], o.name, o.type, o.modify_date AS modified,
             ps.name AS parent_schema, p.name AS parent_name, tr.is_disabled, tr.is_instead_of_trigger,
             STUFF((SELECT ', ' + te.type_desc FROM sys.trigger_events te WHERE te.object_id = o.object_id FOR XML PATH('')), 1, 2, '') AS events
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      LEFT JOIN sys.triggers tr ON tr.object_id = o.object_id
      LEFT JOIN sys.objects p ON p.object_id = tr.parent_id
      LEFT JOIN sys.schemas ps ON ps.schema_id = p.schema_id
      WHERE o.type IN (${ROUTINE_TYPES}) AND o.is_ms_shipped = 0
        AND NOT EXISTS (SELECT 1 FROM sys.extended_properties ep WHERE ep.major_id = o.object_id AND ep.name = 'microsoft_database_tools_support')
      ORDER BY s.name, o.name`)
    return result.recordset.map((row) => routineInfo(row))
  }

  async describeRoutine(routine: RoutineRef): Promise<RoutineDefinition> {
    const request = await this.request()
    request.input('name', sql.NVarChar, qualified(routine))
    const result = await request.query(`
      SELECT s.name AS [schema], o.name, o.type, o.create_date AS created, o.modify_date AS modified,
             OBJECT_DEFINITION(o.object_id) AS definition,
             ps.name AS parent_schema, p.name AS parent_name, tr.is_disabled, tr.is_instead_of_trigger,
             STUFF((SELECT ', ' + te.type_desc FROM sys.trigger_events te WHERE te.object_id = o.object_id FOR XML PATH('')), 1, 2, '') AS events
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      LEFT JOIN sys.triggers tr ON tr.object_id = o.object_id
      LEFT JOIN sys.objects p ON p.object_id = tr.parent_id
      LEFT JOIN sys.schemas ps ON ps.schema_id = p.schema_id
      WHERE o.object_id = OBJECT_ID(@name) AND o.type IN (${ROUTINE_TYPES});

      SELECT prm.parameter_id, prm.name, prm.is_output, prm.has_default_value,
             COALESCE(TYPE_NAME(prm.user_type_id), TYPE_NAME(prm.system_type_id), 'unknown') AS type_name,
             prm.max_length, prm.precision, prm.scale
      FROM sys.parameters prm
      WHERE prm.object_id = OBJECT_ID(@name)
      ORDER BY prm.parameter_id`)
    const [objects, params] = result.recordsets as unknown as Record<string, any>[][]
    const row = objects[0]
    if (!row) throw new Error(`${routine.schema}.${routine.name} no longer exists, or this login can't see it.`)
    const info = routineInfo(row)
    const type = String(row.type).trim()
    // parameter_id 0 is a scalar function's return value.
    const returnRow = params.find((p) => p.parameter_id === 0)
    const parameters: RoutineParam[] = params.filter((p) => p.parameter_id > 0).map((p) => ({
      name: p.name,
      dataType: formatType(p.type_name, p.max_length, p.precision, p.scale),
      mode: p.is_output ? 'INOUT' : 'IN',
      ...(p.has_default_value && { hasDefault: true })
    }))
    return {
      routine: info,
      definition: row.definition ?? null,
      parameters,
      returns: ['IF', 'TF', 'FT'].includes(type) ? 'TABLE' : returnRow ? formatType(returnRow.type_name, returnRow.max_length, returnRow.precision, returnRow.scale) : undefined,
      created: row.created instanceof Date ? row.created.toISOString() : undefined
    }
  }

  async routineSources(): Promise<RoutineSource[]> {
    const result = await (await this.request()).query(`
      SELECT s.name AS [schema], o.name, o.type, OBJECT_DEFINITION(o.object_id) AS definition
      FROM sys.objects o
      JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN (${ROUTINE_TYPES}) AND o.is_ms_shipped = 0`)
    return result.recordset.map((row) => ({ schema: row.schema, name: row.name, kind: routineKind(row.type), definition: row.definition ?? null }))
  }

  async describeTable(table: TableRef): Promise<TableDetails> {
    const request = await this.request()
    request.input('name', sql.NVarChar, qualified(table))
    const result = await request.query(`
      DECLARE @id INT = OBJECT_ID(@name);
      SELECT c.name, COALESCE(TYPE_NAME(c.user_type_id), TYPE_NAME(c.system_type_id), 'unknown') AS type_name, c.max_length, c.precision, c.scale,
             c.is_nullable, c.is_identity,
             CAST(CASE WHEN EXISTS (
               SELECT 1 FROM sys.indexes i
               JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
               WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id
             ) THEN 1 ELSE 0 END AS BIT) AS is_pk
      FROM sys.columns c WHERE c.object_id = @id ORDER BY c.column_id;

      SELECT pc.name AS column_name, rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_column
      FROM sys.foreign_key_columns fkc
      JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
      JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
      JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE fkc.parent_object_id = @id;

      SELECT ps.name AS child_schema, pt.name AS child_table, pc.name AS child_column, rc.name AS ref_column
      FROM sys.foreign_key_columns fkc
      JOIN sys.tables pt ON pt.object_id = fkc.parent_object_id
      JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
      JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE fkc.referenced_object_id = @id
      ORDER BY ps.name, pt.name;`)

    const [columnRows, fkRows, reverseRows] = result.recordsets as unknown as Record<string, any>[][]
    const fks = new Map(fkRows.map((fk) => [fk.column_name, fk]))
    const columns: ColumnInfo[] = columnRows.map((c) => {
      const fk = fks.get(c.name)
      return {
        name: c.name,
        dataType: formatType(c.type_name, c.max_length, c.precision, c.scale),
        nullable: c.is_nullable,
        isPrimaryKey: c.is_pk,
        isIdentity: c.is_identity,
        references: fk ? { schema: fk.ref_schema, name: fk.ref_table, column: fk.ref_column } : undefined
      }
    })
    this.primaryKeys.set(qualified(table), columns.filter((c) => c.isPrimaryKey).map((c) => c.name))

    return {
      columns,
      referencedBy: reverseRows.map((r) => ({
        table: { schema: r.child_schema, name: r.child_table },
        column: r.child_column,
        referencedColumn: r.ref_column
      }))
    }
  }

  async describeDesign(table: TableRef): Promise<TableDesign> {
    const request = await this.request()
    request.input('name', sql.NVarChar, qualified(table))
    const result = await request.query(`
      DECLARE @id INT = OBJECT_ID(@name);
      SELECT c.name, COALESCE(TYPE_NAME(c.user_type_id), TYPE_NAME(c.system_type_id), 'unknown') AS type_name, c.max_length, c.precision, c.scale,
             c.is_nullable, c.is_identity, c.is_computed, c.collation_name, dc.name AS default_name, dc.definition AS default_definition,
             cc.definition AS computed_definition,
             CAST(CASE WHEN EXISTS (
               SELECT 1 FROM sys.indexes i
               JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
               WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id
             ) THEN 1 ELSE 0 END AS BIT) AS is_pk
      FROM sys.columns c
      LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
      LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
      WHERE c.object_id = @id ORDER BY c.column_id;

      SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc, c.name AS column_name, ic.is_included_column
      FROM sys.indexes i
      JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
      JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
      WHERE i.object_id = @id AND i.type > 0
      ORDER BY i.is_primary_key DESC, i.name, ic.is_included_column, ic.key_ordinal, ic.index_column_id;

      SELECT fk.name, pc.name AS column_name, rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_column,
             fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update
      FROM sys.foreign_keys fk
      JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
      JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
      JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
      JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
      WHERE fk.parent_object_id = @id
      ORDER BY fk.name, fkc.constraint_column_id;`)

    const [columnRows, indexRows, fkRows] = result.recordsets as unknown as Record<string, any>[][]
    const fkColumns = new Map<string, { schema: string; name: string; column: string }>()
    for (const fk of fkRows) if (!fkColumns.has(fk.column_name)) fkColumns.set(fk.column_name, { schema: fk.ref_schema, name: fk.ref_table, column: fk.ref_column })
    const columns: DesignColumn[] = columnRows.map((c) => ({
      name: c.name,
      dataType: formatType(c.type_name, c.max_length, c.precision, c.scale),
      nullable: c.is_nullable,
      isPrimaryKey: c.is_pk,
      isIdentity: c.is_identity,
      references: fkColumns.get(c.name),
      default: c.default_definition ?? null,
      ...(c.default_name && { defaultConstraint: c.default_name }),
      ...(c.default_name && c.default_definition == null && { defaultHidden: true }),
      // The definition is hidden without VIEW DEFINITION, but the column is still computed.
      ...(c.is_computed && { computed: c.computed_definition ?? '(definition hidden)' }),
      ...(c.collation_name && { collation: c.collation_name })
    }))
    const { referencedBy } = await this.describeTable(table)
    return { columns, indexes: groupIndexes(indexRows), foreignKeys: groupForeignKeys(fkRows), referencedBy }
  }

  forgetCaches(): void {
    this.primaryKeys.clear()
  }

  async describeSchema(): Promise<SchemaTable[]> {
    const [tables, result] = await Promise.all([
      this.listTables(),
      (await this.request()).query(`
        SELECT s.name AS [schema], o.name AS [table], c.name AS [column],
               COALESCE(TYPE_NAME(c.user_type_id), TYPE_NAME(c.system_type_id), 'unknown') AS type_name, c.max_length, c.precision, c.scale,
               c.is_nullable, c.is_identity,
               CAST(CASE WHEN EXISTS (
                 SELECT 1 FROM sys.indexes i
                 JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                 WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id
               ) THEN 1 ELSE 0 END AS BIT) AS is_pk,
               rs.name AS ref_schema, rt.name AS ref_table, rc.name AS ref_column
        FROM sys.objects o
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        JOIN sys.columns c ON c.object_id = o.object_id
        LEFT JOIN sys.foreign_key_columns fkc ON fkc.parent_object_id = o.object_id AND fkc.parent_column_id = c.column_id
        LEFT JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
        LEFT JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
        LEFT JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
        WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
        ORDER BY s.name, o.name, c.column_id`)
    ])
    const rows: SchemaColumnRow[] = result.recordset.map((r) => ({
      schema: r.schema,
      table: r.table,
      column: r.column,
      dataType: formatType(r.type_name, r.max_length, r.precision, r.scale),
      nullable: r.is_nullable,
      isPrimaryKey: r.is_pk,
      isIdentity: r.is_identity,
      refSchema: r.ref_schema,
      refTable: r.ref_table,
      refColumn: r.ref_column
    }))
    return assembleSchema(tables, rows)
  }

  async distinctValues(table: TableRef, column: string, limit: number, via?: ValueLookup): Promise<CellValue[] | null> {
    const source = distinctSource(quote, qualified, table, column, via)
    const request = await this.request()
    request.arrayRowMode = true
    const result = await request.query(
      `SELECT DISTINCT TOP ${Math.floor(limit) + 1} ${source.expr} FROM ${source.from}`
    )
    const values = (result.recordset as unknown as unknown[][]).map((row) => toCell(row[0]))
    return values.length > limit ? null : values
  }

  async sampleDistinct(table: TableRef, column: string, limit: number): Promise<CellValue[]> {
    const request = await this.request()
    request.arrayRowMode = true
    const result = await request.query(
      `SELECT DISTINCT TOP ${Math.floor(limit)} v FROM (SELECT TOP ${SAMPLE_SCAN_ROWS} ${quote(column)} AS v FROM ${qualified(table)} WHERE ${quote(column)} IS NOT NULL) s`
    )
    return (result.recordset as unknown as unknown[][]).map((row) => toCell(row[0]))
  }

  async countMatchingKeys(table: TableRef, column: string, values: string[], kind: KeyKind): Promise<number> {
    // Literals are inlined (not parameters) to allow large IN lists; callers pre-validate values per kind.
    const literal = (v: string): string => (kind === 'number' ? String(Number(v)) : `N'${v.replace(/'/g, "''")}'`)
    let matched = 0
    for (const batch of chunk(values, KEY_BATCH)) {
      const result = await (await this.request()).query(
        `SELECT COUNT(*) AS n FROM ${qualified(table)} WHERE ${quote(column)} IN (${batch.map(literal).join(', ')})`
      )
      matched += Number(result.recordset[0].n)
    }
    return matched
  }

  async indexedColumns(tables: TableRef[]): Promise<Set<string>> {
    const out = new Set<string>()
    for (const batch of chunk(tables, 200)) {
      const request = await this.request()
      batch.forEach((t, i) => request.input(`t${i}`, sql.NVarChar, qualified(t)))
      const result = await request.query(`
        SELECT OBJECT_SCHEMA_NAME(ic.object_id) AS s, OBJECT_NAME(ic.object_id) AS t, c.name AS c
        FROM sys.index_columns ic
        JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE ic.key_ordinal = 1 AND ic.object_id IN (${batch.map((_, i) => `OBJECT_ID(@t${i})`).join(', ')})`)
      for (const r of result.recordset) out.add(indexKey(r.s, r.t, r.c))
    }
    return out
  }

  async countWhere(table: TableRef, column: string, dataType: string, value: string, cap: number, timeoutMs: number): Promise<number> {
    const request = await this.request()
    // Type the parameter like the column so SQL Server can seek an index instead of converting every row.
    const kind = keyKind(dataType)
    if (kind === 'number') {
      if (!/^-?\d{1,15}$/.test(value)) return 0
      request.input('v', sql.BigInt, Number(value))
    } else if (kind === 'guid' && /uniqueidentifier/i.test(dataType)) {
      if (!/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) return 0
      request.input('v', sql.UniqueIdentifier, value)
    } else {
      request.input('v', /^n(var)?char|^ntext/i.test(dataType) ? sql.NVarChar : sql.VarChar, value)
    }
    const timer = setTimeout(() => request.cancel(), timeoutMs)
    try {
      const result = await request.query(
        `SELECT COUNT(*) AS n FROM (SELECT TOP (${Math.floor(cap) + 1}) 1 AS x FROM ${qualified(table)} WHERE ${quote(column)} = @v) s`
      )
      return Number(result.recordset[0].n)
    } catch (error) {
      if ((error as { code?: string }).code === 'ECANCEL') throw new TimeoutError()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async fetchRows(req: RowsRequest): Promise<RowsResult> {
    const key = qualified(req.table)
    if (!this.primaryKeys.has(key)) await this.describeTable(req.table)
    const pk = this.primaryKeys.get(key) ?? []

    const where = buildWhere(req.filters, quote, (i) => `@p${i}`)
    const orderBy = req.orderBy
      ? `${quote(req.orderBy)} ${req.orderDir === 'desc' ? 'DESC' : 'ASC'}`
      : pk.length ? pk.map(quote).join(', ') : '(SELECT NULL)'

    const request = await this.request()
    where.values.forEach((value, i) => request.input(`p${i}`, sql.NVarChar, value))
    request.arrayRowMode = true
    const offset = Math.max(0, Math.floor(req.offset))
    const limit = Math.max(1, Math.floor(req.limit))
    // One extra row says whether there's a next page without counting the table.
    const data = await request.query(
      `SELECT * FROM ${key} ${where.sql} ORDER BY ${orderBy} OFFSET ${offset} ROWS FETCH NEXT ${limit + 1} ROWS ONLY`
    )

    const set = toResultSets(data)[0] ?? { columns: [], rows: [] }
    return { columns: set.columns, rows: set.rows.slice(0, limit), hasMore: set.rows.length > limit }
  }

  async countRows(table: TableRef, filters: ColumnFilter[], timeoutMs: number): Promise<number> {
    const key = qualified(table)
    if (!filters.length) {
      // A table's row count is kept in its partition metadata, so there's no need to scan it.
      // Views have no partitions and fall through to a real count.
      const meta = await (await this.request()).input('t', sql.NVarChar, key).query(
        `SELECT SUM(rows) AS total FROM sys.partitions WHERE object_id = OBJECT_ID(@t) AND index_id IN (0, 1)`
      )
      const total = meta.recordset[0]?.total
      if (total != null) return Number(total)
    }
    const where = buildWhere(filters, quote, (i) => `@p${i}`)
    const request = await this.request()
    where.values.forEach((value, i) => request.input(`p${i}`, sql.NVarChar, value))
    const timer = setTimeout(() => request.cancel(), timeoutMs)
    try {
      const result = await request.query(`SELECT COUNT_BIG(*) AS total FROM ${key} ${where.sql}`)
      return Number(result.recordset[0].total)
    } catch (error) {
      if ((error as { code?: string }).code === 'ECANCEL') throw new TimeoutError()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async summarize(table: TableRef, filters: ColumnFilter[], column: string, dataType: string, timeoutMs: number): Promise<ColumnSummary> {
    const numeric = isNumericType(dataType)
    const distinct = !MSSQL_UNCOMPARABLE.test(dataType)
    const c = quote(column)
    // Cast so SUM can't overflow an int column, and so bit columns (no MIN/MAX/SUM) work too.
    const n = /^(float|real)\b/i.test(dataType) ? `CAST(${c} AS FLOAT)` : `CAST(${c} AS DECIMAL(38, 6))`
    const parts = [`COUNT(${c}) AS n`]
    if (distinct) parts.push(`COUNT(DISTINCT ${c}) AS d`)
    if (numeric) parts.push(`SUM(${n}) AS s`, `AVG(${n}) AS a`, `MIN(${n}) AS lo`, `MAX(${n}) AS hi`)
    const where = buildWhere(filters, quote, (i) => `@p${i}`)
    const request = await this.request()
    where.values.forEach((value, i) => request.input(`p${i}`, sql.NVarChar, value))
    const timer = setTimeout(() => request.cancel(), timeoutMs)
    try {
      const result = await request.query(`SELECT ${parts.join(', ')} FROM ${qualified(table)} ${where.sql}`)
      return summaryFrom(result.recordset[0], numeric, distinct)
    } catch (error) {
      if ((error as { code?: string }).code === 'ECANCEL') throw new TimeoutError()
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  query(text: string, signal?: AbortSignal): Promise<QueryResult> {
    return runBatches(() => this.request(), text, signal)
  }

  async begin(): Promise<DriverTransaction> {
    const transaction = new sql.Transaction(await this.getPool())
    await transaction.begin()
    this.openTransactions++
    let open = true
    const end = (): void => {
      if (!open) return
      open = false
      this.openTransactions--
    }
    // Also fires when the server aborts the transaction itself, e.g. a deadlock or XACT_ABORT.
    transaction.on('rollback', end)
    return {
      get open() {
        return open
      },
      query: (text, signal) => runBatches(async () => new sql.Request(transaction), text, signal),
      execute: async (statement) => {
        // @@ROWCOUNT is the statement's own count, not that of any triggers it fired.
        const result = await new sql.Request(transaction).query(`${statement}\nSELECT @@ROWCOUNT AS n`)
        const sets = result.recordsets as unknown as { n: number }[][]
        return Number(sets[sets.length - 1][0].n)
      },
      commit: async () => {
        try {
          await transaction.commit()
        } finally {
          end()
        }
      },
      rollback: async () => {
        if (!open) return
        try {
          await transaction.rollback()
        } finally {
          end()
        }
      }
    }
  }

  async close(): Promise<void> {
    await this.pool?.close()
    this.pool = null
  }
}

async function runBatches(newRequest: () => Promise<sql.Request>, text: string, signal?: AbortSignal): Promise<QueryResult> {
  const started = Date.now()
  const resultSets: ResultSet[] = []
  const rowsAffected: number[] = []
  // GO is a client-side batch separator, not T-SQL, so split on it like SSMS does. The capture
  // keeps the separators, so each batch knows the line it starts on for error positions.
  let firstLine = 1
  const pieces = text.split(/(^\s*GO\s*;?\s*$)/im)
  for (let i = 0; i < pieces.length; i++) {
    const batch = pieces[i]
    const startLine = firstLine
    firstLine += batch.split('\n').length - 1
    if (i % 2 === 1 || !batch.trim()) continue
    const request = await newRequest()
    if (signal?.aborted) throw new QueryCancelledError()
    request.arrayRowMode = true
    // Sends a TDS attention, which stops the batch server-side and leaves the connection usable.
    const onAbort = (): void => request.cancel()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await request.query(batch)
      resultSets.push(...toResultSets(result))
      rowsAffected.push(...result.rowsAffected)
    } catch (error) {
      if ((error as { code?: string }).code === 'ECANCEL') throw new QueryCancelledError()
      // The server counts lines from the start of the batch; the editor wants them from the top.
      const line = (error as { lineNumber?: number }).lineNumber
      if (typeof line === 'number' && line > 0) Object.assign(error as object, { sqlLine: startLine + line - 1 })
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }
  return { resultSets, rowsAffected, durationMs: Date.now() - started }
}

function toResultSets(result: sql.IResult<any>): ResultSet[] {
  // In arrayRowMode mssql exposes column metadata per recordset on result.columns.
  const columnSets = (result as unknown as { columns?: { name: string }[][] }).columns ?? []
  return (result.recordsets as unknown as unknown[][][]).map((rows, i) => ({
    columns: (columnSets[i] ?? []).map((c) => c.name),
    rows: rows.map((row) => row.map(toCell))
  }))
}

function groupIndexes(rows: Record<string, any>[]): DesignIndex[] {
  const byName = new Map<string, DesignIndex>()
  for (const r of rows) {
    let index = byName.get(r.name)
    if (!index) {
      index = { name: r.name, columns: [], included: [], unique: r.is_unique, primary: r.is_primary_key, type: String(r.type_desc).toLowerCase() }
      byName.set(r.name, index)
    }
    ;(r.is_included_column ? index.included : index.columns).push(r.column_name)
  }
  return [...byName.values()]
}

function groupForeignKeys(rows: Record<string, any>[]): DesignForeignKey[] {
  const byName = new Map<string, DesignForeignKey>()
  for (const r of rows) {
    let fk = byName.get(r.name)
    if (!fk) {
      const action = (a: string): string => String(a).replace(/_/g, ' ')
      fk = { name: r.name, columns: [], references: { schema: r.ref_schema, name: r.ref_table }, referencedColumns: [], onDelete: action(r.on_delete), onUpdate: action(r.on_update) }
      byName.set(r.name, fk)
    }
    fk.columns.push(r.column_name)
    fk.referencedColumns.push(r.ref_column)
  }
  return [...byName.values()]
}

/** sys.objects types: procedures (SQL, CLR), functions (scalar, inline, table-valued, CLR) and DML triggers. */
const ROUTINE_TYPES = `'P', 'PC', 'FN', 'FS', 'IF', 'TF', 'FT', 'TR'`

function routineKind(type: string): RoutineKind {
  const t = type.trim()
  return t === 'P' || t === 'PC' ? 'procedure' : t === 'TR' ? 'trigger' : 'function'
}

function routineInfo(row: Record<string, any>): RoutineInfo {
  const type = String(row.type).trim()
  const kind = routineKind(type)
  const info: RoutineInfo = { schema: row.schema, name: row.name, kind }
  if (row.modified instanceof Date) info.modified = row.modified.toISOString()
  if (kind === 'function') info.detail = ['IF', 'TF', 'FT'].includes(type) ? 'table' : 'scalar'
  if (kind === 'trigger') {
    if (row.parent_name) info.parent = { schema: row.parent_schema, name: row.parent_name }
    info.detail = `${row.is_instead_of_trigger ? 'INSTEAD OF' : 'AFTER'}${row.events ? ` ${row.events}` : ''}`
    if (row.is_disabled) info.disabled = true
  }
  return info
}

function formatType(name: string, maxLength: number, precision: number, scale: number): string {
  switch (name) {
    case 'nvarchar':
    case 'nchar':
      return `${name}(${maxLength === -1 ? 'max' : maxLength / 2})`
    case 'varchar':
    case 'char':
    case 'varbinary':
    case 'binary':
      return `${name}(${maxLength === -1 ? 'max' : maxLength})`
    case 'decimal':
    case 'numeric':
      return `${name}(${precision},${scale})`
    // 7 is the default; anything else must survive the designer's ALTER COLUMN.
    case 'datetime2':
    case 'time':
    case 'datetimeoffset':
      return scale === 7 ? name : `${name}(${scale})`
    default:
      return name
  }
}
