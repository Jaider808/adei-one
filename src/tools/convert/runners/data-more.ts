/**
 * ADEI-ONE — Runners de datos EXTRA del "Convertidor universal" (data-more).
 * Dominio: XML ↔ CSV, YAML ↔ JSON y TOML ↔ JSON, más tablas Markdown → CSV.
 * Complementa `data.ts` sin tocar sus conversiones.
 *
 * Las librerías (fast-xml-parser, js-yaml, smol-toml) se cargan con `import()`
 * dinámico dentro del runner que las usa para mantener el bundle inicial fino.
 */
import {
  baseName,
  csvCell,
  decodeUtf8,
  parseCsv,
  requireBytes,
  steps,
  textResult,
} from '../helpers'
import type { ProgressCb } from '../helpers'
import type { RunnerDef } from '../runner-types'
import type { EngineInput, ProcessResult } from '@/core/types'

/** MIME XML de salida (texto plano serializado como XML). */
const XML_MIME = 'application/xml'

/** Escapa los caracteres especiales de XML (texto y nombres de elemento). */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** ¿Es un objeto plano? (excluye null y arrays). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Texto de un valor escalar (null/undefined se omiten). */
function scalarXml(value: unknown): string {
  if (typeof value === 'string') return escapeXml(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/**
 * Serializa un valor a un elemento XML `<name>` SIN atributos:
 * objetos → elementos anidados, arrays → el elemento repetido por ítem,
 * primitivos → texto del elemento (escritor manual, sin dependencias).
 */
function xmlNode(name: string, value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => xmlNode(name, item)).join('')
  if (isRecord(value)) {
    const inner = Object.entries(value)
      .map(([key, child]) => xmlNode(key, child))
      .join('')
    return `<${escapeXml(name)}>${inner}</${escapeXml(name)}>`
  }
  if (value === null || value === undefined) return `<${escapeXml(name)}/>`
  return `<${escapeXml(name)}>${scalarXml(value)}</${escapeXml(name)}>`
}

/** JSON → XML (manual, sin atributos específicos). */
async function jsonToXml(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(input.bytes))
  } catch {
    throw new Error('El archivo no es JSON válido')
  }
  converting(55)
  let body: string
  if (Array.isArray(parsed)) {
    // Arrays de nivel superior: ítems anónimos bajo la raíz <root>.
    body = parsed.map((item) => xmlNode('item', item)).join('')
  } else if (isRecord(parsed)) {
    body = Object.entries(parsed)
      .map(([key, child]) => xmlNode(key, child))
      .join('')
  } else {
    body = scalarXml(parsed)
  }
  generating(90)
  done(100)
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<root>${body}</root>`
  return textResult(`${baseName(input.name)}.xml`, xml, 'xml', XML_MIME)
}

/** CSV → XML: primera fila = claves; cada fila = un elemento `<row>`. */
async function csvToXml(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const rows = parseCsv(decodeUtf8(input.bytes))
  const [header = [], ...body] = rows
  converting(55)
  // Celdas vacías del encabezado reciben un nombre de columna generado.
  const columns = header.map((name, i) => (name.trim() ? name.trim() : `col${i + 1}`))
  const lines = body.map((cells) => {
    const inner = columns
      .map(
        (col, i) =>
          `<${escapeXml(col)}>${escapeXml(cells[i] ?? '')}</${escapeXml(col)}>`,
      )
      .join('')
    return `<row>${inner}</row>`
  })
  generating(90)
  done(100)
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<root>${lines.join('\n')}</root>`
  return textResult(`${baseName(input.name)}.xml`, xml, 'xml', XML_MIME)
}

/** Unión de claves de todos los objetos (preserva el orden de aparición). */
function unionKeys(objects: Array<Record<string, unknown>>): string[] {
  const keys = new Set<string>()
  for (const obj of objects) for (const key of Object.keys(obj)) keys.add(key)
  return [...keys]
}

/**
 * Busca en profundidad el PRIMER array de objetos planos dentro de un valor
 * (las listas repetidas de un XML llegan como arrays del parser).
 */
function firstRecordArray(
  value: unknown,
  visited: Set<object> = new Set(),
): Array<Record<string, unknown>> | null {
  if (Array.isArray(value)) {
    const items = value.filter(isRecord)
    if (items.length > 0) return items
  }
  if (isRecord(value) && !visited.has(value)) {
    visited.add(value)
    for (const child of Object.values(value)) {
      const found = firstRecordArray(child, visited)
      if (found) return found
    }
  }
  return null
}

/** XML → CSV: filas = primer array de elementos repetidos; columnas = sus claves. */
async function xmlToCsv(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const { XMLParser } = await import('fast-xml-parser')
  converting(40)
  // parseTagValue:false conserva los valores como strings (misma estrategia que xml→json).
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true, parseTagValue: false })
  const parsed: unknown = parser.parse(decodeUtf8(input.bytes))
  converting(55)
  const items = firstRecordArray(parsed)
  if (!items) throw new Error('No se encontró una lista de elementos repetidos en el XML')
  const keys = unionKeys(items)
  const rows: string[] = [keys.join(',')]
  for (const item of items) rows.push(keys.map((key) => csvCell(item[key])).join(','))
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.csv`, rows.join('\n'), 'csv', 'text/csv')
}

/** YAML → JSON (js-yaml cargado con import() dinámico). */
async function yamlToJson(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const yaml = await import('js-yaml')
  converting(40)
  const parsed: unknown = yaml.load(decodeUtf8(input.bytes))
  converting(55)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.json`, JSON.stringify(parsed, null, 2), 'json', 'application/json')
}

/** JSON → YAML (js-yaml; salida como texto plano con mime de YAML). */
async function jsonToYaml(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(input.bytes))
  } catch {
    throw new Error('El archivo no es JSON válido')
  }
  converting(40)
  const yaml = await import('js-yaml')
  converting(55)
  const out = yaml.dump(parsed)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.yaml`, out, 'txt', 'text/x-yaml')
}

/** TOML → JSON (smol-toml cargado con import() dinámico). */
async function tomlToJson(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const { parse } = await import('smol-toml')
  converting(40)
  const parsed: unknown = parse(decodeUtf8(input.bytes))
  converting(55)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.json`, JSON.stringify(parsed, null, 2), 'json', 'application/json')
}

/**
 * JSON → TOML (smol-toml; salida como texto plano con mime de TOML).
 * smol-toml serializa objetos anidados, arreglos de primitivos y tablas
 * `[[...]]`; si el valor no es representable, stringify lanza error.
 */
async function jsonToToml(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(input.bytes))
  } catch {
    throw new Error('El archivo no es JSON válido')
  }
  converting(40)
  const { stringify } = await import('smol-toml')
  converting(55)
  let toml: string
  try {
    toml = stringify(parsed)
  } catch {
    throw new Error('El JSON no se puede representar como TOML')
  }
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.toml`, toml, 'txt', 'application/toml')
}

/** Extrae la primera tabla Markdown de un texto → CSV (omite filas ---). */
async function mdTableToCsv(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const rows: string[][] = []
  for (const raw of decodeUtf8(input.bytes).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('|')) continue
    // Fila separadora de la cabecera (|---| o | :-- |) → se omite.
    if (/^\|[\s:|-]+\|$/.test(line)) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim())
    rows.push(cells)
  }
  if (rows.length === 0) throw new Error('No se encontró una tabla Markdown')
  converting(55)
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\n')
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.csv`, csv, 'csv', 'text/csv')
}

/**
 * Runners del dominio datos extra (XML/CSV/YAML/TOML/tablas MD).
 * El orquestador lo agrega al índice junto a `dataRunners`.
 */
export const dataMoreRunners: RunnerDef[] = [
  {
    id: 'json-to-xml',
    label: 'XML',
    ext: 'xml',
    description: 'Convierte el JSON a XML básico (sin atributos específicos).',
    from: ['json'],
    run: jsonToXml,
  },
  {
    id: 'csv-to-xml',
    label: 'XML',
    ext: 'xml',
    description: 'Convierte la tabla CSV a XML con una fila `<row>` por registro.',
    from: ['csv'],
    run: csvToXml,
  },
  {
    id: 'xml-to-csv',
    label: 'CSV',
    ext: 'csv',
    description: 'Extrae la lista repetida del XML a una tabla CSV.',
    from: ['xml'],
    run: xmlToCsv,
  },
  {
    id: 'yaml-to-json',
    label: 'JSON',
    ext: 'json',
    description: 'Convierte el YAML a un JSON legible.',
    from: ['yaml'],
    run: yamlToJson,
  },
  {
    id: 'json-to-yaml',
    label: 'YAML',
    ext: 'yaml',
    description: 'Convierte el JSON a un documento YAML legible.',
    from: ['json'],
    run: jsonToYaml,
  },
  {
    id: 'toml-to-json',
    label: 'JSON',
    ext: 'json',
    description: 'Convierte el TOML a un JSON legible.',
    from: ['toml'],
    run: tomlToJson,
  },
  {
    id: 'json-to-toml',
    label: 'TOML',
    ext: 'toml',
    description: 'Convierte el JSON a un archivo TOML.',
    from: ['json'],
    run: jsonToToml,
  },
  {
    id: 'md-table-to-csv',
    label: 'CSV',
    ext: 'csv',
    description: 'Extrae la tabla Markdown a una tabla CSV.',
    from: ['md', 'txt'],
    run: mdTableToCsv,
  },
]