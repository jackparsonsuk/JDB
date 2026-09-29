import { describe, expect, it } from 'vitest'
import type { ColumnInfo, DbKind, SchemaTable } from '../types'
import { buildModel, valueSources } from './model'
import { translate, type ValueCache } from './translate'

// Thursday 25 September 2026
const NOW = new Date(2026, 8, 25, 14, 30)

function col(name: string, dataType: string, extra: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, dataType, nullable: true, isPrimaryKey: false, isIdentity: false, ...extra }
}

const pk = (name = 'Id', dataType = 'int'): ColumnInfo => col(name, dataType, { isPrimaryKey: true, nullable: false })
const fk = (name: string, table: string, dataType = 'int'): ColumnInfo =>
  col(name, dataType, { references: { schema: 'dbo', name: table, column: 'Id' } })

/** A small schema exercising the patterns the engine relies on: lookups, soft delete, child tables. */
const SCHEMA: SchemaTable[] = [
  {
    schema: 'dbo', name: 'Lookups', type: 'table', rowEstimate: 40,
    columns: [pk(), col('Label', 'nvarchar(100)')]
  },
  {
    schema: 'dbo', name: 'Customers', type: 'table', rowEstimate: 300,
    columns: [pk(), col('Name', 'nvarchar(200)'), fk('AccountManagerId', 'Users'), col('DeletedOn', 'datetime2')]
  },
  {
    schema: 'dbo', name: 'CustomerDocuments', type: 'table', rowEstimate: 10,
    columns: [pk(), fk('CustomerId', 'Customers'), col('FileName', 'nvarchar(255)')]
  },
  {
    schema: 'dbo', name: 'Users', type: 'table', rowEstimate: 50,
    columns: [pk(), col('UserName', 'nvarchar(100)'), col('Email', 'nvarchar(200)'), col('IsActive', 'bit')]
  },
  {
    schema: 'dbo', name: 'Invoices', type: 'table', rowEstimate: 5000,
    columns: [
      pk(), col('InvoiceDate', 'datetime2'), col('CreatedOn', 'datetime2'), col('ExportedDatetime', 'datetime2'),
      col('TotalNet', 'decimal(18,2)'), col('TotalGross', 'decimal(18,2)'), fk('InvoiceStatusId', 'Lookups'),
      col('CustomerName', 'nvarchar(200)'), col('DeletedOn', 'datetime2')
    ]
  },
  {
    schema: 'dbo', name: 'InvoiceLines', type: 'table', rowEstimate: 20000,
    columns: [pk(), fk('InvoiceId', 'Invoices'), col('Amount', 'decimal(18,2)')]
  },
  {
    // No declared FK: the engine should infer JobId -> Jobs.Id from naming.
    schema: 'dbo', name: 'Jobs', type: 'table', rowEstimate: 900,
    columns: [pk(), col('CreatedDate', 'datetime2'), col('Reference', 'nvarchar(50)')]
  },
  {
    schema: 'dbo', name: 'JobNotes', type: 'table', rowEstimate: 4000,
    columns: [pk(), col('JobId', 'int'), col('Note', 'nvarchar(max)')]
  }
]

const STATUS_SOURCE = 'dbo.Invoices.InvoiceStatusId>dbo.Lookups.Label'

function run(text: string, kind: DbKind = 'mssql', values: ValueCache = new Map([[STATUS_SOURCE, ['Draft', 'Final', 'In Progress']]])) {
  return translate(text, buildModel(SCHEMA, kind), values, NOW)
}

function sql(text: string, kind: DbKind = 'mssql'): string {
  return run(text, kind).sql ?? ''
}

describe('translate', () => {
  it('needs a table', () => {
    expect(run('something else').sql).toBeNull()
  })

  it('hides soft-deleted rows unless asked', () => {
    expect(sql('invoices')).toContain('i.[DeletedOn] IS NULL')
    expect(sql('invoices including deleted')).not.toContain('DeletedOn')
  })

  it('uses the table-named date column, then created', () => {
    expect(sql('invoices this week')).toContain("i.[InvoiceDate] >= '20260921'")
    expect(sql('jobs this week')).toContain("j.[CreatedDate] >= '20260921'")
  })

  it('treats "after" a day as from the next day', () => {
    expect(sql('invoices created after 12/12/2025')).toContain("i.[CreatedOn] >= '20251213'")
  })

  it('writes MySQL dialect', () => {
    const out = sql('invoices created after 12/12/2025', 'mysql')
    expect(out).toContain("i.`CreatedOn` >= '2025-12-13'")
    expect(out).toMatch(/LIMIT 1000$/)
  })

  it('matches lookup values through the foreign key', () => {
    const out = sql('draft invoices')
    expect(out).toContain('JOIN [dbo].[Lookups] status ON status.[Id] = i.[InvoiceStatusId]')
    expect(out).toContain("status.[Label] = 'Draft'")
  })

  it('merges "or" values and multi-word values', () => {
    expect(sql('final or draft invoices')).toContain("status.[Label] IN ('Final', 'Draft')")
    expect(sql('in progress invoices')).toContain("status.[Label] = 'In Progress'")
  })

  it('asks for value lists it has not loaded yet', () => {
    const result = run('draft invoices', 'mssql', new Map())
    expect(result.wanted.map((w) => w.key)).toContain(STATUS_SOURCE)
  })

  it('reads event-named date columns as adjectives', () => {
    expect(sql('exported invoices')).toContain('i.[ExportedDatetime] IS NOT NULL')
    expect(sql('invoices not exported')).toContain('i.[ExportedDatetime] IS NULL')
    expect(sql('exported invoices last month')).toContain("i.[ExportedDatetime] >= '20260801'")
  })

  it('compares numbers and sorts', () => {
    const out = sql('invoices with total net over 500 sorted by total gross desc')
    expect(out).toContain('i.[TotalNet] > 500')
    expect(out).toContain('ORDER BY i.[TotalGross] DESC')
  })

  it('limits and orders newest first', () => {
    const out = sql('latest 5 invoices')
    expect(out).toContain('TOP 5')
    expect(out).toContain('ORDER BY i.[InvoiceDate] DESC')
  })

  it('counts and groups by a lookup label', () => {
    const out = sql('how many invoices by status')
    expect(out).toContain('SELECT status.[Label], COUNT(*) AS [Count]')
    expect(out).toContain('GROUP BY status.[Label]')
    expect(out).not.toContain('TOP')
  })

  it('uses EXISTS for child tables', () => {
    expect(sql('customers with documents attached')).toContain('EXISTS (\n    SELECT 1 FROM [dbo].[CustomerDocuments] cd\n    WHERE cd.[CustomerId] = c.[Id]')
    expect(sql('customers without documents')).toContain('NOT EXISTS')
  })

  it('infers undeclared foreign keys from naming', () => {
    expect(sql('jobs with notes')).toContain('WHERE jn.[JobId] = j.[Id]')
  })

  it('does not match a child table on the main table word alone', () => {
    const out = sql('invoices with invoice lines')
    expect(out).toContain('[dbo].[InvoiceLines]')
    expect(sql('invoices with total net over 5')).not.toContain('InvoiceLines')
  })

  it('shows a parent column when asked "with"', () => {
    expect(sql('customers with account manager')).toContain('LEFT JOIN [dbo].[Users] manager ON manager.[Id] = c.[AccountManagerId]')
  })

  it('falls back to a text column for "for <thing> <value>"', () => {
    expect(sql('invoices for customer acme')).toContain("i.[CustomerName] LIKE '%acme%'")
  })

  it('handles booleans and text operators', () => {
    expect(sql('active users')).toContain('u.[IsActive] = 1')
    expect(sql('inactive users')).toContain('u.[IsActive] = 0')
    expect(sql('users where email contains example')).toContain("u.[Email] LIKE '%example%'")
    expect(sql('users with no email')).toContain("(u.[Email] IS NULL OR u.[Email] = '')")
  })

  it('escapes quotes in values', () => {
    expect(sql("users where email contains o'brien")).toContain("LIKE '%o''brien%'")
  })

  it('flags words it did not understand', () => {
    expect(run('invoices frobnicated').notes).toContain('Didn\'t understand "frobnicated"')
  })

  it('tolerates columns with no reported type', () => {
    const broken: SchemaTable[] = [{ schema: 'dss', name: 'Agent', type: 'table', columns: [col('Name', null as unknown as string)] }]
    expect(() => buildModel(broken, 'mssql')).not.toThrow()
  })

  describe('plan (diagram)', () => {
    it('describes joins, filters and sorting per table', () => {
      const plan = run('draft invoices created this week sorted by total gross desc').plan!
      expect(plan.main.name).toBe('Invoices')
      expect(plan.main.columns).toEqual(expect.arrayContaining([
        { name: 'CreatedOn', kind: 'filter', note: '21 Sept 2026 – 27 Sept 2026' },
        { name: 'TotalGross', kind: 'sort', note: 'sorted ↓' },
        { name: 'DeletedOn', kind: 'filter', note: 'hides deleted' },
        { name: 'InvoiceStatusId', kind: 'key' }
      ]))
      expect(plan.parents).toHaveLength(1)
      expect(plan.parents[0]).toMatchObject({ name: 'Lookups', caption: 'via InvoiceStatusId' })
      expect(plan.parents[0].columns).toContainEqual({ name: 'Label', kind: 'filter', note: '= Draft' })
      expect(plan.links).toEqual([{ kind: 'join', from: 'dbo.Invoices', fromColumn: 'InvoiceStatusId', to: 'dbo.Lookups#InvoiceStatusId', toColumn: 'Id' }])
    })

    it('shows child tables as EXISTS links pointing at the main table', () => {
      const plan = run('customers without documents').plan!
      expect(plan.children).toHaveLength(1)
      expect(plan.children[0]).toMatchObject({ name: 'CustomerDocuments', caption: 'must have none' })
      expect(plan.links[0]).toMatchObject({ kind: 'not-exists', fromColumn: 'CustomerId', to: 'dbo.Customers', toColumn: 'Id' })
    })

    it('suggests unused related tables with the phrase that adds them', () => {
      const plan = run('customers').plan!
      expect(plan.suggestions).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Users', side: 'parent', phrase: 'with account manager' }),
        expect.objectContaining({ name: 'CustomerDocuments', side: 'child', phrase: 'with documents' })
      ]))
      // Suggestions round-trip: using the phrase brings the table in.
      expect(run('customers with documents').plan!.suggestions.map((s) => s.name)).not.toContain('CustomerDocuments')
    })

    it('every suggestion phrase brings in the table it names', () => {
      for (const start of ['customers', 'invoices', 'jobs', 'users', 'lookups']) {
        for (const s of run(start).plan!.suggestions) {
          const plan = run(`${start} ${s.phrase}`).plan!
          expect([...plan.parents, ...plan.children].map((n) => n.name), `${start} ${s.phrase}`).toContain(s.name)
        }
      }
    })
  })

  it('only offers small, category-like columns as value sources', () => {
    const model = buildModel(SCHEMA, 'mssql')
    const invoices = model.tables.find((t) => t.info.name === 'Invoices')!
    expect(valueSources(invoices).map((s) => s.key)).toEqual([STATUS_SOURCE])
  })
})
