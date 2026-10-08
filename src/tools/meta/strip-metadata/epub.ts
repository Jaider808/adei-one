/**
 * ADEI-ONE — Dominio EPUB de "Eliminar metadata" (`meta.strip`).
 *
 * Un EPUB es un ZIP con `mimetype` primero y almacenado, `META-INF/container.xml`
 * (que apunta al OPF mediante `<rootfile full-path="…">`), el OPF (paquete con
 * `<metadata>`: `dc:creator`, `dc:publisher`, `dc:date`, `meta name="calibre:*"`…)
 * y, a veces, sidecars de posición de lectura o tienda
 * (`META-INF/calibre_bookmarks.txt`, `iTunesMetadata.plist`, `iTunesArtwork`).
 *
 * Bloques (los ids que envía el wizard en `blocks`):
 * - 'metadata' → cirugía sobre el TEXTO del OPF (byte a byte, sin re-serializar
 *                el documento): se eliminan los campos personales/opcionales y se
 *                normalizan los obligatorios. `dc:identifier`, `dc:title` y
 *                `dc:language` se CONSERVAN; `dc:date` (EPUB 2) y
 *                `meta property="dcterms:modified"` (EPUB 3) se normalizan a una
 *                fecha neutra en vez de borrarse. `<manifest>`, `<spine>`,
 *                `<guide>` y `<meta name="cover">` no se tocan.
 * - 'sidecars' → elimina las entradas de posición de lectura / tienda.
 * - 'format'   → versión EPUB, ruta del OPF y nº de entradas; NUNCA se borran
 *                (`removal: 'never'`).
 *
 * Semántica de modo (ver `domain.ts`): en `light` solo se eliminan los bloques
 * pedidos (lista vacía = passthrough byte a byte); en `deep` se eliminan todos.
 * Nunca lanza: un ZIP, `container.xml` u OPF no interpretable pasa tal cual.
 */
import { XMLValidator } from 'fast-xml-parser'
import { EMPTY_REPORT, shortHex } from './domain'
import { MIMETYPE_ENTRY, readZip, writeZip } from './zipdoc'
import type { ZipEntries } from './zipdoc'
import type { MetaDomain, StripConfig } from './domain'
import type { MetadataBlock, MetadataField, MetadataReport, MetaEntry, MetaRemoval } from '@/core/types'

const UTF8_DECODER = new TextDecoder('utf-8')
const UTF8_ENCODER = new TextEncoder()

function textOf(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes)
}

function utf8(text: string): Uint8Array {
  return UTF8_ENCODER.encode(text)
}

/** Texto seguro para un campo (sin saltos largos). */
function txt(value: string, max = 400): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** Valor legible de bytes: texto UTF-8 limpio o `hex` si parece binario. */
function textOrHex(raw: Uint8Array): { value: string; hex?: string } {
  const decoded = textOf(raw)
  if (decoded.includes('\uFFFD') || decoded.includes('\u0000')) return { value: '', hex: shortHex(raw) }
  const value = txt(decoded)
  if (!value && raw.length) return { value: '', hex: shortHex(raw) }
  return { value }
}

/* ── Tokenizador XML sobre el texto del OPF ── */

type TokenKind = 'start' | 'end' | 'self' | 'comment' | 'pi' | 'cdata' | 'doctype'

interface XmlAttr {
  name: string
  value: string
  /** Tramo [inicio, fin) del valor en el texto (para cirugía byte a byte). */
  valueStart: number
  valueEnd: number
}

interface XmlToken {
  kind: TokenKind
  /** Nombre cualificado (`dc:creator`, `meta`, `package`…); vacío en comentarios. */
  name: string
  start: number
  /** Índice final exclusivo (justo tras el `>` de cierre). */
  end: number
  attrs: XmlAttr[]
}

/** Nombre local de un nombre cualificado (`dc:creator` → `creator`). */
function localName(name: string): string {
  const idx = name.lastIndexOf(':')
  return idx < 0 ? name : name.slice(idx + 1)
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

/** Índice tras el `>` de una etiqueta, respetando comillas. -1 si no cierra. */
function findTagEnd(text: string, from: number): number {
  let quote = ''
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '>') return i + 1
  }
  return -1
}

/** Índice tras el `>` de una declaración `<!…>`, respetando `[…]` y comillas. */
function findDeclarationEnd(text: string, from: number): number {
  let quote = ''
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '[') {
      depth++
      continue
    }
    if (ch === ']') {
      if (depth > 0) depth--
      continue
    }
    if (ch === '>' && depth === 0) return i + 1
  }
  return -1
}

/** Parsea `<nombre attr="valor" …>` y devuelve nombre + atributos. */
function parseStartTag(text: string, start: number, end: number): { name: string; attrs: XmlAttr[] } | null {
  let i = start + 1
  const nameStart = i
  while (i < end - 1 && !isSpace(text[i]) && text[i] !== '/' && text[i] !== '>') i++
  const name = text.slice(nameStart, i)
  if (!name) return null
  const attrs: XmlAttr[] = []
  while (i < end - 1) {
    while (i < end - 1 && isSpace(text[i])) i++
    if (i >= end - 1) break
    if (text[i] === '/') break // autocierre
    const attrStart = i
    while (i < end - 1 && !isSpace(text[i]) && text[i] !== '=' && text[i] !== '/' && text[i] !== '>') i++
    const attrName = text.slice(attrStart, i)
    while (i < end - 1 && isSpace(text[i])) i++
    let attrValue = ''
    let valueStart = i
    let valueEnd = i
    if (text[i] === '=') {
      i++
      while (i < end - 1 && isSpace(text[i])) i++
      const quote = text[i]
      if (quote === '"' || quote === "'") {
        i++
        valueStart = i
        while (i < end - 1 && text[i] !== quote) i++
        valueEnd = i
        attrValue = text.slice(valueStart, valueEnd)
        if (i < end - 1) i++ // cierre de comilla
      } else {
        valueStart = i
        while (i < end - 1 && !isSpace(text[i]) && text[i] !== '/' && text[i] !== '>') i++
        valueEnd = i
        attrValue = text.slice(valueStart, valueEnd)
      }
    }
    if (attrName) attrs.push({ name: attrName, value: attrValue, valueStart, valueEnd })
  }
  return { name, attrs }
}

/** Tokeniza el documento en etiquetas/comentarios/PI con sus tramos. null si no cierra. */
function tokenize(text: string): XmlToken[] | null {
  const tokens: XmlToken[] = []
  let i = 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt < 0) break
    i = lt
    if (text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4)
      if (close < 0) return null
      tokens.push({ kind: 'comment', name: '', start: i, end: close + 3, attrs: [] })
      i = close + 3
    } else if (text.startsWith('<![CDATA[', i)) {
      const close = text.indexOf(']]>', i + 9)
      if (close < 0) return null
      tokens.push({ kind: 'cdata', name: '', start: i, end: close + 3, attrs: [] })
      i = close + 3
    } else if (text.startsWith('<!', i)) {
      const end = findDeclarationEnd(text, i + 2)
      if (end < 0) return null
      tokens.push({ kind: 'doctype', name: '', start: i, end, attrs: [] })
      i = end
    } else if (text.startsWith('<?', i)) {
      const close = text.indexOf('?>', i + 2)
      if (close < 0) return null
      const inner = text.slice(i + 2, close).trim()
      const name = inner.split(/\s+/)[0] ?? ''
      tokens.push({ kind: 'pi', name, start: i, end: close + 2, attrs: [] })
      i = close + 2
    } else if (text[i + 1] === '/') {
      const end = findTagEnd(text, i + 2)
      if (end < 0) return null
      const name = text.slice(i + 2, end - 1).trim()
      tokens.push({ kind: 'end', name, start: i, end, attrs: [] })
      i = end
    } else {
      const end = findTagEnd(text, i + 1)
      if (end < 0) return null
      const self = text[end - 2] === '/'
      const parsed = parseStartTag(text, i, end)
      if (!parsed) return null
      tokens.push({ kind: self ? 'self' : 'start', name: parsed.name, start: i, end, attrs: parsed.attrs })
      i = end
    }
  }
  return tokens
}

/** Empareja cada etiqueta de apertura con su cierre (índices de token). */
function matchElements(tokens: XmlToken[]): Map<number, number> {
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

/** Índice final exclusivo del elemento completo (autocierre o apertura+cierre). */
function elementEnd(tokens: XmlToken[], pairs: Map<number, number>, index: number): number {
  const token = tokens[index]
  if (token.kind === 'self') return token.end
  const close = pairs.get(index)
  return close === undefined ? token.end : tokens[close].end
}

/** Texto interno del elemento (vacío si es autocerrado o no se puede emparejar). */
function innerTextOf(tokens: XmlToken[], pairs: Map<number, number>, index: number, text: string): string {
  const token = tokens[index]
  if (token.kind === 'self') return ''
  const close = pairs.get(index)
  if (close === undefined) return ''
  return text.slice(token.end, tokens[close].start)
}

/** Valor de un atributo (comparación de nombre sin distinguir mayúsculas). */
function attrValue(token: XmlToken, name: string): string | undefined {
  const attr = token.attrs.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())
  return attr?.value
}

/** Tramo [inicio, fin) del valor de un atributo (para sustituirlo sin tocar el resto). */
function attrValueSpan(token: XmlToken, name: string): { start: number; end: number } | null {
  const attr = token.attrs.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase())
  return attr ? { start: attr.valueStart, end: attr.valueEnd } : null
}

/* ── Clasificación de metadata ── */

/** Campos personales/opcionales del `<metadata>` del OPF (se eliminan). */
const PERSONAL_LOCALS: ReadonlySet<string> = new Set([
  'creator',
  'contributor',
  'publisher',
  'subject',
  'description',
  'rights',
  'source',
  'coverage',
])

/** Etiquetas legibles de los elementos `dc:*` del OPF. */
const EPUB_LOCAL_LABELS: Record<string, { label: string; sensitivity: MetadataField['sensitivity'] }> = {
  creator: { label: 'Autor', sensitivity: 'medium' },
  contributor: { label: 'Colaborador', sensitivity: 'medium' },
  publisher: { label: 'Editorial', sensitivity: 'medium' },
  subject: { label: 'Asunto', sensitivity: 'low' },
  description: { label: 'Descripción', sensitivity: 'low' },
  rights: { label: 'Derechos', sensitivity: 'low' },
  source: { label: 'Fuente', sensitivity: 'low' },
  coverage: { label: 'Cobertura', sensitivity: 'low' },
  identifier: { label: 'Identificador', sensitivity: 'low' },
  title: { label: 'Título', sensitivity: 'low' },
  language: { label: 'Idioma', sensitivity: 'low' },
  date: { label: 'Fecha', sensitivity: 'medium' },
}

/** Entradas sidecar de posición de lectura / tienda que elimina el bloque `sidecars`. */
const SIDECAR_NAMES: ReadonlySet<string> = new Set([
  'META-INF/calibre_bookmarks.txt',
  'iTunesMetadata.plist',
  'iTunesArtwork',
])

function isSidecar(name: string): boolean {
  return SIDECAR_NAMES.has(name)
}

/** Fecha neutra para normalizar `dc:date` / `dcterms:modified` (nunca se borran). */
const NEUTRAL_DATE = '1970-01-01T00:00:00Z'

/** Acción del strip sobre un elemento de metadata del OPF. */
type MetaAction = 'remove' | 'neutralize' | 'keep'

interface MetaItem {
  action: MetaAction
  label: string
  sensitivity: MetadataField['sensitivity']
  where: string
  key: string
  value: string
  removal: MetaRemoval
}

/**
 * Clasifica un elemento del `<metadata>` del OPF: qué acción ejecuta el strip,
 * su etiqueta, su ruta legible y su `removal` honesto. Devuelve `null` si el
 * token no es un elemento.
 */
function classifyMetaToken(token: XmlToken, inner: string): MetaItem | null {
  if (token.kind !== 'start' && token.kind !== 'self') return null
  const local = localName(token.name)
  const nameAttr = attrValue(token, 'name')
  const propAttr = attrValue(token, 'property')

  if (local === 'meta') {
    const nameIsCalibre = nameAttr !== undefined && nameAttr.toLowerCase().startsWith('calibre:')
    const propIsCalibre = propAttr !== undefined && propAttr.toLowerCase().startsWith('calibre:')
    if (nameIsCalibre || propIsCalibre) {
      const calibreName = nameIsCalibre ? nameAttr! : propAttr!
      const suffix = calibreName.slice(calibreName.indexOf(':') + 1)
      const value = txt(attrValue(token, 'content') ?? attrValue(token, 'value') ?? inner)
      const where = nameIsCalibre
        ? `OPF > metadata > meta[@name=${calibreName}]`
        : `OPF > metadata > meta[@property=${calibreName}]`
      return {
        action: 'remove',
        label: `Calibre: ${suffix}`,
        sensitivity: 'medium',
        where,
        key: calibreName,
        value,
        removal: 'with-container',
      }
    }
    // Las fechas normalizadas se marcan `removal: 'never'` A PROPÓSITO: el
    // elemento SIGUE presente con un valor distinto, así que `verifyClean` no
    // debe contarlo como resto (`remaining`); marcarlo como borrable daría un
    // falso positivo. No "arreglarlo" a 'with-container': el valor se reescribe,
    // no se elimina. (Aplica igual a `dc:date` más abajo.)
    const isModified =
      (propAttr !== undefined && propAttr.toLowerCase() === 'dcterms:modified') ||
      (nameAttr !== undefined && nameAttr.toLowerCase() === 'dcterms:modified')
    if (isModified) {
      const where = propAttr !== undefined
        ? `OPF > metadata > meta[@property=${propAttr}]`
        : `OPF > metadata > meta[@name=${nameAttr}]`
      return {
        action: 'neutralize',
        label: 'Fecha de modificación',
        sensitivity: 'medium',
        where,
        key: 'dcterms:modified',
        value: txt(inner),
        removal: 'never',
      }
    }
    // Portada y demás `meta` (refines, title-type…): se conservan.
    const isCover = nameAttr === 'cover' || propAttr === 'cover'
    return {
      action: 'keep',
      label: isCover ? 'Portada' : nameAttr ? `meta: ${nameAttr}` : propAttr ? `meta: ${propAttr}` : 'meta',
      sensitivity: 'low',
      where: isCover ? 'OPF > metadata > meta[@name=cover]' : 'OPF > metadata > meta',
      key: nameAttr ?? propAttr ?? 'meta',
      value: txt(attrValue(token, 'content') ?? inner),
      removal: 'never',
    }
  }

  const mapped = EPUB_LOCAL_LABELS[local]
  const personal = PERSONAL_LOCALS.has(local)
  return {
    action: personal ? 'remove' : local === 'date' ? 'neutralize' : 'keep',
    label: mapped?.label ?? local,
    sensitivity: mapped?.sensitivity ?? 'low',
    where: `OPF > metadata > ${token.name}`,
    key: token.name,
    value: txt(inner),
    removal: personal ? 'with-container' : 'never',
  }
}

/* ── Localización del OPF y de `<metadata>` ── */

/** Ruta del OPF declarada por `<rootfile full-path="…">` en `container.xml`, o null. */
function locateOpf(entries: ZipEntries): string | null {
  const container = entries['META-INF/container.xml']
  if (!container) return null
  const text = textOf(container)
  if (text.includes('\uFFFD')) return null
  const match = /<rootfile\b[^>]*\bfull-path\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(text)
  const path = match?.[1] ?? match?.[2] ?? ''
  if (!path) return null
  return entries[path] ? path : null
}

interface MetadataLocation {
  tokens: XmlToken[]
  pairs: Map<number, number>
  innerStart: number
  innerEnd: number
}

/** Localiza el elemento `<metadata>` del OPF y el tramo de su contenido. */
function locateMetadata(text: string): MetadataLocation | null {
  const tokens = tokenize(text)
  if (!tokens) return null
  const pairs = matchElements(tokens)
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]
    if ((token.kind !== 'start' && token.kind !== 'self') || localName(token.name) !== 'metadata') continue
    const closeIndex = token.kind === 'self' ? undefined : pairs.get(t)
    if (token.kind === 'start' && closeIndex === undefined) return null
    return {
      tokens,
      pairs,
      innerStart: token.end,
      innerEnd: closeIndex === undefined ? token.end : tokens[closeIndex].start,
    }
  }
  return null
}

/** Versión EPUB declarada en `<package version="…">` (o undefined). */
function readPackageVersion(text: string): string | undefined {
  const match = /<package\b[^>]*\bversion\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(text)
  return match?.[1] ?? match?.[2] ?? undefined
}

/* ── Escaneo ── */

/** Escaneo EPUB: metadatos del OPF, sidecars y bloque `format`. */
function scanEpub(bytes: Uint8Array): MetadataReport {
  const entries = readZip(bytes)
  if (!entries) return EMPTY_REPORT
  const opfPath = locateOpf(entries)
  if (!opfPath) return EMPTY_REPORT
  const opfText = textOf(entries[opfPath]!)
  if (opfText.includes('\uFFFD')) return EMPTY_REPORT

  const blocks: MetadataBlock[] = []
  const inventory: MetaEntry[] = []

  // metadata: una entrada por cada elemento del `<metadata>` del OPF.
  const location = locateMetadata(opfText)
  if (location) {
    const { tokens, pairs, innerStart, innerEnd } = location
    const fields: MetadataField[] = []
    for (let t = 0; t < tokens.length; t++) {
      const token = tokens[t]
      if (token.kind !== 'start' && token.kind !== 'self') continue
      if (token.start < innerStart || token.start >= innerEnd) continue
      const inner = innerTextOf(tokens, pairs, t, opfText)
      const item = classifyMetaToken(token, inner)
      if (!item) continue
      fields.push({
        name: item.label,
        value: item.value || 'Presente',
        sensitivity: item.sensitivity,
        removableIn: item.removal === 'never' ? 'never' : 'light',
      })
      inventory.push({
        where: item.where,
        key: item.key,
        label: item.label,
        value: item.value,
        size: utf8(opfText.slice(token.start, elementEnd(tokens, pairs, t))).length,
        sensitivity: item.sensitivity,
        removal: item.removal,
      })
    }
    if (fields.length) blocks.push({ id: 'metadata', label: 'Metadatos del OPF', removableIn: 'light', fields })
  }

  // sidecars: posición de lectura / tienda.
  const sidecars = Object.keys(entries).filter(isSidecar)
  if (sidecars.length) {
    const fields: MetadataField[] = []
    for (const name of sidecars) {
      const data = entries[name]!
      const { value, hex } = textOrHex(data)
      const display = value || 'Presente'
      fields.push({ name: 'Sidecar', value: `${display} (${data.length} bytes)`, sensitivity: 'medium' })
      inventory.push({
        where: `sidecar: ${name}`,
        key: name.split('/').pop() ?? name,
        label: 'Sidecar',
        value: display,
        ...(hex ? { hex } : {}),
        size: data.length,
        sensitivity: 'medium',
        removal: 'with-container',
      })
    }
    blocks.push({ id: 'sidecars', label: 'Sidecars de lectura/tienda', removableIn: 'light', fields })
  }

  // format: datos estructurales del paquete (NUNCA se borran).
  const formatFields: MetadataField[] = []
  const mimetype = entries[MIMETYPE_ENTRY]
  if (mimetype) {
    const value = txt(textOf(mimetype))
    formatFields.push({ name: 'Tipo MIME', value, sensitivity: 'low', removableIn: 'never' })
    inventory.push({ where: MIMETYPE_ENTRY, key: MIMETYPE_ENTRY, label: 'Tipo MIME', value, sensitivity: 'low', removal: 'never' })
  }
  const version = readPackageVersion(opfText)
  if (version) {
    formatFields.push({ name: 'Versión EPUB', value: version, sensitivity: 'low', removableIn: 'never' })
    inventory.push({ where: `${opfPath} > package`, key: 'version', label: 'Versión EPUB', value: version, sensitivity: 'low', removal: 'never' })
  }
  formatFields.push({ name: 'Ruta del OPF', value: opfPath, sensitivity: 'low', removableIn: 'never' })
  inventory.push({ where: 'META-INF/container.xml', key: 'rootfile', label: 'Ruta del OPF', value: opfPath, sensitivity: 'low', removal: 'never' })
  const entryCount = String(Object.keys(entries).length)
  formatFields.push({ name: 'Entradas del paquete', value: entryCount, sensitivity: 'low', removableIn: 'never' })
  inventory.push({ where: 'ZIP', key: 'entries', label: 'Entradas del paquete', value: entryCount, sensitivity: 'low', removal: 'never' })
  blocks.push({ id: 'format', label: 'Formato del EPUB', removableIn: 'never', fields: formatFields })

  const fields = blocks.flatMap((block) => block.fields)
  return { fields, count: fields.length, blocks, entries: inventory }
}

/* ── Limpieza ── */

interface Edit {
  start: number
  end: number
  text: string
}

/** Aplica recortes/sustituciones no solapados conservando el resto del texto. */
function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
  const parts: string[] = []
  let cursor = 0
  for (const edit of sorted) {
    if (edit.start < cursor) continue // solape: ya recortado por una edición previa
    if (edit.start > cursor) parts.push(text.slice(cursor, edit.start))
    parts.push(edit.text)
    if (edit.end > cursor) cursor = edit.end
  }
  parts.push(text.slice(cursor))
  return parts.join('')
}

/**
 * Cirugía sobre el TEXTO del OPF: elimina los campos personales y normaliza los
 * obligatorios sin re-serializar el documento (el resto conserva sus bytes).
 * `null` si el `<metadata>` no se reconoce (nunca lanza).
 */
function stripOpfMetadata(text: string): string | null {
  const location = locateMetadata(text)
  if (!location) return null
  const { tokens, pairs, innerStart, innerEnd } = location
  const edits: Edit[] = []
  const removed = new Set<number>()
  const removedIds = new Set<string>()

  const inMetadata = (token: XmlToken): boolean => token.start >= innerStart && token.start < innerEnd
  const removeToken = (t: number, token: XmlToken): void => {
    if (removed.has(t)) return
    removed.add(t)
    edits.push({ start: token.start, end: elementEnd(tokens, pairs, t), text: '' })
    const id = attrValue(token, 'id')
    if (id) removedIds.add(id)
  }

  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]
    if (token.kind !== 'start' && token.kind !== 'self') continue
    if (!inMetadata(token)) continue
    const inner = innerTextOf(tokens, pairs, t, text)
    const item = classifyMetaToken(token, inner)
    if (!item || item.action === 'keep') continue
    if (item.action === 'remove') {
      removeToken(t, token)
      continue
    }
    // Neutralizar: sustituir SOLO el valor (el elemento nunca se borra). En la
    // forma autocerrada la fecha vive en el atributo `content`, no en el texto.
    if (token.kind === 'self') {
      const span = attrValueSpan(token, 'content')
      if (span) edits.push({ start: span.start, end: span.end, text: NEUTRAL_DATE })
      continue
    }
    const close = pairs.get(t)
    if (close === undefined) continue
    edits.push({ start: token.end, end: tokens[close].start, text: NEUTRAL_DATE })
  }

  // EPUB 3 exige que `refines` apunte a un elemento existente: si su objetivo se
  // eliminó, el `<meta refines="#…">` queda colgando y el validador lo rechaza.
  // Se eliminan esos `refines` (y en cadena los que apunten a ellos).
  let grew = true
  while (grew) {
    grew = false
    for (let t = 0; t < tokens.length; t++) {
      if (removed.has(t)) continue
      const token = tokens[t]
      if ((token.kind !== 'start' && token.kind !== 'self') || localName(token.name) !== 'meta') continue
      if (!inMetadata(token)) continue
      const refines = attrValue(token, 'refines')
      if (!refines) continue
      const target = refines.startsWith('#') ? refines.slice(1) : refines
      if (!removedIds.has(target)) continue
      removeToken(t, token)
      grew = true
    }
  }

  if (!edits.length) return text
  return applyEdits(text, edits)
}

/** Limpieza EPUB por bloques; el resto del paquete conserva sus bytes exactos. */
function stripEpub(bytes: Uint8Array, config: StripConfig): Uint8Array {
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  const entries = readZip(bytes)
  if (!entries) return bytes.slice()
  const opfPath = locateOpf(entries)
  if (!opfPath) return bytes.slice()
  const want = (block: string): boolean => config.mode === 'deep' || config.blocks.includes(block)

  // `metadata`: reescribir el OPF (debe seguir siendo XML bien formado).
  let opfBytes = entries[opfPath]!
  if (want('metadata')) {
    const opfText = textOf(opfBytes)
    if (opfText.includes('\uFFFD')) return bytes.slice()
    const cleaned = stripOpfMetadata(opfText)
    if (cleaned === null) return bytes.slice()
    if (XMLValidator.validate(cleaned) !== true) return bytes.slice()
    opfBytes = utf8(cleaned)
  }

  // `sidecars`: eliminar sus entradas del paquete.
  const kept: ZipEntries = {}
  for (const [name, data] of Object.entries(entries)) {
    if (want('sidecars') && isSidecar(name)) continue
    kept[name] = name === opfPath ? opfBytes : data
  }
  // `writeZip` devuelve null si no puede garantizar `mimetype` primero y almacenado.
  return writeZip(kept) ?? bytes.slice()
}

/* ── Dominio ── */

/** Dominio EPUB de "Eliminar metadata": escaneo y limpieza por bloques. */
export const epubDomain: MetaDomain = {
  kinds: ['epub'],
  scan: async (bytes: Uint8Array): Promise<MetadataReport> => {
    try {
      return scanEpub(bytes)
    } catch {
      // Ante cualquier fallo de parseo, nunca lanzamos: report vacío.
      return EMPTY_REPORT
    }
  },
  strip: async (bytes: Uint8Array, _kind, config: StripConfig, report): Promise<Uint8Array> => {
    report('Limpiando metadata del EPUB', 50)
    try {
      return stripEpub(bytes, config)
    } catch {
      // EPUB no interpretable: passthrough de los mismos bytes.
      return bytes.slice()
    }
  },
}
