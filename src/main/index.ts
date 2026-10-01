import { app, BrowserWindow, nativeTheme } from 'electron'
import { nativeThemeOf } from '@shared/types'
import { registerIpc } from './ipc'
import { disconnectAll } from './db'
import { getTheme } from './store'
import { startUpdater } from './updater'
import { closingAllWindows, openWindow, restoreWindows } from './windows'

// Matches the appId the installer gives its shortcuts, so the window groups with the pinned taskbar
// button (and uses its icon). Dev runs keep Electron's own id so they don't join the installed app.
if (app.isPackaged) app.setAppUserModelId('com.jackparsonsuk.jdb')

app.whenReady().then(() => {
  nativeTheme.themeSource = nativeThemeOf(getTheme())
  registerIpc()
  restoreWindows()
  startUpdater()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow()
  })
})

// Quitting (or installing an update) closes every window: keep them all for next time.
app.on('before-quit', closingAllWindows)

app.on('window-all-closed', () => {
  closingAllWindows()
  disconnectAll().finally(() => {
    if (process.platform !== 'darwin') app.quit()
  })
})
