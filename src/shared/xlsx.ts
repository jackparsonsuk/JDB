import type { CellValue } from './types'

/** One file inside the .xlsx zip. */
export interface XlsxPart {
  path: string
  content: string
}

const MAX_CELL_TEXT = 32767
const EXCEL_EPOCH_DAYS = 25569
/** ISO timestamps (SQL Server, via toCell) and MySQL's "YYYY-MM-DD hh:mm:ss.ffffff" or bare dates. */
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z?)?$/
/** Numeric text Excel can hold exactly: no leading zeros (codes like "007" stay text) and at most 15 digits. */
const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

/** Style indexes in styles.xml: header, date, date and time. */
const HEADER = 1
const DATE = 2
const DATETIME = 3

function escapeXml(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function columnLetter(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/** Excel sheet names: at most 31 characters, none of []:*?/\ and not blank. */
export function sheetName(name: string): string {
  const clean = name.replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim().slice(0, 31)
  return clean || 'Sheet1'
}

function textCell(ref: string, text: string, style?: number): string {
  const s = style ? ` s="${style}"` : ''
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : ''
  return `<c r="${ref}" t="inlineStr"${s}><is><t${space}>${escapeXml(text.slice(0, MAX_CELL_TEXT))}</t></is></c>`
}

/** A cell as Excel should see it: numbers and dates as values (dates shown as the grid shows them), the rest as text. */
function cell(ref: string, value: CellValue): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`
  if (typeof value === 'number') return Number.isFinite(value) ? `<c r="${ref}"><v>${value}</v></c>` : textCell(ref, String(value))
  const date = DATE_TEXT.exec(value)
  if (date) {
    const [, y, mo, d, h = '00', mi = '00', s = '00', frac] = date
    if (Number(y) >= 1900) {
      const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number(`0.${frac ?? 0}`) * 1000)
      const serial = ms / 86400000 + EXCEL_EPOCH_DAYS
      const style = h === '00' && mi === '00' && s === '00' && !Number(frac ?? 0) ? DATE : DATETIME
      return `<c r="${ref}" s="${style}"><v>${serial}</v></c>`
    }
  }
  if (NUMERIC.test(value) && value.replace(/[-.]/g, '').length <= 15) return `<c r="${ref}"><v>${value}</v></c>`
  return textCell(ref, value)
}

function columnWidths(columns: string[], rows: CellValue[][]): number[] {
  return columns.map((c, i) => {
    let longest = c.length
    for (const row of rows.slice(0, 200)) {
      const v = row[i]
      const len = v === null ? 0 : typeof v === 'string' && DATE_TEXT.test(v) ? 19 : String(v).length
      if (len > longest) longest = len
    }
    return Math.min(60, Math.max(6, longest + 2))
  })
}

/** The XML parts of a one-sheet workbook with a bold, frozen, filterable header row. */
export function xlsxParts(name: string, columns: string[], rows: CellValue[][]): XlsxPart[] {
  const sheet = sheetName(name)
  const last = `${columnLetter(Math.max(0, columns.length - 1))}${rows.length + 1}`
  const cols = columnWidths(columns, rows).map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')
  const header = `<row r="1">${columns.map((c, i) => textCell(`${columnLetter(i)}1`, c, HEADER)).join('')}</row>`
  const letters = columns.map((_, i) => columnLetter(i))
  const body = rows.map((row, r) => `<row r="${r + 2}">${row.map((v, i) => cell(`${letters[i]}${r + 2}`, v)).join('')}</row>`).join('')
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  const quotedSheet = `'${sheet.replace(/'/g, "''")}'`
  const filterRef = `$A$1:$${columnLetter(Math.max(0, columns.length - 1))}$${rows.length + 1}`

  return [
    {
      path: '[Content_Types].xml',
      content: `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + '</Types>'
    },
    {
      path: '_rels/.rels',
      content: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      path: 'xl/workbook.xml',
      content: `${head}<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="${escapeXml(sheet)}" sheetId="1" r:id="rId1"/></sheets>`
        + `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${escapeXml(quotedSheet)}!${filterRef}</definedName></definedNames>`
        + '</workbook>'
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      content: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
        + `<Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/>`
        + `<Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`
    },
    {
      path: 'xl/styles.xml',
      content: `${head}<styleSheet xmlns="${ns}">`
        + '<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts>'
        + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
        + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        + '</styleSheet>'
    },
    {
      path: 'xl/worksheets/sheet1.xml',
      content: `${head}<worksheet xmlns="${ns}">`
        + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
        + `${cols ? `<cols>${cols}</cols>` : ''}<sheetData>${header}${body}</sheetData>`
        + (columns.length ? `<autoFilter ref="A1:${last}"/>` : '')
        + '</worksheet>'
    }
  ]
}
