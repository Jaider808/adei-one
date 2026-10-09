/**
 * ADEI-ONE — Dominio RTF de "Eliminar metadata" (`meta.strip`).
 *
 * El RTF es texto con grupos delimitados por llaves BALANCEADAS y control words
 * que empiezan por barra invertida. La metadata vive en dos grupos:
 * - `{\info …}`: título, asunto, autor, empresa, fechas, contadores e `\id`
 *   (identificador de documento).
 * - `{\*\generator …}`: la aplicación con la que se creó el documento.
 *
 * Cirugía PURA sobre el texto (Node-testable, sin DOM): se localizan los tramos
 * de esos grupos con un escáner CONSCIENTE DE ESCAPES y se recortan, de modo que
 * TODO lo demás conserva sus bytes exactos. El escáner distingue llaves literales
 * (`\{`, `\}`), barras literales (`\\`), escapes hexadecimales (`\'hh`, que pueden
 * representar `{`/`}` sin ser delimitadores) y control words (`\word` con
 * parámetro numérico opcional y delimitador).
 *
 * Bloques (los ids que envía el wizard en `blocks`):
 * - 'info'      → grupo `{\info …}` completo.
 * - 'generator' → grupo `{\*\generator …}`.
 * - 'format'    → versión de RTF y juego de caracteres de la cabecera; NUNCA se
 *                 borran (`removal: 'never'`).
 *
 * Semántica de modo (ver `domain.ts`): en `light` solo se eliminan los bloques
 * pedidos (lista vacía = passthrough byte a byte); en `deep` se eliminan todos.
 * Nunca lanza: un RTF no interpretable pasa tal cual.
 */
import { EMPTY_REPORT } from './domain'
import type { MetaDomain, StripConfig } from './domain'
import type { MetadataBlock, MetadataField, MetadataReport, MetaEntry } from '@/core/types'

/* ── Lectura byte a byte sin pérdida (Latin-1 manual) ── */

/**
 * Bytes → texto con un carácter por byte (biyección exacta). NO se usa
 * `TextDecoder('latin1')` porque el alias WHATWG apunta a windows-1252 y
 * corrompería los bytes 0x80–0x9F; así el reensamblado conserva cada byte.
 */
function bytesToLatin1(bytes: Uint8Array): string {
  const CHUNK = 8192
  let out = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return out
}

/** Texto Latin-1 → bytes (inversa exacta de `bytesToLatin1`). */
function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/* ── Escáner consciente de escapes ── */

function isAlpha(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z'))
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

type ControlToken =
  | { kind: 'word'; word: string; param?: string; next: number }
  | { kind: 'symbol'; symbol: string; next: number }
  | { kind: 'hex'; hex: string; next: number }

/**
 * Lee el control sequence que empieza en `at` (donde `text[at] === '\\'`) y
 * devuelve el token con el índice siguiente. `null` si el RTF está truncado
 * (barra invertida sin nada detrás o escape hexadecimal incompleto).
 */
function readControl(text: string, at: number): ControlToken | null {
  const j = at + 1
  if (j >= text.length) return null
  const ch = text[j]
  if (isAlpha(ch)) {
    let k = j
    while (k < text.length && isAlpha(text[k])) k++
    const word = text.slice(j, k)
    let param: string | undefined
    if (text[k] === '-') {
      let m = k + 1
      while (m < text.length && isDigit(text[m])) m++
      if (m > k + 1) {
        param = text.slice(k, m)
        k = m
      }
    } else if (isDigit(text[k])) {
      let m = k
      while (m < text.length && isDigit(text[m])) m++
      param = text.slice(k, m)
      k = m
    }
    if (text[k] === ' ') k++ // delimitador de fin de control word
    return { kind: 'word', word, param, next: k }
  }
  if (ch === "'") {
    const hex = text.slice(j + 1, j + 3)
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return null
    return { kind: 'hex', hex, next: j + 3 }
  }
  return { kind: 'symbol', symbol: ch, next: j + 1 }
}

/** Grupo con su tramo de texto, el destino de su cabecera y si era `\*`. */
interface RtfGroup {
  start: number
  end: number
  dest: string
  ignorable: boolean
}

/** Cabecera de un grupo: control word destino y marca de destino ignorable `\*`. */
function groupHeader(text: string, open: number): { dest: string; ignorable: boolean } {
  let i = open + 1
  while (isWs(text[i])) i++
  if (text[i] !== '\\') return { dest: '', ignorable: false }
  const token = readControl(text, i)
  if (!token) return { dest: '', ignorable: false }
  if (token.kind === 'symbol' && token.symbol === '*') {
    i = token.next
    while (isWs(text[i])) i++
    if (text[i] === '\\') {
      const next = readControl(text, i)
      if (next && next.kind === 'word') return { dest: next.word, ignorable: true }
    }
    return { dest: '', ignorable: true }
  }
  if (token.kind === 'word') return { dest: token.word, ignorable: false }
  return { dest: '', ignorable: false }
}

/**
 * Empareja las llaves de TODO el documento y devuelve cada grupo con su tramo.
 * `null` si el RTF está mal formado (llave sin pareja o barra truncada), en cuyo
 * caso el strip hace passthrough.
 */
function tokenizeGroups(text: string): RtfGroup[] | null {
  const stack: number[] = []
  const groups: RtfGroup[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      const token = readControl(text, i)
      if (!token) return null
      i = token.next
      continue
    }
    if (ch === '{') {
      stack.push(i)
      i++
      continue
    }
    if (ch === '}') {
      const start = stack.pop()
      if (start === undefined) return null
      const header = groupHeader(text, start)
      groups.push({ start, end: i + 1, dest: header.dest, ignorable: header.ignorable })
      i++
      continue
    }
    i++
  }
  if (stack.length > 0) return null
  return groups
}

/** Índice tras la `}` que cierra el grupo abierto en `open` (o -1). */
function matchingBrace(text: string, open: number): number {
  let depth = 0
  let i = open
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      const token = readControl(text, i)
      if (!token) return -1
      i = token.next
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  return -1
}

/** Primer grupo con el destino pedido (el más externo si hubiera varios). */
function pickGroup(groups: RtfGroup[], dest: string, ignorable: boolean): RtfGroup | undefined {
  let best: RtfGroup | undefined
  for (const group of groups) {
    if (group.dest !== dest || group.ignorable !== ignorable) continue
    if (!best || group.start < best.start) best = group
  }
  return best
}

/** Grupo `{\*\generator …}` (o su forma sin `\*`). */
function findGenerator(groups: RtfGroup[]): RtfGroup | undefined {
  return pickGroup(groups, 'generator', true) ?? pickGroup(groups, 'generator', false)
}

/* ── Extracción de valores ── */

/** Texto legible del contenido de un grupo: resuelve escapes y descarta control words. */
function rtfText(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      const token = readControl(text, i)
      if (!token) break
      if (token.kind === 'hex') out += String.fromCharCode(parseInt(token.hex, 16))
      else if (token.kind === 'symbol') {
        if (token.symbol === '{' || token.symbol === '}' || token.symbol === '\\') out += token.symbol
        else if (token.symbol === '~') out += '\u00a0'
        else if (token.symbol === '-') out += '\u00ad'
        else if (token.symbol === '_') out += '\u2011'
      }
      i = token.next
      continue
    }
    if (ch !== '{' && ch !== '}') out += ch
    i++
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** Grupos de fecha del `\info` (contenedores de `\yr`/`\mo`/`\dy`/`\hr`/`\min`). */
const DATE_WORDS: ReadonlySet<string> = new Set(['creatim', 'revtim', 'printim', 'buptim'])

/** Fecha legible a partir de los control words `\yr`/`\mo`/`\dy`/`\hr`/`\min`. */
function parseDateValue(inner: string): string {
  const part = (name: string): number | undefined => {
    const match = new RegExp('\\\\' + name + '(-?\\d+)').exec(inner)
    return match ? Number(match[1]) : undefined
  }
  const yr = part('yr')
  const mo = part('mo')
  const dy = part('dy')
  const hr = part('hr')
  const min = part('min')
  const pieces: string[] = []
  if (yr !== undefined || mo !== undefined || dy !== undefined) {
    pieces.push([yr, mo, dy].map((v) => (v === undefined ? '' : String(v).padStart(2, '0'))).join('-'))
  }
  if (hr !== undefined || min !== undefined) {
    pieces.push([hr, min].map((v) => (v === undefined ? '00' : String(v).padStart(2, '0'))).join(':'))
  }
  return pieces.join(' ')
}

/** Valor visible: limpia espacios y recorta a un máximo. */
function display(value: string, max = 200): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/* ── Campos reconocidos de `{\info …}` ── */

interface InfoMeta {
  label: string
  sensitivity: MetadataField['sensitivity']
}

/** Control word del `\info` → etiqueta legible y sensibilidad. */
const INFO_FIELDS: Record<string, InfoMeta> = {
  title: { label: 'Título', sensitivity: 'low' },
  subject: { label: 'Asunto', sensitivity: 'low' },
  author: { label: 'Autor', sensitivity: 'medium' },
  manager: { label: 'Responsable', sensitivity: 'medium' },
  company: { label: 'Empresa', sensitivity: 'medium' },
  operator: { label: 'Operador', sensitivity: 'medium' },
  category: { label: 'Categoría', sensitivity: 'low' },
  keywords: { label: 'Palabras clave', sensitivity: 'low' },
  comment: { label: 'Comentario', sensitivity: 'low' },
  doccomm: { label: 'Comentario del documento', sensitivity: 'low' },
  creatim: { label: 'Fecha de creación', sensitivity: 'medium' },
  revtim: { label: 'Fecha de revisión', sensitivity: 'medium' },
  printim: { label: 'Fecha de impresión', sensitivity: 'medium' },
  buptim: { label: 'Fecha de copia de seguridad', sensitivity: 'medium' },
  version: { label: 'Versión', sensitivity: 'low' },
  edmins: { label: 'Minutos de edición', sensitivity: 'low' },
  nofpages: { label: 'Nº de páginas', sensitivity: 'low' },
  nofwords: { label: 'Nº de palabras', sensitivity: 'low' },
  nofchars: { label: 'Nº de caracteres', sensitivity: 'low' },
  id: { label: 'Identificador del documento', sensitivity: 'high' },
}

interface InfoItem {
  word: string
  value: string
  start: number
  end: number
}

/**
 * Enumeración de los campos reconocidos dentro del grupo `{\info …}`: subgrupos
 * (`{\author …}`) o control words sueltos (`\id 123`). `null` si un subgrupo no
 * cierra (RTF mal formado).
 */
function parseInfoEntries(text: string, start: number, end: number): InfoItem[] | null {
  const items: InfoItem[] = []
  const limit = end - 1 // la `}` de cierre del grupo info
  let i = start + 1
  while (i < limit) {
    const ch = text[i]
    if (ch === '\\') {
      const token = readControl(text, i)
      if (!token) return null
      if (token.kind === 'word' && INFO_FIELDS[token.word]) {
        items.push({ word: token.word, value: token.param ?? '', start: i, end: token.next })
      }
      i = token.next
      continue
    }
    if (ch === '{') {
      const groupEnd = matchingBrace(text, i)
      if (groupEnd < 0 || groupEnd > end) return null
      const header = groupHeader(text, i)
      if (header.dest && INFO_FIELDS[header.dest]) {
        const inner = text.slice(i + 1, groupEnd - 1)
        const value = DATE_WORDS.has(header.dest) ? parseDateValue(inner) : rtfText(inner)
        items.push({ word: header.dest, value, start: i, end: groupEnd })
      }
      i = groupEnd
      continue
    }
    i++
  }
  return items
}

/* ── Cabecera (bloque format) ── */

/** Prefijo de cabecera del grupo raíz (antes del primer subgrupo). */
function headerPrefix(text: string, root: RtfGroup): string {
  const brace = text.indexOf('{', root.start + 1)
  const end = brace < 0 || brace >= root.end ? root.end : brace
  return text.slice(root.start + 1, end)
}

/** Juego de caracteres declarado en la cabecera (o undefined). */
function detectCharset(header: string): string | undefined {
  if (/\\ansi\b/.test(header) || /\\ansicpg\d+/.test(header)) {
    const cp = /\\ansicpg(\d+)/.exec(header)
    return cp ? `ANSI (cp ${cp[1]})` : 'ANSI'
  }
  if (/\\mac\b/.test(header)) return 'Macintosh'
  if (/\\pca\b/.test(header)) return 'IBM PC (pca)'
  if (/\\pc\b/.test(header)) return 'IBM PC'
  return undefined
}

/* ── Escaneo ── */

/** Escaneo RTF: campos del `\info`, `\*\generator` y bloque `format`. */
function scanRtf(bytes: Uint8Array): MetadataReport {
  const text = bytesToLatin1(bytes)
  const groups = tokenizeGroups(text)
  if (!groups) return EMPTY_REPORT
  const blocks: MetadataBlock[] = []
  const entries: MetaEntry[] = []

  const info = pickGroup(groups, 'info', false)
  if (info) {
    const items = parseInfoEntries(text, info.start, info.end)
    if (items === null) return EMPTY_REPORT
    const fields: MetadataField[] = []
    for (const item of items) {
      const meta = INFO_FIELDS[item.word]
      if (!meta) continue
      const value = display(item.value) || 'Presente'
      fields.push({ name: meta.label, value, sensitivity: meta.sensitivity })
      entries.push({
        where: `info > \\${item.word}`,
        key: `\\${item.word}`,
        label: meta.label,
        value,
        size: item.end - item.start,
        sensitivity: meta.sensitivity,
        removal: 'with-container',
      })
    }
    if (fields.length) blocks.push({ id: 'info', label: 'Información del documento', removableIn: 'light', fields })
  }

  const generator = findGenerator(groups)
  if (generator) {
    const inner = text.slice(generator.start + 1, generator.end - 1)
    const value = display(rtfText(inner)) || 'Presente'
    blocks.push({
      id: 'generator',
      label: 'Aplicación generadora',
      removableIn: 'light',
      fields: [{ name: 'Generador', value, sensitivity: 'medium' }],
    })
    entries.push({
      where: 'destino \\*\\generator',
      key: '\\generator',
      label: 'Generador',
      value,
      size: generator.end - generator.start,
      sensitivity: 'medium',
      removal: 'with-container',
    })
  }

  const root = pickGroup(groups, 'rtf', false)
  if (root) {
    const header = headerPrefix(text, root)
    const formatFields: MetadataField[] = []
    const version = /\\rtf(\d+)/.exec(header)
    if (version) {
      const value = version[1]
      formatFields.push({ name: 'Versión RTF', value, sensitivity: 'low', removableIn: 'never' })
      entries.push({ where: 'cabecera', key: '\\rtf', label: 'Versión RTF', value, sensitivity: 'low', removal: 'never' })
    }
    const charset = detectCharset(header)
    if (charset) {
      formatFields.push({ name: 'Juego de caracteres', value: charset, sensitivity: 'low', removableIn: 'never' })
      entries.push({ where: 'cabecera', key: 'charset', label: 'Juego de caracteres', value: charset, sensitivity: 'low', removal: 'never' })
    }
    if (formatFields.length) blocks.push({ id: 'format', label: 'Formato del RTF', removableIn: 'never', fields: formatFields })
  }

  if (!blocks.length && !entries.length) return EMPTY_REPORT
  const fields = blocks.flatMap((block) => block.fields)
  return { fields, count: fields.length, blocks, entries }
}

/* ── Limpieza ── */

/** Recorta los tramos [inicio, fin) del texto y devuelve el resto concatenado. */
function removeRegions(text: string, regions: Array<[number, number]>): string {
  if (!regions.length) return text
  const sorted = [...regions].sort((a, b) => a[0] - b[0])
  let out = ''
  let cursor = 0
  for (const [start, end] of sorted) {
    if (end <= cursor) continue
    const from = Math.max(start, cursor)
    if (from > cursor) out += text.slice(cursor, from)
    cursor = end
  }
  out += text.slice(cursor)
  return out
}

/** Borrado quirúrgico de los grupos info/generator; el resto conserva sus bytes. */
function stripRtf(bytes: Uint8Array, config: StripConfig): Uint8Array {
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  const text = bytesToLatin1(bytes)
  const groups = tokenizeGroups(text)
  if (!groups) return bytes.slice()
  const want = (block: string): boolean => config.mode === 'deep' || config.blocks.includes(block)
  const regions: Array<[number, number]> = []
  if (want('info')) {
    const info = pickGroup(groups, 'info', false)
    if (info) regions.push([info.start, info.end])
  }
  if (want('generator')) {
    const generator = findGenerator(groups)
    if (generator) regions.push([generator.start, generator.end])
  }
  if (!regions.length) return bytes.slice()
  return latin1ToBytes(removeRegions(text, regions))
}

/* ── Dominio ── */

/** Dominio RTF de "Eliminar metadata": escaneo y limpieza quirúrgica byte a byte. */
export const rtfDomain: MetaDomain = {
  kinds: ['rtf'],
  scan: async (bytes: Uint8Array): Promise<MetadataReport> => {
    try {
      return scanRtf(bytes)
    } catch {
      // Ante cualquier fallo de interpretación, nunca lanzamos: report vacío.
      return EMPTY_REPORT
    }
  },
  strip: async (bytes: Uint8Array, _kind, config: StripConfig, report): Promise<Uint8Array> => {
    report('Limpiando metadata del RTF', 50)
    try {
      return stripRtf(bytes, config)
    } catch {
      // RTF no interpretable: passthrough de los mismos bytes.
      return bytes.slice()
    }
  },
}
