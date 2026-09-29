import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { disconnectAll, rollbackAll } from './db'
import { getTheme } from './store'

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
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  window.once('ready-to-show', () => window.show())
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
