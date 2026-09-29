/** One version's section of CHANGELOG.md. */
export interface ChangelogEntry {
  version: string
  notes: string[]
}

const HEADING = /^##\s+v?(\d+\.\d+\.\d+)\s*$/
const BULLET = /^[-*]\s+(.*)$/

/**
 * Reads CHANGELOG.md: a `## 1.2.3` heading per version, newest first, each followed by `- ` bullets.
 * An indented line continues the bullet above it; anything before the first heading is ignored.
 */
export function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const heading = HEADING.exec(line)
    if (heading) {
      entries.push({ version: heading[1], notes: [] })
      continue
    }
    const entry = entries[entries.length - 1]
    if (!entry || !line) continue
    const bullet = BULLET.exec(line)
    if (bullet) entry.notes.push(bullet[1])
    else if (entry.notes.length) entry.notes[entry.notes.length - 1] += ` ${line}`
    else entry.notes.push(line)
  }
  return entries
}

/** Compares dotted versions numerically: negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

/** The entries newer than `from` up to and including `to`, newest first: what an update brought. */
export function changesSince(entries: ChangelogEntry[], from: string, to: string): ChangelogEntry[] {
  return entries
    .filter((e) => compareVersions(e.version, from) > 0 && compareVersions(e.version, to) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
}
