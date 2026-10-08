/**
 * ADEI-ONE — Runners de datos del "Convertidor universal".
 * Dominio: CSV ↔ JSON ↔ XLSX, JSON pretty/minify y XML → JSON.
 * Las librerías pesadas (xlsx, fast-xml-parser, fflate) se cargan con
 * `import()` dinámico dentro del runner que las usa.
 */
import {
  baseName,
  csvCell,
  decodeUtf8,
  decodeXmlEntities,
  fileResult,
  parseCsv,
  requireBytes,
  steps,
  textResult,
} from '../helpers'
import type { ProgressCb } from '../helpers'
import type { RunnerDef } from '../runner-types'
import type { EngineInput, ProcessResult } from '@/core/types'

/** MIME del formato XLSX que generamos. */
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

async function csvToJson(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  converting(55)
  const rows = parseCsv(decodeUtf8(input.bytes))
  const [header = [], ...body] = rows
  // Primera fila = claves → array de objetos (valores siempre string).
  const objects = body.map((cells) => {
    const record: Record<string, string> = {}
    header.forEach((key, i) => {
      record[key] = cells[i] ?? ''
    })
    return record
  })
  generating(90)
  done(100)
  const json = JSON.stringify(objects, null, 2)
  return textResult(`${baseName(input.name)}.json`, json, 'json', 'application/json')
}

/** ¿Es un objeto plano? (excluye null y arrays). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Unión de claves de todos los objetos (preserva el orden de aparición). */
function unionKeys(objects: Array<Record<string, unknown>>): string[] {
  const keys = new Set<string>()
  for (const obj of objects) for (const key of Object.keys(obj)) keys.add(key)
  return [...keys]
}

async function jsonToCsv(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  converting(55)
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(input.bytes))
  } catch {
    throw new Error('El archivo no es JSON válido')
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  const objects = items.filter(isRecord)
  const keys = unionKeys(objects)

  const rows: string[] = [keys.join(',')]
  for (const obj of objects) {
    rows.push(keys.map((key) => csvCell(obj[key])).join(','))
  }
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.csv`, rows.join('\n'), 'csv', 'text/csv')
}

async function xmlToJson(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  converting(55)
  const { XMLParser } = await import('fast-xml-parser')
  // parseTagValue:false conserva los valores textuales como strings (JSON más honesto).
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true, parseTagValue: false })
  const parsed: unknown = parser.parse(decodeUtf8(input.bytes))
  generating(90)
  done(100)
  const json = JSON.stringify(parsed, null, 2)
  return textResult(`${baseName(input.name)}.json`, json, 'json', 'application/json')
}

/* CSV → XLSX */ /* -------------------------------------------------- */

async function csvToXlsx(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const XLSX = await import('xlsx')
  const wb = XLSX.read(decodeUtf8(input.bytes), { type: 'string' })
  converting(55)
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  generating(90)
  done(100)
  return fileResult(`${baseName(input.name)}.xlsx`, new Uint8Array(out as ArrayBuffer), 'xlsx', XLSX_MIME)
}

/* XLSX → JSON */ /* ------------------------------------------------- */

async function xlsxToJson(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const XLSX = await import('xlsx')
  const wb = XLSX.read(input.bytes, { type: 'array' })
  converting(55)
  const sheetName = wb.SheetNames[0]
  const sheet = sheetName ? wb.Sheets[sheetName] : undefined
  if (!sheet) throw new Error('El archivo Excel no contiene hojas de cálculo')
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.json`, JSON.stringify(rows, null, 2), 'json', 'application/json')
}

/* JSON → XLSX */ /* ------------------------------------------------- */

async function jsonToXlsx(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(input.bytes))
  } catch {
    throw new Error('El archivo no es JSON válido')
  }
  const items = Array.isArray(parsed) ? parsed.filter(isRecord) : [parsed].filter(isRecord)
  const XLSX = await import('xlsx')
  const ws = XLSX.utils.json_to_sheet(items)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Datos')
  converting(55)
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  generating(90)
  done(100)
  return fileResult(`${baseName(input.name)}.xlsx`, new Uint8Array(out as ArrayBuffer), 'xlsx', XLSX_MIME)
}

/* XLSX → CSV (parseo propio del XML) */ /* --------------------------- */

/** Extrae los strings compartidos del XLSX (`sharedStrings` → array). */
function parseSharedStrings(xml: string): string[] {
  const strings: string[] = []
  for (const si of xml.matchAll(/<si[\s\S]*?<\/si>/g)) {
    const texts = [...(si[0] ?? '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) =>
      decodeXmlEntities(m[1] ?? ''),
    )
    strings.push(texts.join(''))
  }
  return strings
}

/** "A1" → 0, "B1" → 1, "AA1" → 26… (índice de columna 0-based). */
function colIndex(ref: string): number {
  const letters = ref.replace(/[^A-Za-z]/g, '')
  let index = 0
  for (const ch of letters) index = index * 26 + (ch.toLowerCase().charCodeAt(0) - 96)
  return index - 1
}

/** Parsea `sheet1.xml` a filas CSV resolviendo el tipo de cada celda. */
function parseSheet(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = []
  for (const rowMatch of xml.matchAll(/<row[\s\S]*?<\/row>/g)) {
    const cells: Array<{ index: number; value: string }> = []
    for (const cell of (rowMatch[0] ?? '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1] ?? ''
      const inner = cell[2] ?? ''
      const type = /(?:^|\s)t="([^"]*)"/.exec(attrs)?.[1]
      const ref = /(?:^|\s)r="([^"]*)"/.exec(attrs)?.[1]
      const rawValue = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? ''

      let value: string
      if (type === 's') {
        // índice a sharedStrings (la celda puede ser <v> vacío → string en posición 0)
        value = sharedStrings[Number(rawValue)] ?? ''
      } else if (type === 'inlineStr') {
        value = decodeXmlEntities(
          /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>[\s\S]*?<\/is>/.exec(inner)?.[1] ?? '',
        )
      } else {
        value = decodeXmlEntities(rawValue)
      }
      cells.push({ index: ref ? colIndex(ref) : cells.length, value })
    }
    let width = 0
    for (const cell of cells) width = Math.max(width, cell.index + 1)
    const row = Array.from({ length: width }, () => '')
    for (const cell of cells) row[cell.index] = cell.value
    rows.push(row)
  }
  return rows
}

async function xlsxToCsv(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const { unzipSync, strFromU8 } = await import('fflate')
  const entries = unzipSync(input.bytes)
  const sheetBytes = entries['xl/worksheets/sheet1.xml']
  if (!sheetBytes) throw new Error('No se encontró la hoja de cálculo en el archivo')
  const sharedBytes = entries['xl/sharedStrings.xml']
  converting(55)
  const sharedStrings = sharedBytes ? parseSharedStrings(strFromU8(sharedBytes)) : []
  const rows = parseSheet(strFromU8(sheetBytes), sharedStrings)
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n')
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.csv`, csv, 'csv', 'text/csv')
}

/* JSON pretty / minify */ /* ----------------------------------------- */

async function jsonPretty(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  converting(55)
  const parsed: unknown = JSON.parse(decodeUtf8(input.bytes))
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.json`, JSON.stringify(parsed, null, 2), 'json', 'application/json')
}

async function jsonMinify(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  converting(55)
  const parsed: unknown = JSON.parse(decodeUtf8(input.bytes))
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.json`, JSON.stringify(parsed), 'json', 'application/json')
}

/** Runners del dominio datos (CSV/JSON/XML/XLSX). */
export const dataRunners: RunnerDef[] = [
  {
    id: 'csv-to-json',
    label: 'JSON',
    ext: 'json',
    description: 'Convierte la tabla CSV a un arreglo de objetos JSON.',
    from: ['csv'],
    run: csvToJson,
  },
  {
    id: 'csv-to-xlsx',
    label: 'XLSX',
    ext: 'xlsx',
    description: 'Convierte la tabla CSV a una hoja de cálculo de Excel (XLSX).',
    from: ['csv'],
    run: csvToXlsx,
  },
  {
    id: 'json-to-csv',
    label: 'CSV',
    ext: 'csv',
    description: 'Convierte el JSON (arreglo de objetos) a una tabla CSV.',
    from: ['json'],
    run: jsonToCsv,
  },
  {
    id: 'json-to-xlsx',
    label: 'XLSX',
    ext: 'xlsx',
    description: 'Convierte el JSON (arreglo de objetos) a una hoja de cálculo de Excel.',
    from: ['json'],
    run: jsonToXlsx,
  },
  {
    id: 'json-pretty',
    label: 'Legible',
    ext: 'json',
    description: 'Reformatea el JSON con indentación de 2 espacios para leerlo mejor.',
    from: ['json'],
    run: jsonPretty,
  },
  {
    id: 'json-minify',
    label: 'Compacto',
    ext: 'json',
    description: 'Comprime el JSON a una sola línea, sin espacios ni saltos.',
    from: ['json'],
    run: jsonMinify,
  },
  {
    id: 'xlsx-to-csv',
    label: 'CSV',
    ext: 'csv',
    description: 'Convierte la hoja de cálculo de Excel a una tabla CSV.',
    from: ['xlsx'],
    run: xlsxToCsv,
  },
  {
    id: 'xlsx-to-json',
    label: 'JSON',
    ext: 'json',
    description: 'Convierte la primera hoja del Excel a un archivo JSON legible.',
    from: ['xlsx'],
    run: xlsxToJson,
  },
  {
    id: 'xml-to-json',
    label: 'JSON',
    ext: 'json',
    description: 'Transforma el XML a un JSON legible y estructurado.',
    from: ['xml'],
    run: xmlToJson,
  },
]