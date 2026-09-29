// Copies a fresh unpacked build (dist/win-unpacked) over the locally installed JDB, so a change can
// be tried in the installed app without running the installer. Run via `npm run deploy`.
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const source = join(process.cwd(), 'dist', 'win-unpacked')
const exe = 'JDB.exe'
const uninstaller = 'Uninstall JDB.exe'
/** Files the installer adds that an unpacked build doesn't have; app-update.yml tells the updater where releases are. */
const installerOnly = [uninstaller, 'elevate.exe', 'app-update.yml']

/** The install folder, from the uninstaller the NSIS installer registered, else its default. */
function installDir() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', uninstaller], { encoding: 'utf8' })
    const match = /UninstallString\s+REG_SZ\s+"([^"]+)"/.exec(out)
    if (match) return dirname(match[1])
  } catch {
    // Not registered; fall back to the default location.
  }
  return join(process.env.LOCALAPPDATA ?? '', 'Programs', 'JDB')
}

function isRunning() {
  const out = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/NH'], { encoding: 'utf8' }).stdout ?? ''
  return out.includes(exe)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const target = installDir()
if (!existsSync(join(source, exe))) throw new Error(`No build at ${source}; run electron-builder --dir first.`)
if (!existsSync(join(target, exe))) throw new Error(`JDB isn't installed at ${target}; run the installer once first.`)

if (isRunning()) {
  // Ask nicely first so the window gets to save its session, then force it.
  console.log('Closing JDB…')
  spawnSync('taskkill', ['/IM', exe], { stdio: 'ignore' })
  for (let i = 0; i < 20 && isRunning(); i++) await sleep(250)
  if (isRunning()) {
    // Usually it's asking about unsaved work (an open transaction or edits), which this discards.
    console.log('JDB did not close by itself (probably asking about unsaved work); forcing it closed.')
    spawnSync('taskkill', ['/IM', exe, '/T', '/F'], { stdio: 'ignore' })
  }
  for (let i = 0; i < 20 && isRunning(); i++) await sleep(250)
  // Windows can hold the exe open for a moment after the process has gone.
  await sleep(1000)
}

// /MIR removes files the new build no longer has, apart from the installer's own.
const copy = spawnSync('robocopy', [source, target, '/MIR', '/XF', ...installerOnly, '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:10', '/W:1'], { stdio: 'inherit' })
// Robocopy exit codes below 8 mean success.
if (copy.status === null || copy.status >= 8) throw new Error(`Copy failed (robocopy exit ${copy.status}).`)

console.log(`Updated JDB in ${target}`)
spawn(join(target, exe), { detached: true, stdio: 'ignore' }).unref()
