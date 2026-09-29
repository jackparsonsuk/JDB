import type { DbKind } from './types'

const WRITE_KEYWORDS = [
  'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE',
  'GRANT', 'REVOKE', 'DENY', 'EXEC', 'EXECUTE', 'CALL', 'REPLACE', 'RENAME', 'LOAD', 'BACKUP', 'RESTORE'
]
const WRITE_PATTERN = new RegExp(String.raw`\b(${WRITE_KEYWORDS.join('|')})\b`, 'i')

/**
 * Removes comments and string/identifier literals so keywords inside them don't count.
 * MySQL `#` comments are deliberately left in: stripping them would also swallow the rest
 * of a line after a T-SQL temp table name, hiding any write that follows. Over-blocking is safer.
 */
function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/`[^`]*`/g, '``')
    .replace(/\[[^\]]*\]/g, '[]')
}

/**
 * Statements that start or end a transaction themselves, which would break a staged one.
 * A bare BEGIN only starts a transaction in MySQL; in T-SQL it opens a BEGIN...END block.
 */
export function findTransactionControl(sql: string, kind: DbKind): string | null {
  const text = stripNoise(sql)
  const match = text.match(/\b(BEGIN\s+(?:DISTRIBUTED\s+)?TRAN(?:SACTION)?|BEGIN\s+WORK|START\s+TRANSACTION|COMMIT|ROLLBACK|SET\s+AUTOCOMMIT|SET\s+IMPLICIT_TRANSACTIONS)\b/i)
  if (match) return match[1].replace(/\s+/g, ' ').toUpperCase()
  if (kind === 'mysql' && /\bBEGIN\s*(;|$)/i.test(text)) return 'BEGIN'
  return null
}

/** MySQL commits any open transaction before these, so they can't be staged and rolled back. */
export function findImplicitCommit(sql: string): string | null {
  const match = stripNoise(sql).match(
    /\b(CREATE(?!\s+TEMPORARY)|ALTER|DROP(?!\s+TEMPORARY)|TRUNCATE|RENAME|LOCK\s+TABLES?|UNLOCK\s+TABLES?|GRANT|REVOKE|ANALYZE|OPTIMIZE|REPAIR|LOAD\s+DATA)\b/i
  )
  return match ? match[1].replace(/\s+/g, ' ').toUpperCase() : null
}

/** Returns the first write keyword found, or null when the SQL looks read-only. */
export function findWriteKeyword(sql: string): string | null {
  const match = stripNoise(sql).match(WRITE_PATTERN)
  if (match) return match[1].toUpperCase()
  if (/\bSELECT\b[\s\S]*\bINTO\b/i.test(stripNoise(sql))) return 'SELECT INTO'
  return null
}
