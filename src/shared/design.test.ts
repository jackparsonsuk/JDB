import { describe, expect, it } from 'vitest'
import type { DesignColumn, TableDesign } from './types'
import { countChanges, designProblems, designSql, draftsFrom, type ColumnDraft } from './design'

const col = (name: string, dataType: string, extra: Partial<DesignColumn> = {}): DesignColumn => ({
  name, dataType, nullable: true, isPrimaryKey: false, isIdentity: false, default: null, ...extra
})

const design: TableDesign = {
  columns: [
    col('Id', 'int', { isPrimaryKey: true, isIdentity: true, nullable: false, extra: 'auto_increment' }),
    col('Name', 'nvarchar(50)', { collation: 'Latin1_General_CI_AS' }),
    col('Status', 'int', { default: '((0))', defaultConstraint: 'DF__Jobs__Status__1', nullable: false }),
    col('Notes', 'varchar(max)')
  ],
  indexes: [],
  foreignKeys: [],
  referencedBy: []
}
const table = { schema: 'dbo', name: 'Jobs' }

const edit = (change: (drafts: ColumnDraft[]) => void): ColumnDraft[] => {
  const drafts = draftsFrom(design)
  change(drafts)
  return drafts
}

describe('designSql for SQL Server', () => {
  it('writes nothing when nothing changed', () => {
    expect(designSql('mssql', table, design, draftsFrom(design))).toEqual([])
    expect(countChanges(design, draftsFrom(design))).toBe(0)
  })

  it('keeps the collation when retyping a text column, and renames last', () => {
    const drafts = edit((d) => {
      d[1].dataType = 'nvarchar(100)'
      d[1].name = 'Title'
    })
    expect(designSql('mssql', table, design, drafts)).toEqual([
      'ALTER TABLE [dbo].[Jobs] ALTER COLUMN [Name] nvarchar(100) COLLATE Latin1_General_CI_AS NULL;',
      "EXEC sp_rename N'[dbo].[Jobs].[Name]', N'Title', N'COLUMN';"
    ])
  })

  it('drops a default constraint before changing the default or dropping the column', () => {
    expect(designSql('mssql', table, design, edit((d) => { d[2].default = '1' }))).toEqual([
      'ALTER TABLE [dbo].[Jobs] DROP CONSTRAINT [DF__Jobs__Status__1];',
      'ALTER TABLE [dbo].[Jobs] ADD CONSTRAINT [DF_Jobs_Status] DEFAULT 1 FOR [Status];'
    ])
    expect(designSql('mssql', table, design, edit((d) => { d[2].drop = true }))).toEqual([
      'ALTER TABLE [dbo].[Jobs] DROP CONSTRAINT [DF__Jobs__Status__1];',
      'ALTER TABLE [dbo].[Jobs] DROP COLUMN [Status];'
    ])
  })

  it('puts a retyped column\'s default back', () => {
    expect(designSql('mssql', table, design, edit((d) => { d[2].dataType = 'bigint' }))).toEqual([
      'ALTER TABLE [dbo].[Jobs] DROP CONSTRAINT [DF__Jobs__Status__1];',
      'ALTER TABLE [dbo].[Jobs] ALTER COLUMN [Status] bigint NOT NULL;',
      'ALTER TABLE [dbo].[Jobs] ADD CONSTRAINT [DF_Jobs_Status] DEFAULT ((0)) FOR [Status];'
    ])
  })

  it('adds columns with a named default', () => {
    const drafts = [...draftsFrom(design), { name: 'CreatedOn', dataType: 'datetime2', nullable: false, default: 'SYSUTCDATETIME()' }]
    expect(designSql('mssql', table, design, drafts)).toEqual([
      'ALTER TABLE [dbo].[Jobs] ADD [CreatedOn] datetime2 NOT NULL CONSTRAINT [DF_Jobs_CreatedOn] DEFAULT SYSUTCDATETIME();'
    ])
  })
})

describe('designSql for MySQL', () => {
  it('makes one ALTER TABLE, keeping extras and collation on changed columns', () => {
    const drafts = edit((d) => {
      d[0].dataType = 'bigint'
      d[1].name = 'Title'
      d[3].drop = true
    })
    drafts.push({ name: 'Flag', dataType: 'tinyint(1)', nullable: false, default: '0' })
    expect(designSql('mysql', table, design, drafts)).toEqual([
      'ALTER TABLE `dbo`.`Jobs`\n'
      + '  DROP COLUMN `Notes`,\n'
      + '  CHANGE COLUMN `Id` `Id` bigint NOT NULL auto_increment,\n'
      + '  CHANGE COLUMN `Name` `Title` nvarchar(50) COLLATE Latin1_General_CI_AS NULL,\n'
      + '  ADD COLUMN `Flag` tinyint(1) NOT NULL DEFAULT 0;'
    ])
  })
})

describe('designProblems', () => {
  it('flags missing and repeated names, and unsafe new NOT NULL columns', () => {
    const drafts = edit((d) => { d[1].name = 'status' })
    drafts.push({ name: '', dataType: '', nullable: false, default: '' })
    const problems = designProblems(design, drafts)
    expect(problems).toContain('Every column needs a name.')
    expect(problems).toContain('More than one column is called status.')
    expect(problems.some((p) => p.includes('needs a data type'))).toBe(true)
    expect(problems.some((p) => p.includes('NOT NULL with no default'))).toBe(true)
  })

  it('stops a primary key column allowing NULL', () => {
    expect(designProblems(design, edit((d) => { d[0].nullable = true }))).toEqual(['Id is part of the primary key, so it can\'t allow NULL.'])
  })
})

describe('hidden defaults', () => {
  it('blocks changes that would drop a default JDB cannot read', () => {
    const hidden: TableDesign = { ...design, columns: [col('Id', 'int', { isPrimaryKey: true, nullable: false }), col('State', 'int', { defaultConstraint: 'DF_x', defaultHidden: true })] }
    const drafts = draftsFrom(hidden)
    drafts[1].dataType = 'bigint'
    expect(designProblems(hidden, drafts)).toEqual(["State has a default this login can't read, so changing its type or default would lose it."])
    const renameOnly = draftsFrom(hidden)
    renameOnly[1].name = 'Status'
    expect(designProblems(hidden, renameOnly)).toEqual([])
  })
})
