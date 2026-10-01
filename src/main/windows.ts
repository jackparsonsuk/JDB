import { BrowserWindow, dialog, nativeTheme, screen, shell, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { APP_NAME } from '@shared/brand'
import { rollbackOwnedBy } from './db'
import { getAppearance, loadWindowSessions, saveWindowSessions, type WindowBounds } from './store'
// Copied next to the built main process; the packaged exe gets build/icon.ico from electron-builder.
import icon from '../../resources/icon.png?asset'

/**
 * OverlookDB's windows. Each is a whole app (sidebar, tabs, split) sharing this process's
 * connections, so a second window never signs in again. Each window keeps its own tabs in the
 * session, its own unsaved-work warnings and its own staged transactions.
 */

interface Entry {
  /** Names the window's place in the saved session, across launches. */
  key: string
  window: BrowserWindow
  /** What closing this window would lose, as its page reported it. */
  unsaved: string[]
  /** Query results handed over with a moved tab, taken once by the new window. */
  carried?: unknown
}

/** Open windows by their webContents id, which IPC events carry as the sender. */
const entries = new Map<number, Entry>()

/** Every window's last saved tabs and bounds, by key, in the order the windows opened. */
const sessions = new Map<string, { bounds?: WindowBounds; session: unknown }>()

/**
 * Closing one window of several forgets its tabs, like a browser; closing them all (quitting, or
 * the deploy script closing every window at once) keeps them. Windows close one by one even when
 * all are closing, so a closed window is only forgotten once the others have stayed open a moment.
 */
const FORGET_DELAY_MS = 2000
const forgetting = new Map<string, ReturnType<typeof setTimeout>>()
let closingAll = false

function persist(): void {
  try {
    saveWindowSessions([...sessions].map(([key, s]) => ({ key, ...s })))
  } catch {
    // Losing a session save only means the next launch opens an older layout.
  }
}

/** Opens the windows from the last session (one window when there were none, or Settings starts afresh). */
export function restoreWindows(): void {
  const saved = getAppearance().freshStart ? [] : loadWindowSessions()
  if (!saved.length) {
    openWindow()
    return
  }
  for (const s of saved) sessions.set(s.key, { bounds: s.bounds, session: s.session })
  for (const s of saved) openWindow({ key: s.key, bounds: s.bounds })
}

/** Bounds that still land on a screen (a monitor may have gone since), or undefined for the default. */
function onScreen(bounds: WindowBounds | undefined): WindowBounds | undefined {
  if (!bounds) return undefined
  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    bounds.x < a.x + a.width - 100 && bounds.x + bounds.width > a.x + 100 && bounds.y >= a.y - 20 && bounds.y < a.y + a.height - 100)
  return visible ? bounds : undefined
}

export interface OpenWindowOptions {
  key?: string
  bounds?: WindowBounds
  /** The tabs it opens with (a SavedSession), instead of an empty window. */
  session?: unknown
  carried?: unknown
}

export function openWindow(options: OpenWindowOptions = {}): BrowserWindow {
  const key = options.key ?? randomUUID()
  if (options.session !== undefined) sessions.set(key, { ...sessions.get(key), session: options.session })
  const bounds = onScreen(options.bounds)
  // A new window opens a little down and right of the one it came from, so it's seen to appear.
  const from = BrowserWindow.getFocusedWindow()
  const cascade = !bounds && from ? from.getNormalBounds() : undefined

  const window = new BrowserWindow({
    width: bounds?.width ?? cascade?.width ?? 1400,
    height: bounds?.height ?? cascade?.height ?? 900,
    ...(bounds ? { x: bounds.x, y: bounds.y } : cascade ? { x: cascade.x + 32, y: cascade.y + 32 } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Matches --bg so the window doesn't flash the wrong colour before the page paints.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171c' : '#ffffff',
    title: APP_NAME,
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const id = window.webContents.id
  entries.set(id, { key, window, unsaved: [], carried: options.carried })

  window.once('ready-to-show', () => {
    if (bounds?.maximized) window.maximize()
    window.show()
  })

  // The page blocks unloading while it has unsaved work; ask whether to close (or reload) anyway.
  window.webContents.on('will-prevent-unload', (event) => {
    const unsaved = entries.get(id)?.unsaved ?? []
    const list = unsaved.length ? unsaved.map((w) => `• ${w}`).join('\n') : 'Some tabs have unsaved changes.'
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      title: 'Unsaved work',
      message: entries.size > 1 ? 'Close this window and lose unsaved work?' : `Close ${APP_NAME} and lose unsaved work?`,
      detail: `${list}\n\nOpen transactions are rolled back, so nothing they changed is kept.`,
      buttons: ['Close anyway', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    // preventDefault here overrides the page's veto, letting the close go ahead.
    if (choice === 0) event.preventDefault()
  })
  // A reloaded page has forgotten its staged transactions, so none of them can be committed any more.
  window.webContents.on('did-start-loading', () => {
    rollbackOwnedBy(id)
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  let boundsTimer: ReturnType<typeof setTimeout> | undefined
  const saveBounds = (): void => {
    clearTimeout(boundsTimer)
    if (window.isDestroyed() || window.isMinimized()) return
    sessions.set(key, { ...(sessions.get(key) ?? { session: null }), bounds: { ...window.getNormalBounds(), maximized: window.isMaximized() } })
    persist()
  }
  const soon = (): void => {
    clearTimeout(boundsTimer)
    boundsTimer = setTimeout(saveBounds, 500)
  }
  for (const e of ['move', 'resize', 'maximize', 'unmaximize'] as const) window.on(e as 'move', soon)
  window.on('close', saveBounds)

  window.on('closed', () => {
    entries.delete(id)
    rollbackOwnedBy(id)
    if (closingAll || !entries.size) return
    forgetting.set(key, setTimeout(() => {
      forgetting.delete(key)
      sessions.delete(key)
      persist()
    }, FORGET_DELAY_MS))
  })

  if (process.env['ELECTRON_RENDERER_URL']) window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else window.loadFile(join(__dirname, '../renderer/index.html'))
  return window
}

/** Every window is closing (quit, update, or the last one closed): keep them all in the session. */
export function closingAllWindows(): void {
  closingAll = true
  for (const timer of forgetting.values()) clearTimeout(timer)
  forgetting.clear()
  persist()
}

/** The session a window should open with: its own from the last launch, or what it was opened with. */
export function sessionFor(sender: WebContents): unknown {
  const entry = entries.get(sender.id)
  return entry ? sessions.get(entry.key)?.session ?? null : null
}

export function saveSessionFrom(sender: WebContents, session: unknown): void {
  const entry = entries.get(sender.id)
  if (!entry) return
  sessions.set(entry.key, { ...sessions.get(entry.key), session })
  persist()
}

/** Query results a moved tab brought, handed over once. */
export function takeCarried(sender: WebContents): unknown {
  const entry = entries.get(sender.id)
  const carried = entry?.carried ?? null
  if (entry) entry.carried = undefined
  return carried
}

export function setUnsaved(sender: WebContents, warnings: string[]): void {
  const entry = entries.get(sender.id)
  if (entry) entry.unsaved = warnings
}

/** Tells the other windows that something they show changed, so they read it again. */
export function notifyOthers(sender: WebContents, topics: string[]): void {
  for (const [id, entry] of entries) {
    if (id !== sender.id && !entry.window.isDestroyed()) entry.window.webContents.send('store:changed', topics)
  }
}
