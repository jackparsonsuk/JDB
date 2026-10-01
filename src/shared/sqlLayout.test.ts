import { describe, expect, it } from 'vitest'
import { layoutSql, lex } from './sqlLayout'
import type { DbKind } from './types'

const PROC = `CREATE PROCEDURE [dbo].[SaveOrder] @Id int, @Total money OUTPUT AS BEGIN SET NOCOUNT ON; -- make sure it exists
IF @Id IS NULL BEGIN RAISERROR('no id',16,1) RETURN -1 END ELSE IF EXISTS(select 1 from dbo.Orders o inner join dbo.OrderLines l on l.OrderId = o.Id where o.Id=@Id and l.Qty > 0 and o.Status in (1,2,3))
update o set o.Total=@Total, o.UpdatedAt = getdate(), o.Note = coalesce(@Note, o.Note), o.UpdatedBy = suser_sname() from dbo.Orders o where o.Id=@Id
else
  insert into dbo.Orders(Id, Total) values(@Id, @Total)

/* ===== Audit ===== */
BEGIN TRY BEGIN TRAN insert into audit.Log(Id, Kind) select Id, case when Total > 1000 then 'big' when Total > 100 then 'medium' else 'small' end from #t; COMMIT END TRY BEGIN CATCH ROLLBACK; THROW; END CATCH
EXEC dbo.LogIt @Id
RETURN 0 END`

const MYSQL = "CREATE DEFINER=`root`@`localhost` PROCEDURE `archive`(IN p_id INT)\nBEGIN\n  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;\n  IF p_id > 0 THEN update orders set x=1 where id=p_id; ELSEIF p_id=0 THEN delete from orders; ELSE select IF(p_id < 0, 'a', 'b') into @x; END IF;\n  insert into log(a) values (1) on duplicate key update a = a + 1;\nEND"

const tokens = (sql: string, kind: DbKind) => lex(sql, kind).map((t) => (t.type === 'word' ? t.upper : t.text))
const outline = (sql: string, kind: DbKind = 'mssql') =>
  layoutSql(sql, kind, true).outline.map((o) => `${'  '.repeat(o.depth)}${o.kind}: ${o.label}`)

describe('layoutSql', () => {
  it('only changes spacing and keyword case, and is stable', () => {
    for (const [sql, kind] of [[PROC, 'mssql'], [MYSQL, 'mysql']] as const) {
      const once = layoutSql(sql, kind, true)
      expect(once.formatted).toBe(true)
      expect(tokens(once.text, kind)).toEqual(tokens(sql, kind))
      expect(layoutSql(once.text, kind, true).text).toBe(once.text)
    }
  })

  it('writes keywords in lower case when asked, leaving names and strings alone', () => {
    const lower = layoutSql("SELECT o.Id, o.Status FROM dbo.Orders o WHERE o.Status = 'OPEN'", 'mssql', true, true)
    expect(lower.formatted).toBe(true)
    expect(lower.text).toBe("select o.Id, o.Status\nfrom dbo.Orders o\nwhere o.Status = 'OPEN'")
  })

  it('lays out a procedure header, blocks, IF / ELSE and clauses', () => {
    const lines = layoutSql(PROC, 'mssql', true).text.split('\n')
    expect(lines.slice(0, 8)).toEqual([
      'CREATE PROCEDURE [dbo].[SaveOrder]',
      '    @Id int,',
      '    @Total money OUTPUT',
      'AS',
      'BEGIN',
      '    SET NOCOUNT ON;',
      '    -- make sure it exists',
      '    IF @Id IS NULL'
    ])
    const text = lines.join('\n')
    expect(text).toContain([
      '    ELSE IF EXISTS(',
      '        SELECT 1',
      '        FROM dbo.Orders o',
      '        INNER JOIN dbo.OrderLines l ON l.OrderId = o.Id',
      '        WHERE o.Id=@Id AND l.Qty > 0 AND o.Status IN (1,2,3)',
      '    )',
      '        UPDATE o',
      '        SET',
      '            o.Total=@Total,'
    ].join('\n'))
    expect(text).toContain('    ELSE\n        INSERT INTO dbo.Orders(Id, Total)\n        VALUES(@Id, @Total)\n\n    /* ===== Audit ===== */\n    BEGIN TRY')
    expect(text).toContain('            CASE\n                WHEN Total > 1000 THEN \'big\'')
    expect(text).toContain('    END CATCH\n    EXEC dbo.LogIt @Id\n    RETURN 0\nEND')
  })

  it('binds a dangling ELSE to the nearest IF', () => {
    const text = layoutSql('IF @a = 1 IF @b = 2 SELECT 1 ELSE SELECT 2 SELECT 3', 'mssql', true).text
    expect(text).toBe('IF @a = 1\n    IF @b = 2\n        SELECT 1\n    ELSE\n        SELECT 2\nSELECT 3')
  })

  it('keeps short subqueries, CASE and trailing comments on their line', () => {
    const text = layoutSql("SELECT a, CASE WHEN b = 1 THEN 'x' END FROM t WHERE Id IN (SELECT Id FROM u) -- note\nSELECT 2", 'mssql', true).text
    expect(text).toBe("SELECT a, CASE WHEN b = 1 THEN 'x' END\nFROM t\nWHERE Id IN (SELECT Id FROM u) -- note\nSELECT 2")
  })

  it('breaks long conditions before AND / OR, but not inside BETWEEN', () => {
    const text = layoutSql('SELECT 1 FROM t WHERE a BETWEEN 1 AND 100 AND someLongColumnName IS NOT NULL AND anotherLongColumnName = 42 OR x = 1', 'mssql', true).text
    expect(text.split('\n')).toEqual([
      'SELECT 1',
      'FROM t',
      'WHERE a BETWEEN 1 AND 100',
      '    AND someLongColumnName IS NOT NULL',
      '    AND anotherLongColumnName = 42',
      '    OR x = 1'
    ])
  })

  it('handles MySQL IF / ELSEIF / END IF, handlers and ON DUPLICATE KEY UPDATE', () => {
    const text = layoutSql(MYSQL, 'mysql', true).text
    expect(text).toContain('    DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;\n    IF p_id > 0 THEN\n        UPDATE orders\n        SET x=1\n        WHERE id=p_id;\n    ELSEIF p_id=0 THEN')
    expect(text).toContain("    ELSE\n        SELECT IF(p_id < 0, 'a', 'b')\n        INTO @x;\n    END IF;")
    expect(text).toContain('ON DUPLICATE KEY UPDATE a = a + 1;')
  })

  it('leaves strings, comments and names alone', () => {
    const sql = "select 'from x where' as [select], `order`.id /* select from */ from dbo.[order]"
    const text = layoutSql(sql, 'mssql', true).text
    expect(text).toContain("'from x where'")
    expect(text).toContain('[select]')
    expect(text).toContain('/* select from */')
  })

  it('copes with broken or odd input without losing anything', () => {
    const odd = ['', 'END END ELSE', 'SELECT (((', 'CASE WHEN', "SELECT 'unterminated", 'BEGIN IF x', ') ) SELECT', '/* open comment', 'lbl: BEGIN END lbl', 'ELSE IF']
    for (const sql of odd) {
      for (const kind of ['mssql', 'mysql'] as const) {
        const r = layoutSql(sql, kind, true)
        expect(tokens(r.text, kind)).toEqual(tokens(sql, kind))
      }
    }
  })

  it('returns the source unchanged when not formatting, with outline lines in it', () => {
    const r = layoutSql('SELECT 1\n\nUPDATE t SET a = 1', 'mssql', false)
    expect(r.text).toBe('SELECT 1\n\nUPDATE t SET a = 1')
    expect(r.formatted).toBe(false)
    expect(r.outline.map((o) => [o.kind, o.line])).toEqual([['read', 1], ['write', 3]])
  })
})

describe('outline', () => {
  it('lists control flow, writes, calls, transactions and errors with nesting', () => {
    expect(outline(PROC)).toEqual([
      '  control: IF @Id IS NULL',
      '    error: RAISERROR \'no id\'',
      '    return: RETURN -1',
      '  control: ELSE IF EXISTS(SELECT 1 FROM dbo.Orders o INNER JOIN dbo.OrderLines…',
      '    write: UPDATE dbo.Orders',
      '  control: ELSE',
      '    write: INSERT dbo.Orders',
      '  comment: Audit',
      '  control: TRY',
      '    tx: BEGIN TRANSACTION',
      '    write: INSERT audit.Log',
      '    tx: COMMIT',
      '  control: CATCH',
      '    tx: ROLLBACK',
      '    error: THROW',
      '  call: EXEC dbo.LogIt',
      '  return: RETURN 0'
    ])
  })

  it('names temp tables, SELECT INTO, cursors and dynamic SQL', () => {
    expect(outline(`CREATE TABLE #work (Id int)
SELECT Id INTO #copy FROM dbo.Orders
DECLARE c CURSOR FOR SELECT Id FROM #work
EXEC sp_executesql @sql
EXEC (@sql)
DELETE w FROM #work w JOIN dbo.Orders o ON o.Id = w.Id`)).toEqual([
      'temp: CREATE TABLE #work',
      'temp: SELECT INTO #copy',
      'cursor: CURSOR c',
      'call: EXEC dynamic SQL',
      'call: EXEC dynamic SQL',
      'temp: DELETE #work'
    ])
  })

  it('treats a MySQL handler as control flow, named by what it handles', () => {
    expect(outline('BEGIN\n  DECLARE CONTINUE HANDLER FOR NOT FOUND SET done = 1;\n  SELECT 1;\nEND', 'mysql')).toEqual([
      '  control: CONTINUE HANDLER FOR NOT FOUND',
      '  read: SELECT 1'
    ])
  })

  it('skips commented-out code but keeps headings', () => {
    expect(outline('-- Step 1: load\nSELECT 1\n--SELECT * FROM old\nSELECT 2')).toEqual([
      'comment: Step 1: load',
      'read: SELECT 1',
      'read: SELECT 2'
    ])
  })

  it('points at lines of the formatted text', () => {
    const r = layoutSql('BEGIN UPDATE t SET a = 1 EXEC dbo.x END', 'mssql', true)
    const lines = r.text.split('\n')
    for (const item of r.outline) expect(lines[item.line - 1]).toMatch(item.kind === 'write' ? /UPDATE t/ : /EXEC dbo\.x/)
  })
})
