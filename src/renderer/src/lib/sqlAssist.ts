import type { Completion, CompletionSource } from '@codemirror/autocomplete'
import { LanguageSupport, syntaxTree } from '@codemirror/language'
import { keywordCompletionSource, schemaCompletionSource, type SQLDialect, type SQLNamespace } from '@codemirror/lang-sql'
import type { Model } from '@shared/nl/model'
import type { TableInfo } from '@shared/types'
import { columnOptions, defaultSchema, joinOptions, mentionedTables, resolveMentions, schemaTableOptions, statementAt } from '@shared/sqlComplete'

/**
 * The namespace lang-sql completes from: schema → table → columns. Before the full schema has loaded,
 * the table list alone still completes table names.
 */
export function sqlNamespace(tables: TableInfo[], model: Model | null): { schema: SQLNamespace; defaultSchema?: string } {
  const out: Record<string, Record<string, Completion[]>> = {}
  if (model) {
    for (const t of model.tables) {
      ;(out[t.info.schema] ??= {})[t.info.name] = t.columns.map((c) => ({ label: c.info.name, detail: c.info.dataType, type: 'property' }))
    }
    return { schema: out, defaultSchema: defaultSchema(model) }
  }
  for (const t of tables) (out[t.schema] ??= {})[t.name] = []
  const counts = new Map<string, number>()
  for (const t of tables) counts.set(t.schema, (counts.get(t.schema) ?? 0) + 1)
  const common = tables.some((t) => t.schema === 'dbo') ? 'dbo' : [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
  return { schema: out, defaultSchema: common }
}

const WORD = /[\w$#@]*$/

/**
 * lang-sql's `sql()` without its keyword completion straying past a dot: after "o." only the
 * table's columns are wanted, not DESC or DESCRIBE.
 */
export function sqlLanguage(dialect: SQLDialect, schema: SQLNamespace, defaultSchema?: string, upperKeywords = true): LanguageSupport {
  return new LanguageSupport(dialect.language, [
    dialect.language.data.of({ autocomplete: schemaCompletionSource({ dialect, schema, defaultSchema }) }),
    dialect.language.data.of({ autocomplete: notAfterDot(keywordCompletionSource(dialect, upperKeywords)) })
  ])
}

/** Leaves "alias.col" to the schema completion. */
export function notAfterDot(source: CompletionSource): CompletionSource {
  return (context) => {
    const word = context.matchBefore(WORD)
    const from = word ? word.from : context.pos
    return context.state.sliceDoc(from - 1, from) === '.' ? null : source(context)
  }
}

/**
 * Completes what lang-sql's schema completion can't: bare column names from the tables the statement
 * uses (before any "alias." is typed), and whole join clauses that follow foreign keys after JOIN.
 */
export function sqlAssist(model: Model, schema?: string): CompletionSource {
  // A tab started from a schema folder offers that schema's tables first, written in full. Not
  // needed for the default schema, whose tables lang-sql already offers unqualified.
  const fromSchema: Completion[] = schema && schema.toLowerCase() !== defaultSchema(model)?.toLowerCase()
    ? schemaTableOptions(model, schema).map((o) => ({ label: o.label, apply: o.apply, detail: o.detail, type: 'class', boost: 20 }))
    : []
  return (context) => {
    const node = syntaxTree(context.state).resolveInner(context.pos, -1)
    if (/String|Comment/.test(node.name)) return null
    const word = context.matchBefore(WORD)
    if (!word) return null
    const doc = context.state.doc.toString()
    // "alias.col" is lang-sql's job; it resolves aliases itself.
    if (doc[word.from - 1] === '.') return null
    const { text, offset } = statementAt(doc, context.pos)
    const before = doc.slice(offset, word.from)
    const mentions = mentionedTables(text)

    if (/\bJOIN\s+$/i.test(before)) {
      const others = mentions.filter((m) => m.from + offset !== word.from)
      const options = joinOptions(model, resolveMentions(others, model))
        .map((o): Completion => ({ label: o.label, detail: o.detail, type: 'class', boost: o.inferred ? 4 : 5 }))
        .concat(fromSchema.map((o) => ({ ...o, boost: 3 })))
      return options.length ? { from: word.from, options } : null
    }
    // After FROM and friends a table name is wanted, which lang-sql already offers (plus this tab's schema's).
    if (/\b(FROM|UPDATE|INTO|APPLY)\s+$/i.test(before)) return fromSchema.length ? { from: word.from, options: fromSchema, validFor: /^[\w$#@]*$/ } : null
    if (!word.text && !context.explicit) return null

    const resolved = resolveMentions(mentions, model)
    if (!resolved.length) return null
    return {
      from: word.from,
      options: columnOptions(resolved, model.kind).map((o) => ({ label: o.label, apply: o.apply, detail: o.detail, type: 'property', boost: 10 })),
      validFor: /^[\w$#@]*$/
    }
  }
}
