import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateCheck } from '@shared/types'

/** How often a running app looks for a new release, after the check at startup. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** The version downloaded and waiting to install, if any. */
let ready: string | null = null
/** The version being downloaded, if any. */
let downloading: string | null = null

/**
 * Checks GitHub Releases (the `publish` settings in electron-builder.yml) and downloads new versions
 * in the background. A downloaded update installs when the app quits, or straight away if the user
 * picks "Restart" in the renderer. Dev runs skip it: there is no installed app to replace.
 */
export function startUpdater(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-available', (info) => {
    downloading = info.version
  })
  autoUpdater.on('update-downloaded', (info) => {
    downloading = null
    ready = info.version
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('update:ready', info.version)
  })
  // Offline, GitHub down or no release yet: try again at the next check rather than bother anyone.
  autoUpdater.on('error', (error) => {
    downloading = null
    console.warn('Update check failed:', error.message)
  })
  const check = (): void => {
    autoUpdater.checkForUpdates().catch(() => undefined)
  }
  check()
  setInterval(check, CHECK_INTERVAL_MS)
}

export function readyUpdate(): string | null {
  return ready
}

/**
 * Checks for a release now, for the command palette. A newer one starts downloading as usual, and
 * the renderer hears when it's ready through the same event as a background check.
 */
export async function checkNow(): Promise<UpdateCheck> {
  if (!app.isPackaged) return { state: 'dev' }
  if (ready) return { state: 'ready', version: ready }
  if (downloading) return { state: 'downloading', version: downloading }
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) return { state: 'dev' }
    if (result.isUpdateAvailable) return { state: 'downloading', version: result.updateInfo.version }
    return { state: 'current', version: app.getVersion() }
  } catch (error) {
    return { state: 'error', error: (error as Error)?.message ?? String(error) }
  }
}

/**
 * Quits and runs the downloaded installer. Closing goes through the usual unsaved-work prompt;
 * if the user cancels there, the update still installs on the next quit.
 */
export function installUpdate(): void {
  // Silent, and reopen afterwards: the installer isn't one-click, so it would otherwise show its wizard.
  if (ready) autoUpdater.quitAndInstall(true, true)
}
