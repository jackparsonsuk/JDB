// Draws the app icon, the letters JDB in green on a transparent background, at every size Windows
// uses, and writes build/icon.ico (installer and exe) and resources/icon.png (window icon).
// Run with `npm run icon`. Each size is drawn separately so small ones stay crisp.
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const GREEN = '#3fb950'
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const PNG_SIZE = 512
const root = join(__dirname, '..')

/** Runs in the hidden page: draws JDB to fill a size x size canvas and returns it as a PNG data URL. */
function draw(size, green) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  const text = 'JDB'
  // Tiny icons get a little less padding so the letters stay legible.
  const pad = size <= 24 ? 0 : size * 0.04
  ctx.font = `900 100px "Segoe UI Black", "Segoe UI", Arial, sans-serif`
  const wide = ctx.measureText(text)
  const scale = Math.min((size - pad * 2) / wide.width, (size * 0.9) / (wide.actualBoundingBoxAscent + wide.actualBoundingBoxDescent))
  ctx.font = `900 ${100 * scale}px "Segoe UI Black", "Segoe UI", Arial, sans-serif`
  const m = ctx.measureText(text)
  const x = (size - m.width) / 2
  const y = (size + m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2
  ctx.fillStyle = green
  ctx.fillText(text, x, y)
  return canvas.toDataURL('image/png')
}

/** An .ico holding PNG images, which Windows Vista and later read at every size. */
function ico(pngs) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(pngs.length, 4)
  const entries = []
  let offset = 6 + 16 * pngs.length
  for (const { size, data } of pngs) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(data.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += data.length
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)])
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false })
  await window.loadURL('data:text/html,<!doctype html><html><body></body></html>')
  // Make sure the font is ready before measuring.
  await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)')
  const render = async (size) => {
    const url = await window.webContents.executeJavaScript(`(${draw.toString()})(${size}, ${JSON.stringify(GREEN)})`)
    return Buffer.from(url.split(',')[1], 'base64')
  }
  const pngs = []
  for (const size of SIZES) pngs.push({ size, data: await render(size) })
  mkdirSync(join(root, 'build'), { recursive: true })
  mkdirSync(join(root, 'resources'), { recursive: true })
  writeFileSync(join(root, 'build', 'icon.ico'), ico(pngs))
  writeFileSync(join(root, 'resources', 'icon.png'), await render(PNG_SIZE))
  console.log(`Wrote build/icon.ico (${SIZES.join(', ')} px) and resources/icon.png (${PNG_SIZE} px)`)
  app.quit()
})
