/**
 * ADEI-ONE — Dominio HTML de "Eliminar metadata" (`meta.strip`).
 *
 * Contrato en `domain.ts`: cirugía PURA sobre los bytes del documento (Node-
 * testable, sin DOM ni re-serialización). El escaneo y la limpieza localizan
 * los tramos de metadata y los recortan, de modo que TODO lo demás conserva
 * sus bytes, espacios y saltos de línea exactos.
 *
 * Bloques (los ids que envía el wizard en `blocks`):
 * - 'meta'   → etiquetas `<meta>` que cargan metadata (`name`/`property`/
 *              `itemprop` con su `content`).
 * - 'links'  → `<link rel="author|me|publisher">`.
 * - 'format' → datos técnicos del documento (`doctype`, `charset`, `viewport`);
 *              NUNCA se borran (`removal: 'never'`).
 *
 * Reglas de seguridad (no negociables):
 * - NUNCA se toca lo funcional: `<meta charset>`, cualquier `<meta http-equiv>`
 *   y `<meta name="viewport">`. Quitarlos rompe la página (codificación,
 *   compatibilidad, escalado móvil).
 * - El escáner es CIEGO a regiones no-etiqueta: ignora el contenido de
 *   `<script>…</script>`, `<style>…</style>` y los comentarios `<!-- … -->`.
 *   También trata como opacos los elementos RCDATA (`<title>`, `<textarea>`) y
 *   RAWTEXT (`<xmp>`, `<noscript>` y, de forma conservadora, `<plaintext>`,
 *   tras el cual TODO el resto del documento es texto). Un `<meta` dentro de
 *   una cadena de JavaScript, de una regla CSS, de un comentario o del texto de
 *   esos elementos NO es una etiqueta. Si una de esas regiones no termina, se
 *   aborta el escaneo (passthrough seguro) en vez de adivinar.
 * - Las etiquetas multilínea se eliminan ENTERAS (el tramo va del `<` al `>`
 *   final, abarcando los saltos y la indentación internos).
 *
 * Preservación de bytes: se recorta EXACTAMENTE el tramo de cada etiqueta
 * eliminada y se re-ensamblan los slices restantes. No se toca la indentación
 * ni los saltos de línea que rodean la etiqueta, para que el "resto" del
 * documento quede byte a byte idéntico.
 *
 * Semántica de modo (ver `domain.ts`): en `light` solo se eliminan los bloques
 * pedidos (lista vacía = passthrough byte a byte); en `deep` se eliminan todos.
 * Nunca lanza: un HTML que no se puede interpretar pasa tal cual.
 *
 * Fuera de alcance (documentado, no se hace): `<title>` es obligatorio y visible
 * en la pestaña; los comentarios pueden ser funcionales (`<!--[if IE]>`,
 * marcadores de hidratación), así que no se tocan. En HTML no hay nada que
 * regenerar: el modo Profundo se comporta como el Ligero.
 */
import { concat } from './chunks'
import { EMPTY_REPORT } from './domain'
import type { MetaDomain, StripConfig } from './domain'
import type { MetadataBlock, MetadataField, MetadataReport, MetaEntry } from '@/core/types'

const UTF8 = new TextDecoder('utf-8')

/* ── Utilidades de bytes (mismo estilo que `svg.ts`) ── */

const BYTE_LT = 0x3c // '<'
const BYTE_GT = 0x3e // '>'
const BYTE_SLASH = 0x2f // '/'
const BYTE_EQ = 0x3d // '='
const BYTE_DQUOTE = 0x22 // '"'
const BYTE_SQUOTE = 0x27 // "'"
const BYTE_EXCL = 0x21 // '!'
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

/** ¿Los bytes en `pos` son el texto `text` ignorando mayúsculas/minúsculas? */
function matchesCI(bytes: Uint8Array, pos: number, text: string): boolean {
  if (pos < 0 || pos + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i++) {
    let byte = bytes[pos + i]
    if (byte >= 0x41 && byte <= 0x5a) byte += 0x20
    if (byte !== text.charCodeAt(i)) return false
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

/** Limpia un valor de texto para mostrarlo (sin saltos largos ni binario). */
function cleanText(value: string, max = 200): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/* ── Tokenizador de etiquetas HTML sobre bytes ── */

type HtmlTagKind = 'start' | 'end' | 'comment' | 'doctype'

/** Sección del documento en la que vive una etiqueta (contexto real del `where`). */
type HtmlSection = 'head' | 'body' | 'document'

/** Atributo de una etiqueta con su tramo exacto de bytes. */
interface HtmlAttr {
  /** Nombre en minúsculas (HTML no distingue mayúsculas). */
  name: string
  value: string
  start: number
  end: number
}

/** Etiqueta o construcción del documento, con su tramo de bytes. */
interface HtmlTag {
  kind: HtmlTagKind
  /** Nombre en minúsculas; vacío en comentarios y declaraciones. */
  name: string
  start: number
  /** Índice final exclusivo (justo tras el `>`). */
  end: number
  attrs: HtmlAttr[]
  selfClosing: boolean
  /** Sección vigente al abrir la etiqueta (`head`/`body`/`document`). */
  section: HtmlSection
}

/** Parsea `<nombre attr="valor" …>` y devuelve nombre + atributos con su tramo. */
function parseStartTag(bytes: Uint8Array, start: number, end: number): { name: string; attrs: HtmlAttr[]; selfClosing: boolean } | null {
  let i = start + 1
  const nameStart = i
  while (i < end - 1 && !isSpace(bytes[i]) && bytes[i] !== BYTE_SLASH && bytes[i] !== BYTE_GT) i++
  const name = UTF8.decode(bytes.subarray(nameStart, i)).toLowerCase()
  if (!name) return null
  const attrs: HtmlAttr[] = []
  while (i < end - 1) {
    const wsStart = i
    while (i < end - 1 && isSpace(bytes[i])) i++
    if (i >= end - 1) break
    if (bytes[i] === BYTE_SLASH) break // autocierre
    const attrStart = i
    while (i < end - 1 && !isSpace(bytes[i]) && bytes[i] !== BYTE_EQ && bytes[i] !== BYTE_SLASH && bytes[i] !== BYTE_GT) i++
    const attrName = UTF8.decode(bytes.subarray(attrStart, i)).toLowerCase()
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
        while (i < end - 1 && !isSpace(bytes[i]) && bytes[i] !== BYTE_GT) i++
        attrValue = UTF8.decode(bytes.subarray(valueStart, i))
      }
    }
    if (attrName) attrs.push({ name: attrName, value: attrValue, start: wsStart, end: i })
  }
  return { name, attrs, selfClosing: bytes[end - 2] === BYTE_SLASH }
}

/**
 * Índice tras el `>` de la etiqueta de cierre de un elemento de texto crudo
 * (`</script>`, `</style>`, `</title>`, `</textarea>`, `</xmp>`, `</noscript>`),
 * desde `from`. -1 si no aparece (región sin cerrar).
 */
function findRawTextEnd(bytes: Uint8Array, from: number, name: string): number {
  const needle = `</${name}`
  const limit = bytes.length - needle.length
  for (let i = from; i <= limit; i++) {
    if (!matchesCI(bytes, i, needle)) continue
    const after = i + needle.length
    if (after < bytes.length && !isSpace(bytes[after]) && bytes[after] !== BYTE_GT) continue
    return findTagEnd(bytes, after)
  }
  return -1
}

/** Elementos cuyo contenido es texto, no markup: se saltan hasta su cierre. */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'title', // RCDATA
  'textarea', // RCDATA
  'xmp', // RAWTEXT
  'noscript', // RAWTEXT (conservador: nunca se interpreta su interior)
])

/**
 * Tokeniza el documento en etiquetas/comentarios/declaraciones con sus tramos.
 * Es CIEGO al contenido de los elementos de texto crudo (RCDATA/RAWTEXT) y a los
 * comentarios. Anota en cada etiqueta la sección (`head`/`body`/`document`) en la
 * que vive, para reportar rutas `where` honestas. Devuelve `null` si algo no
 * cierra (input no interpretable): el llamante hace passthrough seguro.
 */
function tokenize(bytes: Uint8Array): HtmlTag[] | null {
  const tokens: HtmlTag[] = []
  let section: HtmlSection = 'document'
  let i = 0
  while (i < bytes.length) {
    while (i < bytes.length && bytes[i] !== BYTE_LT) i++
    if (i >= bytes.length) break
    if (matches(bytes, i, '<!--')) {
      const close = indexOfSeq(bytes, i + 4, '-->')
      if (close < 0) return null
      tokens.push({ kind: 'comment', name: '', start: i, end: close + 3, attrs: [], selfClosing: false, section })
      i = close + 3
      continue
    }
    if (bytes[i + 1] === BYTE_EXCL) {
      const end = findDeclarationEnd(bytes, i + 2)
      if (end < 0) return null
      tokens.push({ kind: 'doctype', name: '', start: i, end, attrs: [], selfClosing: false, section })
      i = end
      continue
    }
    if (bytes[i + 1] === BYTE_SLASH) {
      const end = findTagEnd(bytes, i + 2)
      if (end < 0) return null
      const name = UTF8.decode(bytes.subarray(i + 2, end - 1)).trim().toLowerCase()
      tokens.push({ kind: 'end', name, start: i, end, attrs: [], selfClosing: false, section })
      if (name === 'head' || name === 'body') section = 'document'
      i = end
      continue
    }
    const end = findTagEnd(bytes, i + 1)
    if (end < 0) return null
    const parsed = parseStartTag(bytes, i, end)
    if (!parsed) return null
    tokens.push({ kind: 'start', name: parsed.name, start: i, end, attrs: parsed.attrs, selfClosing: parsed.selfClosing, section })
    if (!parsed.selfClosing && parsed.name === 'head') section = 'head'
    else if (!parsed.selfClosing && parsed.name === 'body') section = 'body'
    if (!parsed.selfClosing && RAW_TEXT_ELEMENTS.has(parsed.name)) {
      // Texto crudo (RCDATA/RAWTEXT): se salta TODO el contenido hasta su cierre.
      // Un `<meta` ahí dentro no es una etiqueta y jamás se reporta ni se borra.
      const close = findRawTextEnd(bytes, end, parsed.name)
      if (close < 0) return null
      i = close
      continue
    }
    if (!parsed.selfClosing && parsed.name === 'plaintext') {
      // `<plaintext>`: TODO lo que sigue es texto. El resto del documento queda
      // opaco; se deja de tokenizar (lo anterior ya quedó registrado).
      i = bytes.length
      continue
    }
    i = end
  }
  return tokens
}

/* ── Predicados compartidos por escaneo y limpieza ── */

/** Valor de un atributo (o undefined). */
function attrValue(tag: HtmlTag, name: string): string | undefined {
  const found = tag.attrs.find((attr) => attr.name === name)
  return found ? found.value : undefined
}

/** ¿Tiene el atributo (aunque venga sin valor)? */
function hasAttr(tag: HtmlTag, name: string): boolean {
  return tag.attrs.some((attr) => attr.name === name)
}

/**
 * Ruta `where` honesta: antepone la sección real (`head`/`body`) cuando se
 * conoce; fuera de ellas deja solo el selector, sin afirmar `head`.
 */
function wherePath(section: HtmlSection, selector: string): string {
  return section === 'document' ? selector : `${section} > ${selector}`
}

/**
 * ¿Es una etiqueta `<meta>` FUNCIONAL (intocable)? Se conservan siempre:
 * `charset`, cualquier `http-equiv` y `name="viewport"`. Ante la duda, se
 * conserva.
 */
function isFunctionalMeta(tag: HtmlTag): boolean {
  if (hasAttr(tag, 'charset')) return true
  if (hasAttr(tag, 'http-equiv')) return true
  const name = attrValue(tag, 'name')
  return name !== undefined && name.trim().toLowerCase() === 'viewport'
}

/** Clave de metadata de un `<meta>`: `name`/`property`/`itemprop` (el primero con valor). */
function metaKey(tag: HtmlTag): { key: string; keyAttr: string } | null {
  for (const keyAttr of ['name', 'property', 'itemprop']) {
    const value = attrValue(tag, keyAttr)
    if (value !== undefined && value.trim() !== '') return { key: value, keyAttr }
  }
  return null
}

/** Relaciones de enlace que cargan metadata de autoría/editor. */
const LINK_RELS: ReadonlySet<string> = new Set(['author', 'me', 'publisher'])

/** Relación de metadata de un `<link>` (o undefined). */
function linkRel(tag: HtmlTag): string | undefined {
  const rel = attrValue(tag, 'rel')
  if (rel === undefined) return undefined
  return rel
    .split(/\s+/)
    .map((token) => token.toLowerCase())
    .find((token) => LINK_RELS.has(token))
}

/** Sensibilidad orientativa por clave de metadata. */
function sensitivityOf(key: string): MetadataField['sensitivity'] {
  return /author|creator/i.test(key) ? 'medium' : 'low'
}

/* ── Escaneo ── */

/** Bloques `meta`: cada `<meta>` de metadata con su clave y su `content`. */
function collectMetas(tokens: HtmlTag[], blocks: MetadataBlock[], entries: MetaEntry[]): void {
  const fields: MetadataField[] = []
  for (const tag of tokens) {
    if (tag.kind !== 'start' || tag.name !== 'meta') continue
    if (isFunctionalMeta(tag)) continue
    const meta = metaKey(tag)
    if (!meta) continue
    const value = cleanText(attrValue(tag, 'content') ?? '') || 'Presente'
    const sensitivity = sensitivityOf(meta.key)
    fields.push({ name: meta.key, value, sensitivity })
    entries.push({
      where: wherePath(tag.section, `meta[${meta.keyAttr}=${meta.key}]`),
      key: meta.key,
      label: meta.key,
      value,
      size: tag.end - tag.start,
      sensitivity,
      removal: 'with-container',
    })
  }
  if (fields.length) blocks.push({ id: 'meta', label: 'Metadatos <meta>', removableIn: 'light', fields })
}

/** Bloque `links`: `<link rel="author|me|publisher">`. */
function collectLinks(tokens: HtmlTag[], blocks: MetadataBlock[], entries: MetaEntry[]): void {
  const fields: MetadataField[] = []
  for (const tag of tokens) {
    if (tag.kind !== 'start' || tag.name !== 'link') continue
    const rel = linkRel(tag)
    if (!rel) continue
    const value = cleanText(attrValue(tag, 'href') ?? '') || 'Presente'
    fields.push({ name: `rel="${rel}"`, value, sensitivity: 'medium' })
    entries.push({
      where: wherePath(tag.section, `link[rel=${rel}]`),
      key: `rel:${rel}`,
      label: `Enlace de autoría (${rel})`,
      value,
      size: tag.end - tag.start,
      sensitivity: 'medium',
      removal: 'with-container',
    })
  }
  if (fields.length) blocks.push({ id: 'links', label: 'Enlaces de autoría', removableIn: 'light', fields })
}

/** Charset declarado en el documento (`<meta charset>` o `http-equiv` Content-Type). */
function detectCharset(tokens: HtmlTag[]): string | undefined {
  for (const tag of tokens) {
    if (tag.kind !== 'start' || tag.name !== 'meta') continue
    const charset = attrValue(tag, 'charset')
    if (charset && charset.trim() !== '') return charset.trim()
    const equiv = attrValue(tag, 'http-equiv')
    if (equiv && equiv.trim().toLowerCase() === 'content-type') {
      const content = attrValue(tag, 'content')
      const match = content ? /charset\s*=\s*([^;"\s]+)/i.exec(content) : null
      if (match) return match[1]
    }
  }
  return undefined
}

/** Bloque `format`: doctype, charset y presencia de viewport (`never`, se conservan). */
function collectFormat(bytes: Uint8Array, tokens: HtmlTag[], blocks: MetadataBlock[], entries: MetaEntry[]): void {
  const fields: MetadataField[] = []
  const doctype = tokens.find((tag) => tag.kind === 'doctype')
  if (doctype) {
    const value = cleanText(UTF8.decode(bytes.subarray(doctype.start, doctype.end))) || 'Presente'
    const preservedNote = 'Se conserva: es la declaración estructural del documento.'
    fields.push({ name: 'Tipo de documento', value, sensitivity: 'low', removableIn: 'never' })
    entries.push({ where: 'documento', key: 'doctype', label: 'Tipo de documento', value, sensitivity: 'low', removal: 'never', preservedNote })
  }
  const charset = detectCharset(tokens)
  if (charset) {
    const preservedNote = 'Se conserva: quitarlo rompe la codificación de la página.'
    fields.push({ name: 'Juego de caracteres', value: charset, sensitivity: 'low', removableIn: 'never' })
    entries.push({ where: 'head > meta[charset]', key: 'charset', label: 'Juego de caracteres', value: charset, sensitivity: 'low', removal: 'never', preservedNote })
  }
  const hasViewport = tokens.some(
    (tag) => tag.kind === 'start' && tag.name === 'meta' && (attrValue(tag, 'name') ?? '').trim().toLowerCase() === 'viewport',
  )
  const viewportValue = hasViewport ? 'Sí' : 'No'
  const viewportNote = hasViewport
    ? 'Se conserva: quitarlo rompe el escalado en móvil.'
    : 'No se detectó una etiqueta viewport.'
  fields.push({ name: 'Viewport', value: viewportValue, sensitivity: 'low', removableIn: 'never' })
  entries.push({ where: 'cabecera', key: 'viewport', label: 'Viewport', value: viewportValue, sensitivity: 'low', removal: 'never', preservedNote: viewportNote })
  blocks.push({ id: 'format', label: 'Formato del documento', removableIn: 'never', fields })
}

/** Constituye el report con `count` correcto (o el report vacío reutilizable). */
function toReport(blocks: MetadataBlock[], entries: MetaEntry[]): MetadataReport {
  if (!blocks.length && !entries.length) return EMPTY_REPORT
  const fields = blocks.flatMap((block) => block.fields)
  return { fields, count: fields.length, blocks, entries }
}

/** Escaneo HTML: `<meta>` de metadata, enlaces de autoría y bloque `format`. */
function scanHtml(bytes: Uint8Array): MetadataReport {
  if (bytes.length === 0) return EMPTY_REPORT
  const tokens = tokenize(bytes)
  if (!tokens) return EMPTY_REPORT
  const blocks: MetadataBlock[] = []
  const entries: MetaEntry[] = []
  collectMetas(tokens, blocks, entries)
  collectLinks(tokens, blocks, entries)
  collectFormat(bytes, tokens, blocks, entries)
  return toReport(blocks, entries)
}

/* ── Limpieza ── */

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

/**
 * Borrado quirúrgico de las etiquetas seleccionadas; el resto del documento
 * conserva sus bytes exactos. Los bloques funcionales (`format`) nunca entran.
 */
function stripHtml(bytes: Uint8Array, config: StripConfig): Uint8Array {
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  const tokens = tokenize(bytes)
  if (!tokens) return bytes.slice()
  const want = (block: string): boolean => config.mode === 'deep' || config.blocks.includes(block)
  const regions: Array<[number, number]> = []

  if (want('meta')) {
    for (const tag of tokens) {
      if (tag.kind !== 'start' || tag.name !== 'meta') continue
      if (isFunctionalMeta(tag)) continue
      if (!metaKey(tag)) continue
      regions.push([tag.start, tag.end])
    }
  }
  if (want('links')) {
    for (const tag of tokens) {
      if (tag.kind !== 'start' || tag.name !== 'link') continue
      if (!linkRel(tag)) continue
      regions.push([tag.start, tag.end])
    }
  }
  return removeRegions(bytes, regions)
}

/* ── Dominio ── */

/** Dominio HTML de "Eliminar metadata": escaneo y limpieza quirúrgica byte a byte. */
export const htmlDomain: MetaDomain = {
  kinds: ['html'],
  scan: async (bytes: Uint8Array): Promise<MetadataReport> => {
    try {
      return scanHtml(bytes)
    } catch {
      // Ante cualquier fallo de interpretación, nunca lanzamos: report vacío.
      return EMPTY_REPORT
    }
  },
  strip: async (bytes: Uint8Array, _kind, config: StripConfig, report): Promise<Uint8Array> => {
    report('Limpiando metadata del HTML', 50)
    try {
      return stripHtml(bytes, config)
    } catch {
      // HTML no interpretable: passthrough de los mismos bytes.
      return bytes.slice()
    }
  },
}
