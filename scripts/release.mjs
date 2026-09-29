// The GitHub side of `npm run release`, around `electron-builder --publish always`:
//   node scripts/release.mjs prepare   creates the draft release for this version
//   node scripts/release.mjs publish   publishes it once it has every file an update needs
// electron-builder alone can race itself into two drafts for one version, splitting the files
// between them, or fail to publish on a tag GitHub hasn't created yet. Creating the draft first
// gives it one release to upload into, and a draft keeps a half-uploaded release away from
// installed apps, which only look at the latest published one.
import { readFileSync } from 'node:fs'

const token = process.env.GH_TOKEN
if (!token) throw new Error('GH_TOKEN is not set.')

const config = readFileSync('electron-builder.yml', 'utf8')
const owner = /^\s+owner:\s*(\S+)/m.exec(config)?.[1]
const repo = /^\s+repo:\s*(\S+)/m.exec(config)?.[1]
if (!owner || !repo) throw new Error('No publish owner/repo in electron-builder.yml.')

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const tag = `v${version}`
const needed = ['latest.yml', `JDB-Setup-${version}.exe`, `JDB-Setup-${version}.exe.blockmap`]

async function github(path, init = {}) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }
  })
  if (!response.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
  return response.json()
}

/** Releases for this version; drafts have no tag yet, so they're matched on tag_name. */
async function releasesForTag() {
  const releases = await github('/releases?per_page=50')
  return releases.filter((r) => r.tag_name === tag)
}

const command = process.argv[2]
const existing = await releasesForTag()

if (command === 'prepare') {
  if (existing.some((r) => !r.draft)) throw new Error(`${tag} is already published; bump the version in package.json.`)
  if (existing.length > 1) throw new Error(`There are ${existing.length} drafts for ${tag}; delete the extras on GitHub first.`)
  if (existing.length) {
    console.log(`Using the existing draft for ${tag}.`)
  } else {
    await github('/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, name: version, draft: true }) })
    console.log(`Created a draft for ${tag}.`)
  }
} else if (command === 'publish') {
  const drafts = existing.filter((r) => r.draft)
  if (drafts.length !== 1) throw new Error(`Expected one draft for ${tag}, found ${drafts.length}; left unpublished.`)
  const [draft] = drafts
  const uploaded = new Set(draft.assets.filter((a) => a.state === 'uploaded').map((a) => a.name))
  const missing = needed.filter((name) => !uploaded.has(name))
  if (missing.length) throw new Error(`Draft ${tag} is missing ${missing.join(', ')}; left unpublished.`)
  const published = await github(`/releases/${draft.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: 'true' }) })
  console.log(`Published ${tag}: ${published.html_url}`)
} else {
  throw new Error('Usage: node scripts/release.mjs prepare|publish')
}
