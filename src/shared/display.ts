import type { ColumnInfo } from './types'
import { splitIdentifier } from './nl/words'

const isText = (dataType: string | undefined): boolean => /char|text/i.test(dataType ?? '') && !/uniqueidentifier/i.test(dataType ?? '')
const isDate = (dataType: string | undefined): boolean => /date|time/i.test(dataType ?? '')
const plain = (name: string): string => name.toLowerCase().replace(/_/g, '')

/**
 * The most human-readable column of a table, for summaries, cards and "with <table>".
 * Order: a plain Name/Title/Label; the table's own reference or number (OrderReference, InvoiceNumber);
 * any reference or code; then anything name-like. A job is better identified by ClaimReference
 * than by ClientCompanyName.
 */
export function pickDisplayColumn(columns: ColumnInfo[], tableName: string): ColumnInfo | undefined {
  const text = columns.filter((c) => isText(c.dataType) && !c.isPrimaryKey && !c.references)
  const words = (c: ColumnInfo): string[] => splitIdentifier(c.name)
  const own = splitIdentifier(tableName).map((w) => w.replace(/(ies|s)$/, (m) => (m === 'ies' ? 'y' : '')))
  const ownPrefix = own.join('')

  const tiers: ((c: ColumnInfo) => boolean)[] = [
    (c) => ['name', 'title', 'label', 'displayname'].includes(plain(c.name)),
    (c) => ['reference', 'ref', 'number', 'no', 'name', 'code', 'title'].some((s) => plain(c.name) === `${ownPrefix}${s}`),
    (c) => ['reference', 'code', 'description'].includes(plain(c.name)),
    (c) => words(c).includes('reference'),
    (c) => words(c).includes('number') && !words(c).includes('phone'),
    (c) => words(c).some((w) => ['name', 'title', 'label'].includes(w))
  ]
  for (const tier of tiers) {
    const found = text.find(tier)
    if (found) return found
  }
  return text[0]
}

/** First date column that isn't audit plumbing, for showing when related records happened. */
export function pickDateColumn(columns: ColumnInfo[]): ColumnInfo | undefined {
  const dates = columns.filter((c) => isDate(c.dataType))
  const audit = /modified|updated|deleted|expire/i
  return dates.find((c) => /created/i.test(c.name)) ?? dates.find((c) => !audit.test(c.name))
}
