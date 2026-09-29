import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { disconnectAll, rollbackAll } from './db'
import { getTheme } from './store'
// Copied next to the built main process; the packaged exe gets build/icon.ico from electron-builder.
import icon from '../../resources/icon.png?asset'

/** Unsaved work the renderer has reported, listed when closing would lose it. */
let unsavedWork: string[] = []
ipcMain.on('app:unsaved', (_event, warnings: unknown) => {
  unsavedWork = Array.isArray(warnings) ? warnings.filter((w): w is string => typeof w === 'string') : []
})

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Matches --bg so the window doesn't flash the wrong colour before the page paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171c' : '#ffffff',
    title: 'JDB',
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => window.show())
  // The page blocks unloading while it has unsaved work; ask whether to close (or reload) anyway.
  window.webContents.on('will-prevent-unload', (event) => {
    const list = unsavedWork.length ? unsavedWork.map((w) => `• ${w}`).join('\n') : 'Some tabs have unsaved changes.'
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: 'Unsaved work',
      message: 'Close JDB and lose unsaved work?',
      detail: `${list}\n\nOpen transactions are rolled back, so nothing they changed is kept.`,
      buttons: ['Close anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    // preventDefault here overrides the page's veto, letting the close go ahead.
    if (choice === 0) event.preventDefault()
  })
  // A reloaded page has forgotten its staged transactions, so none can be committed any more.
  window.webContents.on('did-start-loading', () => {
    rollbackAll()
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Matches the appId the installer gives its shortcuts, so the window groups with the pinned taskbar
// button (and uses its icon). Dev runs keep Electron's own id so they don't join the installed app.
if (app.isPackaged) app.setAppUserModelId('com.activategroup.jdb')

app.whenReady().then(() => {
  nativeTheme.themeSource = getTheme()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  disconnectAll().finally(() => {
    if (process.platform !== 'darwin') app.quit()
  })
})
