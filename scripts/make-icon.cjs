// Draws the app icon, the OverlookDB mark (an O with a horizon across it and a sun rising inside,
// on a green tile), at every size Windows uses, and writes build/icon.ico (installer and exe) and
// resources/icon.png (window icon). Run with `npm run icon`. Each size is drawn separately so small
// ones stay crisp. The in-app logo (src/renderer/src/components/Logo.tsx) uses the same shapes.
const { app, BrowserWindow } = require('electron')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const PNG_SIZE = 512
const root = join(__dirname, '..')

/** Runs in the hidden page: draws the mark on a size x size canvas and returns it as a PNG data URL. */
function draw(size) {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  // Shapes are laid out on a 100-unit square, like the SVG logo.
  ctx.scale(size / 100, size / 100)
  // Below ~20px the sun turns to mush, so small icons are the ring and horizon only, drawn bolder.
  const small = size < 20

  const tile = ctx.createLinearGradient(0, 0, 100, 100)
  tile.addColorStop(0, '#4cc764')
  tile.addColorStop(1, '#1f7a33')
  ctx.fillStyle = tile
  ctx.beginPath()
  ctx.roundRect(0, 0, 100, 100, 24)
  ctx.fill()

  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#fff'
  if (!small) {
    // The sun, half risen above the horizon: a half disc sitting on the line.
    ctx.beginPath()
    ctx.arc(50, 60, 14, Math.PI, 0)
    ctx.closePath()
    ctx.fill()
  }

  ctx.lineWidth = small ? 11 : 9
  ctx.beginPath()
  ctx.arc(50, 50, 28, 0, Math.PI * 2)
  ctx.stroke()

  ctx.lineWidth = small ? 10 : 7
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(12, 60)
  ctx.lineTo(88, 60)
  ctx.stroke()
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
  const render = async (size) => {
    const url = await window.webContents.executeJavaScript(`(${draw.toString()})(${size})`)
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
