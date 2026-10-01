/** Where words start in a name: the beginning, after _ . - or a space, a capital after a lower-case letter, and a digit after a letter. */
function wordStarts(text: string): boolean[] {
  return [...text].map((ch, i) => {
    if (i === 0) return true
    const prev = text[i - 1]
    if (/[._\s-]/.test(prev)) return true
    if (/[A-Z]/.test(ch) && /[a-z]/.test(prev)) return true
    return /\d/.test(ch) && /[A-Za-z]/.test(prev)
  })
}

/**
 * Scores `text` for a filter typed as `query`; -1 for no match. A substring matches anywhere.
 * Otherwise the letters must appear in order, and each jump must land on the start of a word,
 * so "proem" finds ProcessedEmails and "qie" queue_invoice_export, but "next" doesn't find
 * queue_invoice_export by picking letters out of the middle of words.
 */
export function wordScore(query: string, text: string): number {
  const q = query.toLowerCase().replace(/\s+/g, '')
  if (!q) return 0
  const t = text.toLowerCase()
  const direct = t.indexOf(q)
  if (direct !== -1) return 1000 - direct - (t.length - q.length) * 0.1

  const starts = wordStarts(text)
  const NONE = -Infinity
  // best[j]: the best score with the current query letter matched at j.
  let best: number[] = []
  for (let j = 0; j < t.length; j++) best.push(t[j] === q[0] && starts[j] ? 4 : NONE)
  for (let i = 1; i < q.length; i++) {
    const next: number[] = new Array(t.length).fill(NONE)
    let before = NONE
    for (let j = 0; j < t.length; j++) {
      if (t[j] === q[i]) {
        // Carrying on a run of letters, or jumping to a word start after an earlier match.
        const run = j > 0 && best[j - 1] > NONE ? best[j - 1] + 3 : NONE
        const jump = starts[j] && before > NONE ? before + 4 : NONE
        next[j] = Math.max(run, jump)
      }
      before = Math.max(before, best[j])
    }
    best = next
  }
  const score = Math.max(...best)
  return score === NONE ? -1 : score - t.length * 0.05
}
