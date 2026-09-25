import type { CSSProperties } from 'react'
import type { Plan, PlanColumn, PlanSuggestion, PlanTable } from '@shared/nl/plan'

const NODE_W = 260
const HEAD_H = 34
const ROW_H = 21
const PAD_B = 6
const GAP = 16
const COL_GAP = 110
const SUGGESTION_H = 30
const X = { parent: 0, main: NODE_W + COL_GAP, child: 2 * (NODE_W + COL_GAP) }
const WIDTH = 3 * NODE_W + 2 * COL_GAP

interface Box {
  id: string
  x: number
  y: number
  h: number
  table?: PlanTable
  suggestion?: PlanSuggestion
}

const tableHeight = (t: PlanTable): number => HEAD_H + t.columns.length * ROW_H + PAD_B

/** Stacks a column of boxes, vertically centred against the tallest column. */
function stack(items: { id: string; h: number; table?: PlanTable; suggestion?: PlanSuggestion }[], x: number, total: number): Box[] {
  const used = items.reduce((sum, b) => sum + b.h, 0) + Math.max(0, items.length - 1) * GAP
  let y = (total - used) / 2
  return items.map((item) => {
    const box = { ...item, x, y }
    y += item.h + GAP
    return box
  })
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Y of a column's row inside a box, falling back to the header when the column isn't listed. */
function rowY(box: Box, column: string): number {
  const i = box.table?.columns.findIndex((c) => c.name === column) ?? -1
  return box.y + (i < 0 ? HEAD_H / 2 : HEAD_H + i * ROW_H + ROW_H / 2)
}

function curve(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(40, Math.abs(x2 - x1) / 2)
  const dir = x2 >= x1 ? 1 : -1
  return `M ${x1} ${y1} C ${x1 + dx * dir} ${y1}, ${x2 - dx * dir} ${y2}, ${x2} ${y2}`
}

/** `d` as a CSS property animates in Chromium, so links glide when the layout changes. */
const pathStyle = (d: string): CSSProperties => ({ d: `path('${d}')` } as CSSProperties)

export function QueryDiagram({ plan, onSuggest }: { plan: Plan; onSuggest(phrase: string): void }) {
  const parentItems = [
    ...plan.parents.map((t) => ({ id: t.id, h: tableHeight(t), table: t })),
    ...plan.suggestions.filter((s) => s.side === 'parent').map((s) => ({ id: s.id, h: SUGGESTION_H, suggestion: s }))
  ]
  const childItems = [
    ...plan.children.map((t) => ({ id: t.id, h: tableHeight(t), table: t })),
    ...plan.suggestions.filter((s) => s.side === 'child').map((s) => ({ id: s.id, h: SUGGESTION_H, suggestion: s }))
  ]
  const columnHeight = (items: { h: number }[]): number => items.reduce((s, b) => s + b.h, 0) + Math.max(0, items.length - 1) * GAP
  const height = Math.max(tableHeight(plan.main), columnHeight(parentItems), columnHeight(childItems)) + 8

  const boxes = [
    ...stack(parentItems, X.parent, height),
    ...stack([{ id: plan.main.id, h: tableHeight(plan.main), table: plan.main }], X.main, height),
    ...stack(childItems, X.child, height)
  ]
  const byId = new Map(boxes.map((b) => [b.id, b]))
  const main = byId.get(plan.main.id)!

  return (
    <svg className="diagram" viewBox={`-4 -4 ${WIDTH + 8} ${height + 8}`} preserveAspectRatio="xMidYMin meet">
      <defs>
        <marker id="dg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" className="dg-arrowhead" />
        </marker>
      </defs>

      {/* Suggestion links first so they sit underneath. */}
      {boxes.filter((b) => b.suggestion).map((b) => {
        const parentSide = b.suggestion!.side === 'parent'
        const d = parentSide
          ? curve(main.x, main.y + HEAD_H / 2, b.x + NODE_W, b.y + b.h / 2)
          : curve(b.x, b.y + b.h / 2, main.x + NODE_W, main.y + HEAD_H / 2)
        return <path key={`s-${b.id}`} className="dg-link suggestion" d={d} style={pathStyle(d)} />
      })}

      {plan.links.map((link) => {
        const from = byId.get(link.from)
        const to = byId.get(link.to)
        if (!from || !to) return null
        // Links always run from the FK holder's left edge to the referenced table's right edge:
        // main -> lookup on the left for joins, child -> main on the right for EXISTS.
        const d = curve(from.x, rowY(from, link.fromColumn), to.x + NODE_W, rowY(to, link.toColumn))
        const mid = { x: (from.x + to.x + NODE_W) / 2, y: (rowY(from, link.fromColumn) + rowY(to, link.toColumn)) / 2 }
        const label = link.kind === 'join' ? 'lookup' : link.kind === 'exists' ? 'has any' : 'has none'
        return (
          <g key={`${link.from}->${link.to}`}>
            <path className={`dg-link ${link.kind}`} d={d} style={pathStyle(d)} markerEnd="url(#dg-arrow)" />
            <g className="dg-move" style={{ transform: `translate(${mid.x}px, ${mid.y}px)` }}>
              <rect className={`dg-link-label ${link.kind}`} x={-30} y={-9} width={60} height={18} rx={9} />
              <text className="dg-link-text" textAnchor="middle" y={4}>{label}</text>
            </g>
          </g>
        )
      })}

      {boxes.map((b) => (
        <g key={b.id} className="dg-move dg-appear" style={{ transform: `translate(${b.x}px, ${b.y}px)` }}>
          {b.table ? (
            <TableNode table={b.table} role={b.id === plan.main.id ? 'main' : plan.children.includes(b.table) ? 'child' : 'parent'} />
          ) : (
            <SuggestionNode suggestion={b.suggestion!} onClick={() => onSuggest(b.suggestion!.phrase)} />
          )}
        </g>
      ))}
    </svg>
  )
}

function TableNode({ table, role }: { table: PlanTable; role: 'main' | 'parent' | 'child' }) {
  const h = tableHeight(table)
  return (
    <>
      <title>{`${table.remote ? `${table.remote} · ` : ''}${table.schema}.${table.name}${table.caption ? ` (${table.caption})` : ''}`}</title>
      <rect className={`dg-node ${role} ${table.remote ? 'remote' : ''}`} width={NODE_W} height={h} rx={8} />
      <rect className={`dg-head ${role} ${table.remote ? 'remote' : ''}`} width={NODE_W} height={HEAD_H} rx={8} />
      <rect className={`dg-head ${role} ${table.remote ? 'remote' : ''}`} y={HEAD_H - 8} width={NODE_W} height={8} />
      <text className="dg-title" x={12} y={table.caption ? 15 : 21}>{clip(table.name, 26)}</text>
      {table.caption && <text className="dg-caption" x={12} y={28}>{clip(table.caption, 34)}</text>}
      {table.columns.map((c, i) => <ColumnRow key={c.name} column={c} y={HEAD_H + i * ROW_H} />)}
    </>
  )
}

const KIND_GLYPH: Record<PlanColumn['kind'], string> = { key: '⚿', filter: '⏷', sort: '⇅', group: '▦', shown: '👁' }

function ColumnRow({ column, y }: { column: PlanColumn; y: number }) {
  return (
    <g transform={`translate(0 ${y})`}>
      <title>{`${column.name}${column.note ? `: ${column.note}` : ''}`}</title>
      <text className={`dg-glyph ${column.kind}`} x={12} y={15}>{KIND_GLYPH[column.kind]}</text>
      <text className={`dg-col ${column.kind}`} x={28} y={15}>{clip(column.name, column.note ? 18 : 32)}</text>
      {column.note && <text className={`dg-note ${column.kind}`} x={NODE_W - 10} y={15} textAnchor="end">{clip(column.note, 20)}</text>}
    </g>
  )
}

function SuggestionNode({ suggestion, onClick }: { suggestion: PlanSuggestion; onClick(): void }) {
  return (
    <g className="dg-suggestion" onClick={onClick} role="button">
      <title>{`Add "${suggestion.phrase}" (${suggestion.name})`}</title>
      <rect width={NODE_W} height={SUGGESTION_H} rx={15} />
      <text x={14} y={19}>＋ {clip(suggestion.phrase, 24)}</text>
      <text className="dg-phrase" x={NODE_W - 12} y={19} textAnchor="end">{clip(suggestion.name, 14)}</text>
    </g>
  )
}
