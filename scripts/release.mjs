// The GitHub side of `npm run release`, around `electron-builder --publish always`:
//   node scripts/release.mjs prepare   creates the draft release for this version
//   node scripts/release.mjs publish   publishes it once it has every file an update needs
// electron-builder alone can race itself into two drafts for one version, splitting the files
// between them, or fail to publish on a tag GitHub hasn't created yet. Creating the draft first
// gives it one release to upload into, and a draft keeps a half-uploaded release away from
// installed apps, which only look at the latest published one.
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${version}`
// The installer's file name comes from nsis.artifactName in electron-builder.yml.
const needed = ['latest.yml', `OverlookDB-Setup-${version}.exe`, `OverlookDB-Setup-${version}.exe.blockmap`]

/**
 * This version's section of CHANGELOG.md, as the release description. The app reads the same file
 * (src/shared/changelog.ts), so a release without notes would update people without telling them why.
 */
function releaseNotes() {
  const lines = readFileSync('CHANGELOG.md', 'utf8').split(/\r?\n/).map((l) => l.trim())
  const heading = (l) => l.startsWith('## ')
  const start = lines.findIndex((l) => heading(l) && [version, tag].includes(l.slice(3).trim()))
  if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section; add the release notes first.`)
  const end = lines.findIndex((l, i) => i > start && heading(l))
  const notes = lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()
  if (!notes) throw new Error(`The "## ${version}" section of CHANGELOG.md is empty.`)
  return notes
}
// Checked before anything else, so a release without notes stops before the build.
const notes = releaseNotes()

const token = process.env.GH_TOKEN
if (!token) throw new Error('GH_TOKEN is not set.')

/**
 * Every repo in electron-builder.yml's `publish`, in order. The first is where installed apps look
 * for updates; any others get the same release (1.7.0 is also published to jdb-releases, where
 * apps installed before it still look).
 */
function publishRepos() {
  const config = readFileSync('electron-builder.yml', 'utf8')
  const section = config.slice(config.search(/^publish:/m))
  const repos = [...section.matchAll(/owner:\s*(\S+)\s*\n\s*repo:\s*(\S+)/g)].map((m) => ({ owner: m[1], repo: m[2] }))
  if (!repos.length) throw new Error('No publish owner/repo in electron-builder.yml.')
  return repos
}

async function github({ owner, repo }, path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }
  })
  if (!response.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${owner}/${repo}${path}: ${response.status} ${await response.text()}`)
  return response.json()
}

/** Releases for this version; drafts have no tag yet, so they're matched on tag_name. */
async function releasesForTag(target) {
  const releases = await github(target, '/releases?per_page=50')
  return releases.filter((r) => r.tag_name === tag)
}

const command = process.argv[2]
const repos = publishRepos()
const name = (r) => `${r.owner}/${r.repo}`

if (command === 'prepare') {
  // Checks every repo before creating anything, so a problem in one leaves no stray drafts.
  const found = await Promise.all(repos.map(releasesForTag))
  found.forEach((existing, i) => {
    if (existing.some((r) => !r.draft)) throw new Error(`${tag} is already published in ${name(repos[i])}; bump the version in package.json.`)
    if (existing.length > 1) throw new Error(`There are ${existing.length} drafts for ${tag} in ${name(repos[i])}; delete the extras on GitHub first.`)
  })
  for (const [i, target] of repos.entries()) {
    if (found[i].length) {
      console.log(`Using the existing draft for ${tag} in ${name(target)}.`)
    } else {
      await github(target, '/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, name: version, body: notes, draft: true }) })
      console.log(`Created a draft for ${tag} in ${name(target)}.`)
    }
  }
} else if (command === 'publish') {
  // Every draft must be complete before any is published, and they're published in order (the
  // update repo first), so an app pointed at the first repo never finds an unpublished release.
  const drafts = []
  for (const target of repos) {
    const existing = (await releasesForTag(target)).filter((r) => r.draft)
    if (existing.length !== 1) throw new Error(`Expected one draft for ${tag} in ${name(target)}, found ${existing.length}; left unpublished.`)
    const uploaded = new Set(existing[0].assets.filter((a) => a.state === 'uploaded').map((a) => a.name))
    const missing = needed.filter((file) => !uploaded.has(file))
    if (missing.length) throw new Error(`Draft ${tag} in ${name(target)} is missing ${missing.join(', ')}; left unpublished.`)
    drafts.push({ target, draft: existing[0] })
  }
  for (const { target, draft } of drafts) {
    // Notes edited after the draft was made (a re-run, say) still reach the release.
    const published = await github(target, `/releases/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: 'true', body: notes }) })
    console.log(`Published ${tag} in ${name(target)}: ${published.html_url}`)
  }
} else {
  throw new Error('Usage: node scripts/release.mjs prepare|publish')
}
