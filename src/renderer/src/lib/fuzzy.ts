/**
 * Subsequence match scoring: every query character must appear in order.
 * Consecutive runs and matches at word starts score higher. Returns -1 for no match.
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const direct = t.indexOf(q)
  if (direct !== -1) return 1000 - direct - (t.length - q.length) * 0.1

  let score = 0
  let ti = 0
  let run = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found === -1) return -1
    run = found === ti ? run + 1 : 0
    const wordStart = found === 0 || /[._\s-]/.test(t[found - 1]) || (text[found] >= 'A' && text[found] <= 'Z')
    score += 1 + run * 2 + (wordStart ? 3 : 0)
    ti = found + 1
  }
  return score - t.length * 0.05
}
