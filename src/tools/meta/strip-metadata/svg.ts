/**
 * ADEI-ONE — Dominio SVG de "Eliminar metadata".
 *
 * Contrato en `domain.ts`: cirugía PURA sobre el texto del SVG (Node-testable,
 * sin DOM ni re-serialización). El escaneo y la limpieza trabajan sobre los
 * BYTES: se localizan los tramos de metadata y se recortan, de modo que TODO lo
 * demás conserva sus bytes, espacios y formato exactos.
 *
 * Bloques (los ids que envía el wizard en `blocks`):
 * - 'metadata' → elemento `<metadata>…</metadata>` (o su forma autocerrada).
 * - 'title'    → elementos `<title>…</title>` y `<desc>…</desc>`.
 * - 'comments' → comentarios `<!-- … -->` e instrucciones `<?…?>` (salvo la
 *   declaración XML `<?xml …?>`).
 * - 'editor'   → atributos/namespaces del editor (`inkscape:*`, `sodipodi:*`,
 *   `xmlns:inkscape`, `xmlns:sodipodi`, `data-name`) y los elementos propios de
 *   esos espacios de nombres (`<sodipodi:namedview>`, `<inkscape:grid>`…). Se
 *   eliminan juntos para que el documento no quede con prefijos sin declarar.
 * - 'format'   → datos estructurales de la raíz (`viewBox`, `width`, `height`,
 *   `version`); NUNCA se borran (`removal: 'never'`).
 *
 * Semántica de modo (ver `domain.ts`): en `light` solo se eliminan los bloques
 * pedidos (lista vacía = passthrough byte a byte); en `deep` se eliminan todos.
 * Nunca lanza: un SVG que no valida como XML bien formado pasa tal cual.
 */
import { XMLValidator } from 'fast-xml-parser'
import { concat } from './chunks'
import { EMPTY_REPORT, shortHex } from './domain'
import type { MetaDomain, StripConfig } from './domain'
import type { MetadataBlock, MetadataField, MetadataReport, MetaEntry } from '@/core/types'

/* ── Decodificadores reutilizables ── */

const UTF8 = new TextDecoder('utf-8')

/** Limpia un valor de texto para mostrarlo (sin saltos largos ni binario). */
function cleanText(value: string, max = 200): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** Valor legible de un tramo: texto UTF-8 limpio o `hex` si parece binario. */
function textOrHex(raw: Uint8Array): { value: string; hex?: string } {
  const decoded = UTF8.decode(raw)
  if (decoded.includes('\uFFFD') || decoded.includes('\u0000')) return { value: '', hex: shortHex(raw) }
  const value = cleanText(decoded)
  if (!value && raw.length) return { value: '', hex: shortHex(raw) }
  return { value }
}

/* ── Tokenizador de etiquetas XML sobre bytes ── */

type SvgTokenKind = 'start' | 'end' | 'self' | 'comment' | 'pi' | 'cdata' | 'doctype'

/** Atributo de una etiqueta con el tramo exacto a recortar (incluye el espacio previo). */
interface SvgAttr {
  name: string
  value: string
  /** Índice inicial del tramo (espacio en blanco anterior incluido). */
  start: number
  /** Índice final exclusivo del tramo (valor incluido). */
  end: number
}

/** Etiqueta o construcción especial del documento, con su tramo de bytes. */
interface SvgToken {
  kind: SvgTokenKind
  /** Nombre cualificado (`metadata`, `svg`, `inkscape:grid`…); vacío en comentarios. */
  name: string
  start: number
  /** Índice final exclusivo (justo tras el `>` de cierre). */
  end: number
  attrs: SvgAttr[]
}

const BYTE_LT = 0x3c // '<'
const BYTE_GT = 0x3e // '>'
const BYTE_SLASH = 0x2f // '/'
const BYTE_EQ = 0x3d // '='
const BYTE_DQUOTE = 0x22 // '"'
const BYTE_SQUOTE = 0x27 // "'"
const BYTE_LBRACKET = 0x5b // '['
const BYTE_RBRACKET = 0x5d // ']'

function isSpace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

/** ¿Los bytes en `pos` son exactamente el texto ASCII `text`? */
function matches(bytes: Uint8Array, pos: number, text: string): boolean {
  if (pos < 0 || pos + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i++) {
    if (bytes[pos + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/** Primera aparición de la secuencia ASCII `seq` a partir de `from` (o -1). */
function indexOfSeq(bytes: Uint8Array, from: number, seq: string): number {
  const first = seq.charCodeAt(0)
  const last = bytes.length - seq.length
  for (let i = Math.max(0, from); i <= last; i++) {
    if (bytes[i] !== first) continue
    let ok = true
    for (let j = 1; j < seq.length; j++) {
      if (bytes[i + j] !== seq.charCodeAt(j)) {
        ok = false
        break
      }
    }
    if (ok) return i
  }
  return -1
}

/** Índice tras el `>` de una etiqueta, respetando comillas. -1 si no cierra. */
function findTagEnd(bytes: Uint8Array, from: number): number {
  let quote = 0
  for (let i = from; i < bytes.length; i++) {
    const byte = bytes[i]
    if (quote !== 0) {
      if (byte === quote) quote = 0
      continue
    }
    if (byte === BYTE_DQUOTE || byte === BYTE_SQUOTE) {
      quote = byte
      continue
    }
    if (byte === BYTE_GT) return i + 1
  }
  return -1
}

/** Índice tras el `>` de una declaración `<!…>`, respetando `[…]` (DTD) y comillas. */
function findDeclarationEnd(bytes: Uint8Array, from: number): number {
  let quote = 0
  let depth = 0
  for (let i = from; i < bytes.length; i++) {
    const byte = bytes[i]
    if (quote !== 0) {
      if (byte === quote) quote = 0
      continue
    }
    if (byte === BYTE_DQUOTE || byte === BYTE_SQUOTE) {
      quote = byte
      continue
    }
    if (byte === BYTE_LBRACKET) {
      depth++
      continue
    }
    if (byte === BYTE_RBRACKET) {
      if (depth > 0) depth--
      continue
    }
    if (byte === BYTE_GT && depth === 0) return i + 1
  }
  return -1
}

/** Parsea `<nombre attr="valor" …>` y devuelve nombre + atributos con su tramo. */
function parseStartTag(bytes: Uint8Array, start: number, end: number): { name: string; attrs: SvgAttr[] } | null {
  let i = start + 1
  const nameStart = i
  while (i < end - 1 && !isSpace(bytes[i]) && bytes[i] !== BYTE_SLASH && bytes[i] !== BYTE_GT) i++
  const name = UTF8.decode(bytes.subarray(nameStart, i))
  if (!name) return null
  const attrs: SvgAttr[] = []
  while (i < end - 1) {
    const wsStart = i
    while (i < end - 1 && isSpace(bytes[i])) i++
    if (i >= end - 1) break
    if (bytes[i] === BYTE_SLASH) break // autocierre
    const attrStart = i
    while (i < end - 1 && !isSpace(bytes[i]) && bytes[i] !== BYTE_EQ && bytes[i] !== BYTE_SLASH && bytes[i] !== BYTE_GT) i++
    const attrName = UTF8.decode(bytes.subarray(attrStart, i))
    while (i < end - 1 && isSpace(bytes[i])) i++
    let attrValue = ''
    if (bytes[i] === BYTE_EQ) {
      i++
      while (i < end - 1 && isSpace(bytes[i])) i++
      const quote = bytes[i]
      if (quote === BYTE_DQUOTE || quote === BYTE_SQUOTE) {
        i++
        const valueStart = i
        while (i < end - 1 && bytes[i] !== quote) i++
        attrValue = UTF8.decode(bytes.subarray(valueStart, i))
        if (i < end - 1) i++ // cierre de comilla
      } else {
        const valueStart = i
        while (i < end - 1 && !isSpace(bytes[i]) && bytes[i] !== BYTE_SLASH && bytes[i] !== BYTE_GT) i++
        attrValue = UTF8.decode(bytes.subarray(valueStart, i))
      }
    }
    if (attrName) attrs.push({ name: attrName, value: attrValue, start: wsStart, end: i })
  }
  return { name, attrs }
}

/** Tokeniza el documento en etiquetas/comentarios/PI con sus tramos. null si no cierra. */
function tokenize(bytes: Uint8Array): SvgToken[] | null {
  const tokens: SvgToken[] = []
  let i = 0
  while (i < bytes.length) {
    while (i < bytes.length && bytes[i] !== BYTE_LT) i++
    if (i >= bytes.length) break
    if (matches(bytes, i, '<!--')) {
      const close = indexOfSeq(bytes, i + 4, '-->')
      if (close < 0) return null
      tokens.push({ kind: 'comment', name: '', start: i, end: close + 3, attrs: [] })
      i = close + 3
    } else if (matches(bytes, i, '<![CDATA[')) {
      const close = indexOfSeq(bytes, i + 9, ']]>')
      if (close < 0) return null
      tokens.push({ kind: 'cdata', name: '', start: i, end: close + 3, attrs: [] })
      i = close + 3
    } else if (matches(bytes, i, '<!')) {
      const end = findDeclarationEnd(bytes, i + 2)
      if (end < 0) return null
      tokens.push({ kind: 'doctype', name: '', start: i, end, attrs: [] })
      i = end
    } else if (matches(bytes, i, '<?')) {
      const close = indexOfSeq(bytes, i + 2, '?>')
      if (close < 0) return null
      const inner = UTF8.decode(bytes.subarray(i + 2, close)).trim()
      const name = inner.split(/\s+/)[0] ?? ''
      tokens.push({ kind: 'pi', name, start: i, end: close + 2, attrs: [] })
      i = close + 2
    } else if (bytes[i + 1] === BYTE_SLASH) {
      const end = findTagEnd(bytes, i + 2)
      if (end < 0) return null
      const name = UTF8.decode(bytes.subarray(i + 2, end - 1)).trim()
      tokens.push({ kind: 'end', name, start: i, end, attrs: [] })
      i = end
    } else {
      const end = findTagEnd(bytes, i + 1)
      if (end < 0) return null
      const self = bytes[end - 2] === BYTE_SLASH
      const parsed = parseStartTag(bytes, i, end)
      if (!parsed) return null
      tokens.push({ kind: self ? 'self' : 'start', name: parsed.name, start: i, end, attrs: parsed.attrs })
      i = end
    }
  }
  return tokens
}

/** Empareja cada etiqueta de apertura con su cierre (índices de token). */
function matchElements(tokens: SvgToken[]): Map<number, number> {
  const pairs = new Map<number, number>()
  const stack: number[] = []
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]
    if (token.kind === 'start') stack.push(t)
    else if (token.kind === 'end') {
      const open = stack.pop()
      if (open !== undefined) pairs.set(open, t)
    }
  }
  return pairs
}

/** Tramo [inicio, fin) del elemento completo (autocierre o apertura+cierre). */
function elementRange(tokens: SvgToken[], pairs: Map<number, number>, index: number): [number, number] {
  const token = tokens[index]
  if (token.kind === 'self') return [token.start, token.end]
  const closeIndex = pairs.get(index)
  if (closeIndex === undefined) return [token.start, token.end]
  return [token.start, tokens[closeIndex].end]
}

/** Recorta los tramos indicados y devuelve un `Uint8Array` nuevo (no muta la entrada). */
function removeRegions(bytes: Uint8Array, regions: Array<[number, number]>): Uint8Array {
  if (!regions.length) return bytes.slice()
  const sorted = [...regions].sort((a, b) => a[0] - b[0])
  const parts: Uint8Array[] = []
  let cursor = 0
  for (const [start, end] of sorted) {
    if (end <= cursor) continue
    const from = Math.max(start, cursor)
    if (from > cursor) parts.push(bytes.slice(cursor, from))
    cursor = end
  }
  if (cursor < bytes.length) parts.push(bytes.slice(cursor))
  return concat(parts)
}

/* ── Clasificación de metadata ── */

/** ¿El nombre es un elemento propio de un espacio de nombres de editor? */
function isEditorElement(name: string): boolean {
  return name.startsWith('inkscape:') || name.startsWith('sodipodi:')
}

/** ¿El nombre es un atributo/namespace propio del editor? */
function isEditorAttr(name: string): boolean {
  return (
    name === 'data-name' ||
    name === 'xmlns:inkscape' ||
    name === 'xmlns:sodipodi' ||
    name.startsWith('inkscape:') ||
    name.startsWith('sodipodi:')
  )
}

/** Etiquetas legibles de los atributos del editor más comunes. */
const EDITOR_ATTR_LABELS: Record<string, { label: string; sensitivity: MetadataField['sensitivity'] }> = {
  'inkscape:version': { label: 'Versión de Inkscape', sensitivity: 'medium' },
  'inkscape:label': { label: 'Etiqueta del editor', sensitivity: 'low' },
  'inkscape:groupmode': { label: 'Modo de grupo (Inkscape)', sensitivity: 'low' },
  'inkscape:connector-curvature': { label: 'Curvatura del conector (Inkscape)', sensitivity: 'low' },
  'inkscape:export-filename': { label: 'Ruta de exportación (Inkscape)', sensitivity: 'medium' },
  'inkscape:export-xdpi': { label: 'DPI X de exportación (Inkscape)', sensitivity: 'low' },
  'inkscape:export-ydpi': { label: 'DPI Y de exportación (Inkscape)', sensitivity: 'low' },
  'inkscape:showpageshadow': { label: 'Sombra de página (Inkscape)', sensitivity: 'low' },
  'sodipodi:docname': { label: 'Nombre del documento (Sodipodi)', sensitivity: 'medium' },
  'sodipodi:nodetypes': { label: 'Tipos de nodo (Sodipodi)', sensitivity: 'low' },
  'sodipodi:role': { label: 'Rol (Sodipodi)', sensitivity: 'low' },
  'data-name': { label: 'Nombre de capa (Figma)', sensitivity: 'low' },
  'xmlns:inkscape': { label: 'Espacio de nombres de Inkscape', sensitivity: 'low' },
  'xmlns:sodipodi': { label: 'Espacio de nombres de Sodipodi', sensitivity: 'low' },
}

/** ¿El SVG valida como XML bien formado? Nunca lanza. */
function isWellFormed(bytes: Uint8Array): boolean {
  try {
    return XMLValidator.validate(UTF8.decode(bytes)) === true
  } catch {
    return false
  }
}

/* ── Escaneo ── */

/** Bloques `metadata`: un `<metadata>` por entrada con su texto y tamaño. */
function collectMetadata(bytes: Uint8Array, tokens: SvgToken[], pairs: Map<number, number>, blocks: MetadataBlock[], entries: MetaEntry[]): void {
  const fields: MetadataField[] = []
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]
    if ((token.kind !== 'start' && token.kind !== 'self') || token.name !== 'metadata') continue
    const [start, end] = elementRange(tokens, pairs, t)
    const closeIndex = token.kind === 'self' ? undefined : pairs.get(t)
    const innerEnd = closeIndex === undefined ? token.end : tokens[closeIndex].start
    const { value, hex } = textOrHex(bytes.subarray(token.end, innerEnd))
    const display = value || 'Presente'
    fields.push({ name: 'Metadatos del documento', value: display, sensitivity: 'medium' })
    entries.push({
      where: 'svg > metadata',
      key: 'metadata',
      label: 'Metadatos RDF/Dublin Core',
      value: display,
      ...(hex ? { hex } : {}),
      size: end - start,
      sensitivity: 'medium',
      removal: 'with-container',
    })
  }
  if (fields.length) blocks.push({ id: 'metadata', label: 'Metadatos del documento (RDF)', removableIn: 'light', fields })
}

/** Bloque `title`: `<title>` y `<desc>` con su texto y tamaño. */
function collectTitles(bytes: Uint8Array, tokens: SvgToken[], pairs: Map<number, number>, blocks: MetadataBlock[], entries: MetaEntry[]): void {
  const fields: MetadataField[] = []
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]
    if ((token.kind !== 'start' && token.kind !== 'self') || (token.name !== 'title' && token.name !== 'desc')) continue
    const isTitle = token.name === 'title'
    const [start, end] = elementRange(tokens, pairs, t)
    const closeIndex = token.kind === 'self' ? undefined : pairs.get(t)
    const innerEnd = closeIndex === undefined ? token.end : tokens[closeIndex].start
    const { value, hex } = textOrHex(bytes.subarray(token.end, innerEnd))
    const display = value || 'Presente'
    const label = isTitle ? 'Título' : 'Descripción'
    fields.push({ name: label, value: display, sensitivity: 'low' })
    entries.push({
      where: `svg > ${token.name}`,
      key: token.name,
      label,
      value: display,
      ...(hex ? { hex } : {}),
      size: end - start,
      sensitivity: 'low',
      removal: 'with-container',
    })
  }
  if (fields.length) blocks.push({ id: 'title', label: 'Título y descripción', removableIn: 'light', fields })
}

/** Bloque `comments`: comentarios `<!-- … -->` e instrucciones `<?…?>` (salvo `<?xml?>`). */
function collectComments(bytes: Uint8Array, tokens: SvgToken[], blocks: MetadataBlock[], entries: MetaEntry[]): void {
  const fields: MetadataField[] = []
  for (const token of tokens) {
    if (token.kind === 'comment') {
      const { value, hex } = textOrHex(bytes.subarray(token.start + 4, token.end - 3))
      const display = value || 'Presente'
      fields.push({ name: 'Comentario', value: display, sensitivity: 'low' })
      entries.push({
        where: 'comentario XML',
        key: 'COMMENT',
        label: 'Comentario',
        value: display,
        ...(hex ? { hex } : {}),
        size: token.end - token.start,
        sensitivity: 'low',
        removal: 'with-container',
      })
    } else if (token.kind === 'pi' && token.name.toLowerCase() !== 'xml') {
      const { value, hex } = textOrHex(bytes.subarray(token.start + 2, token.end - 2))
      const display = value || 'Presente'
      fields.push({ name: 'Instrucción de procesamiento', value: display, sensitivity: 'low' })
      entries.push({
        where: 'instrucción <?…?>',
        key: token.name || 'PI',
        label: 'Instrucción de procesamiento',
        value: display,
        ...(hex ? { hex } : {}),
        size: token.end - token.start,
        sensitivity: 'low',
        removal: 'with-container',
      })
    }
  }
  if (fields.length) blocks.push({ id: 'comments', label: 'Comentarios e instrucciones', removableIn: 'light', fields })
}

/** Bloque `editor`: atributos/namespaces y elementos propios del editor. */
function collectEditor(tokens: SvgToken[], pairs: Map<number, number>, blocks: MetadataBlock[], entries: MetaEntry[]): void {
  const fields: MetadataField[] = []
  for (const token of tokens) {
    if (token.kind !== 'start' && token.kind !== 'self') continue
    for (const attr of token.attrs) {
      if (!isEditorAttr(attr.name)) continue
      const known = EDITOR_ATTR_LABELS[attr.name]
      const label = known?.label
      const sensitivity = known?.sensitivity ?? 'medium'
      fields.push({ name: label ?? attr.name, value: attr.value || 'Presente', sensitivity })
      entries.push({
        where: `atributo @${attr.name}`,
        key: attr.name,
        label,
        value: attr.value,
        size: attr.end - attr.start,
        sensitivity,
        removal: 'with-container',
      })
    }
  }
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]
    if ((token.kind !== 'start' && token.kind !== 'self') || !isEditorElement(token.name)) continue
    const [start, end] = elementRange(tokens, pairs, t)
    fields.push({ name: token.name, value: 'Presente', sensitivity: 'medium' })
    entries.push({
      where: `svg > ${token.name}`,
      key: token.name,
      label: 'Elemento del editor',
      value: 'Presente',
      size: end - start,
      sensitivity: 'medium',
      removal: 'with-container',
    })
  }
  if (fields.length) blocks.push({ id: 'editor', label: 'Datos del editor', removableIn: 'light', fields })
}

/** Bloque `format`: datos estructurales de la raíz (`never`, se conservan). */
function collectFormat(tokens: SvgToken[], blocks: MetadataBlock[], entries: MetaEntry[]): void {
  const root = tokens.find((token) => (token.kind === 'start' || token.kind === 'self') && (token.name === 'svg' || token.name === 'svg:svg'))
  if (!root) return
  const fields: MetadataField[] = []
  const push = (attrName: string, fieldName: string): void => {
    const attr = root.attrs.find((candidate) => candidate.name === attrName)
    if (!attr || !attr.value) return
    const value = cleanText(attr.value)
    fields.push({ name: fieldName, value, sensitivity: 'low', removableIn: 'never' })
    entries.push({ where: 'svg', key: attrName, label: fieldName, value, sensitivity: 'low', removal: 'never' })
  }
  push('width', 'Ancho')
  push('height', 'Alto')
  push('viewBox', 'viewBox')
  push('version', 'Versión SVG')
  if (fields.length) blocks.push({ id: 'format', label: 'Formato del SVG', removableIn: 'never', fields })
}

/** Constituye el report con `count` correcto (o el report vacío reutilizable). */
function toReport(blocks: MetadataBlock[], entries: MetaEntry[]): MetadataReport {
  if (!blocks.length && !entries.length) return EMPTY_REPORT
  const fields = blocks.flatMap((block) => block.fields)
  return { fields, count: fields.length, blocks, entries }
}

/** Escaneo SVG: enumera metadata, título/descripción, comentarios, editor y formato. */
function scanSvg(bytes: Uint8Array): MetadataReport {
  if (bytes.length === 0 || !isWellFormed(bytes)) return EMPTY_REPORT
  const tokens = tokenize(bytes)
  if (!tokens) return EMPTY_REPORT
  const pairs = matchElements(tokens)
  const blocks: MetadataBlock[] = []
  const entries: MetaEntry[] = []
  collectMetadata(bytes, tokens, pairs, blocks, entries)
  collectTitles(bytes, tokens, pairs, blocks, entries)
  collectComments(bytes, tokens, blocks, entries)
  collectEditor(tokens, pairs, blocks, entries)
  collectFormat(tokens, blocks, entries)
  return toReport(blocks, entries)
}

/* ── Limpieza ── */

/** Borrado quirúrgico por bloques; el resto del documento conserva sus bytes exactos. */
function stripSvg(bytes: Uint8Array, config: StripConfig): Uint8Array {
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  if (!isWellFormed(bytes)) return bytes.slice()
  const tokens = tokenize(bytes)
  if (!tokens) return bytes.slice()
  const pairs = matchElements(tokens)
  const regions: Array<[number, number]> = []
  const want = (block: string): boolean => config.mode === 'deep' || config.blocks.includes(block)

  if (want('metadata')) {
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t]
      if ((token.kind === 'start' || token.kind === 'self') && token.name === 'metadata') regions.push(elementRange(tokens, pairs, t))
    }
  }
  if (want('title')) {
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t]
      if ((token.kind === 'start' || token.kind === 'self') && (token.name === 'title' || token.name === 'desc')) regions.push(elementRange(tokens, pairs, t))
    }
  }
  if (want('comments')) {
    for (const token of tokens) {
      if (token.kind === 'comment') regions.push([token.start, token.end])
      else if (token.kind === 'pi' && token.name.toLowerCase() !== 'xml') regions.push([token.start, token.end])
    }
  }
  if (want('editor')) {
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t]
      if (token.kind !== 'start' && token.kind !== 'self') continue
      if (isEditorElement(token.name)) regions.push(elementRange(tokens, pairs, t))
      for (const attr of token.attrs) {
        if (isEditorAttr(attr.name)) regions.push([attr.start, attr.end])
      }
    }
  }
  return removeRegions(bytes, regions)
}

/* ── Dominio ── */

/** Dominio SVG de "Eliminar metadata": escaneo y limpieza quirúrgica byte a byte. */
export const svgDomain: MetaDomain = {
  kinds: ['svg'],
  scan: async (bytes: Uint8Array): Promise<MetadataReport> => {
    try {
      return scanSvg(bytes)
    } catch {
      // Ante cualquier fallo de parseo, nunca lanzamos: report vacío.
      return EMPTY_REPORT
    }
  },
  strip: async (bytes: Uint8Array, _kind, config: StripConfig, report): Promise<Uint8Array> => {
    report('Limpiando metadata del SVG', 50)
    try {
      return stripSvg(bytes, config)
    } catch {
      // SVG no interpretable: passthrough de los mismos bytes.
      return bytes.slice()
    }
  },
}
