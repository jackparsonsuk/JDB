/** Interface fonts worth offering, in order; only installed ones are shown. */
export const UI_FONTS = ['Segoe UI Variable', 'Segoe UI', 'Aptos', 'Inter', 'Calibri', 'Verdana', 'Tahoma', 'Arial']

/** Monospaced fonts for the editor and grid; ligature fonts are marked. */
export const CODE_FONTS: { name: string; ligatures?: boolean }[] = [
  { name: 'Cascadia Mono' },
  { name: 'Cascadia Code', ligatures: true },
  { name: 'Consolas' },
  { name: 'JetBrains Mono', ligatures: true },
  { name: 'Fira Code', ligatures: true },
  { name: 'Source Code Pro' },
  { name: 'IBM Plex Mono' },
  { name: 'Courier New' }
]

const SAMPLE = 'mmmmmmmmmwwwwwwwlllllli10O@#'
let canvas: CanvasRenderingContext2D | null = null

/**
 * Whether a font is installed. Electron can't list system fonts, so this measures sample text in
 * the font against each generic fallback: if every width matches a fallback, the font isn't there.
 */
export function isInstalled(name: string): boolean {
  canvas ??= document.createElement('canvas').getContext('2d')
  if (!canvas) return true
  const width = (family: string): number => {
    canvas!.font = `72px ${family}`
    return canvas!.measureText(SAMPLE).width
  }
  return ['monospace', 'sans-serif', 'serif'].some((fallback) => width(`"${name}", ${fallback}`) !== width(fallback))
}
