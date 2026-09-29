// Publishes the draft GitHub release electron-builder just uploaded, once it has every file an
// installed app needs to update. Run by `npm run release` after `electron-builder --publish always`.
// Drafts keep a half-uploaded release out of sight (installed apps check the latest published one)
// and avoid GitHub refusing a published release whose tag doesn't exist yet.
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

const releases = await github('/releases?per_page=30')
const release = releases.find((r) => r.tag_name === tag)
if (!release) throw new Error(`No release ${tag} on ${owner}/${repo}.`)
if (!release.draft) {
  console.log(`${tag} is already published.`)
} else {
  const uploaded = new Set(release.assets.filter((a) => a.state === 'uploaded').map((a) => a.name))
  const missing = needed.filter((name) => !uploaded.has(name))
  if (missing.length) throw new Error(`Draft ${tag} is missing ${missing.join(', ')}; left as a draft.`)
  const published = await github(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, make_latest: 'true' }) })
  console.log(`Published ${tag}: ${published.html_url}`)
}
