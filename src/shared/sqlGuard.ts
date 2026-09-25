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

/** Returns the first write keyword found, or null when the SQL looks read-only. */
export function findWriteKeyword(sql: string): string | null {
  const match = stripNoise(sql).match(WRITE_PATTERN)
  if (match) return match[1].toUpperCase()
  if (/\bSELECT\b[\s\S]*\bINTO\b/i.test(stripNoise(sql))) return 'SELECT INTO'
  return null
}
