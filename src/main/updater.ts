import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

/** How often a running app looks for a new release, after the check at startup. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** The version downloaded and waiting to install, if any. */
let ready: string | null = null

/**
 * Checks GitHub Releases (the `publish` settings in electron-builder.yml) and downloads new versions
 * in the background. A downloaded update installs when the app quits, or straight away if the user
 * picks "Restart" in the renderer. Dev runs skip it: there is no installed app to replace.
 */
export function startUpdater(): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => {
    ready = info.version
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('update:ready', info.version)
  })
  // Offline, GitHub down or no release yet: try again at the next check rather than bother anyone.
  autoUpdater.on('error', (error) => console.warn('Update check failed:', error.message))
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
 * Quits and runs the downloaded installer. Closing goes through the usual unsaved-work prompt;
 * if the user cancels there, the update still installs on the next quit.
 */
export function installUpdate(): void {
  if (ready) autoUpdater.quitAndInstall()
}
