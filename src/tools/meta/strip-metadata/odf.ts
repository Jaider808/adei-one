/**
 * ADEI-ONE — Dominio ODT de "Eliminar metadata" (`meta.strip`).
 *
 * Un ODT es un ZIP (ODF) con `mimetype` primero y almacenado, `META-INF/
 * manifest.xml`, `content.xml`, `styles.xml`, `meta.xml` (autor, fechas,
 * generador, título, palabras clave…), `settings.xml` (ajustes de usuario y
 * vista) y, a menudo, `Thumbnails/thumbnail.png` (una imagen que puede traer su
 * propia metadata).
 *
 * Bloques (los ids que envía el wizard en `blocks`):
 * - 'meta'     → contenido de `meta.xml` (se vacía `office:meta`, conservando
 *                la raíz `office:document-meta` y sus namespaces).
 * - 'settings' → `settings.xml` y su entrada del manifest.
 * - 'thumb'    → `Thumbnails/` y sus entradas del manifest.
 * - 'format'   → `mimetype`, versión ODF y nº de entradas; NUNCA se borran
 *                (`removal: 'never'`).
 *
 * Semántica de modo (ver `domain.ts`): en `light` solo se eliminan los bloques
 * pedidos (lista vacía = passthrough byte a byte); en `deep` se eliminan todos.
 * El manifest nunca puede referenciar un fichero que ya no existe. Nunca lanza:
 * un ZIP o XML no interpretable pasa tal cual.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { EMPTY_REPORT, shortHex } from './domain'
import { MIMETYPE_ENTRY, readZip, writeZip } from './zipdoc'
import type { ZipEntries } from './zipdoc'
import type { MetaDomain, StripConfig } from './domain'
import type { MetadataBlock, MetadataField, MetadataReport, MetaEntry } from '@/core/types'

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

/* ── Etiquetas legibles de `meta.xml` ── */

const ODF_META_LABELS: Record<string, { label: string; sensitivity: MetadataField['sensitivity'] }> = {
  'dc:creator': { label: 'Autor', sensitivity: 'medium' },
  'meta:initial-creator': { label: 'Autor inicial', sensitivity: 'medium' },
  'dc:date': { label: 'Fecha', sensitivity: 'medium' },
  'meta:creation-date': { label: 'Fecha de creación', sensitivity: 'medium' },
  'meta:generator': { label: 'Generador', sensitivity: 'medium' },
  'meta:editing-cycles': { label: 'Ciclos de edición', sensitivity: 'low' },
  'meta:editing-duration': { label: 'Duración de edición', sensitivity: 'low' },
  'dc:title': { label: 'Título', sensitivity: 'low' },
  'dc:description': { label: 'Descripción', sensitivity: 'low' },
  'dc:subject': { label: 'Asunto', sensitivity: 'low' },
  'meta:keyword': { label: 'Palabras clave', sensitivity: 'low' },
  'meta:user-defined': { label: 'Campo personalizado', sensitivity: 'medium' },
}

/* ── Parser XML → hojas con atributos ── */

interface OdfLeaf {
  key: string
  value: string
  attrs: Record<string, string>
}

/** Parser de ODF: conserva atributos y nombres cualificados (`dc:creator`…). */
function newParser(): XMLParser {
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
}

/** Primer clave hija que casa con el nombre local (ignora atributos `@_`). */
function findChild(node: Record<string, unknown>, local: string): unknown {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('@_') || key === '#text') continue
    if (key === local || key.endsWith(`:${local}`)) return value
  }
  return undefined
}

/**
 * Recorre el objeto XML y devuelve TODAS las hojas de texto (nombre crudo con
 * prefijo + valor + atributos). Los elementos con hijos se atraviesan.
 */
function collectLeaves(node: unknown, out: OdfLeaf[], depth = 0): void {
  if (depth > 24 || node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const item of node) collectLeaves(item, out, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith('@_') || key === '#text') continue
    const items = Array.isArray(value) ? value : [value]
    for (const item of items) {
      if (item === null || item === undefined) continue
      if (typeof item === 'object') {
        const obj = item as Record<string, unknown>
        const attrs: Record<string, string> = {}
        for (const [attrKey, attrValue] of Object.entries(obj)) {
          if (attrKey.startsWith('@_')) attrs[attrKey.slice(2)] = String(attrValue)
        }
        if ('#text' in obj) out.push({ key, value: String(obj['#text'] ?? ''), attrs })
        else collectLeaves(obj, out, depth + 1)
      } else {
        out.push({ key, value: String(item), attrs: {} })
      }
    }
  }
}

/** Hojas de `office:meta` de un `meta.xml`; `null` si el XML no se puede parsear. */
function parseMetaLeaves(xml: string): OdfLeaf[] | null {
  try {
    const parsed = newParser().parse(xml) as Record<string, unknown>
    const root = findChild(parsed, 'document-meta')
    if (!root || typeof root !== 'object') return null
    const metaNode = findChild(root as Record<string, unknown>, 'meta')
    const out: OdfLeaf[] = []
    collectLeaves(metaNode ?? root, out)
    return out
  } catch {
    return null
  }
}

/** Hojas de `config:config-item` de un `settings.xml` (vacío si no se parsea). */
function parseSettingsItems(xml: string): OdfLeaf[] {
  try {
    const parsed = newParser().parse(xml) as Record<string, unknown>
    const out: OdfLeaf[] = []
    collectLeaves(parsed, out)
    return out.filter((leaf) => leaf.key === 'config-item' || leaf.key.endsWith(':config-item'))
  } catch {
    return []
  }
}

/** Versión ODF declarada en la raíz de `manifest.xml` (o undefined). */
function readManifestVersion(xml: string): string | undefined {
  try {
    const parsed = newParser().parse(xml) as Record<string, unknown>
    const root = findChild(parsed, 'manifest')
    if (!root || typeof root !== 'object') return undefined
    const attrs = root as Record<string, unknown>
    const version = attrs['@_manifest:version'] ?? attrs['@_version']
    return version === undefined ? undefined : String(version)
  } catch {
    return undefined
  }
}

/* ── Escaneo ── */

/** Escaneo ODT: `meta.xml`, `settings.xml`, `Thumbnails/` y bloque `format`. */
function scanOdf(bytes: Uint8Array): MetadataReport {
  const entries = readZip(bytes)
  if (!entries) return EMPTY_REPORT
  const blocks: MetadataBlock[] = []
  const inventory: MetaEntry[] = []

  // meta.xml: una entrada por cada hoja de `office:meta`.
  const metaBytes = entries['meta.xml']
  if (metaBytes) {
    const leaves = parseMetaLeaves(textOf(metaBytes))
    if (leaves) {
      const fields: MetadataField[] = []
      for (const leaf of leaves) {
        const mapped = ODF_META_LABELS[leaf.key]
        const nameAttr = leaf.attrs['meta:name']
        const baseLabel = mapped?.label ?? leaf.key
        const label = leaf.key === 'meta:user-defined' && nameAttr ? `${baseLabel}: ${nameAttr}` : baseLabel
        const sensitivity = mapped?.sensitivity ?? 'medium'
        const value = txt(leaf.value)
        fields.push({ name: label, value, sensitivity })
        inventory.push({
          where: `meta.xml > ${leaf.key}`,
          key: leaf.key,
          label,
          value,
          sensitivity,
          removal: 'with-container',
        })
      }
      if (fields.length) blocks.push({ id: 'meta', label: 'Metadatos del documento', removableIn: 'light', fields })
    }
  }

  // settings.xml: presencia + ajustes de usuario/vista (config-items).
  const settingsBytes = entries['settings.xml']
  if (settingsBytes) {
    const fields: MetadataField[] = [{ name: 'Ajustes de usuario y vista', value: 'Presentes', sensitivity: 'low' }]
    for (const item of parseSettingsItems(textOf(settingsBytes))) {
      const label = item.attrs['config:name'] ?? 'config-item'
      const value = txt(item.value)
      fields.push({ name: label, value, sensitivity: 'low' })
      inventory.push({
        where: 'settings.xml > config:config-item',
        key: label,
        label,
        value,
        sensitivity: 'low',
        removal: 'with-container',
      })
    }
    blocks.push({ id: 'settings', label: 'Ajustes de usuario y vista', removableIn: 'light', fields })
  }

  // Thumbnails/: presencia y tamaño (es una imagen embebida).
  const thumbs = Object.keys(entries).filter((name) => name.startsWith('Thumbnails/'))
  if (thumbs.length) {
    const fields: MetadataField[] = []
    for (const name of thumbs) {
      const data = entries[name]!
      fields.push({ name: 'Miniatura', value: `Presente (${data.length} bytes)`, sensitivity: 'low' })
      inventory.push({
        where: name,
        key: name.split('/').pop() ?? name,
        label: 'Miniatura',
        value: 'Presente',
        size: data.length,
        hex: shortHex(data),
        sensitivity: 'low',
        removal: 'with-container',
      })
    }
    blocks.push({ id: 'thumb', label: 'Miniatura', removableIn: 'light', fields })
  }

  // format: datos estructurales del paquete (NUNCA se borran).
  const formatFields: MetadataField[] = []
  const mimetype = entries[MIMETYPE_ENTRY]
  if (mimetype) {
    const value = txt(textOf(mimetype))
    formatFields.push({ name: 'Tipo MIME', value, sensitivity: 'low', removableIn: 'never' })
    inventory.push({ where: MIMETYPE_ENTRY, key: MIMETYPE_ENTRY, label: 'Tipo MIME', value, sensitivity: 'low', removal: 'never' })
  }
  const manifestBytes = entries['META-INF/manifest.xml']
  const version = manifestBytes ? readManifestVersion(textOf(manifestBytes)) : undefined
  if (version) {
    formatFields.push({ name: 'Versión ODF', value: version, sensitivity: 'low', removableIn: 'never' })
    inventory.push({ where: 'META-INF/manifest.xml', key: 'manifest:version', label: 'Versión ODF', value: version, sensitivity: 'low', removal: 'never' })
  }
  const entryCount = String(Object.keys(entries).length)
  formatFields.push({ name: 'Entradas del paquete', value: entryCount, sensitivity: 'low', removableIn: 'never' })
  inventory.push({ where: 'ZIP', key: 'entries', label: 'Entradas del paquete', value: entryCount, sensitivity: 'low', removal: 'never' })
  blocks.push({ id: 'format', label: 'Formato del ODT', removableIn: 'never', fields: formatFields })

  const fields = blocks.flatMap((block) => block.fields)
  return { fields, count: fields.length, blocks, entries: inventory }
}

/* ── Limpieza ── */

/**
 * Vacía el contenido de `office:meta` conservando la raíz `office:document-meta`
 * y sus namespaces (el documento sigue siendo un `office:document-meta` válido).
 * `null` si no se reconoce la estructura (nunca lanza).
 */
function emptyMetaXml(text: string): string | null {
  const open = /<office:meta(?:\s[^>]*)?>/i.exec(text)
  if (open) {
    const openTag = open[0]
    const openEnd = open.index + openTag.length
    if (openTag.endsWith('/>')) return text // ya está vacío
    const close = text.indexOf('</office:meta>', openEnd)
    if (close < 0) return null
    return text.slice(0, openEnd) + text.slice(close)
  }
  // Sin `office:meta`: se vacía el contenido de la raíz (raíz y namespaces intactos).
  const root = /<office:document-meta(?:\s[^>]*)?>/i.exec(text)
  if (root) {
    const openEnd = root.index + root[0].length
    const close = text.lastIndexOf('</office:document-meta>')
    if (close < openEnd) return null
    return text.slice(0, openEnd) + text.slice(close)
  }
  return null
}

/** Índice tras el `>` de una etiqueta, respetando comillas. -1 si no cierra. */
function findTagEnd(text: string, start: number): number {
  let quote = ''
  for (let i = start; i < text.length; i++) {
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

/** Valor del atributo `manifest:full-path` de una etiqueta (o null). */
function readFullPath(tagText: string): string | null {
  const match = /manifest:full-path\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tagText)
  if (!match) return null
  return match[1] ?? match[2] ?? ''
}

const FILE_ENTRY_OPEN = '<manifest:file-entry'
const FILE_ENTRY_CLOSE = '</manifest:file-entry>'

/**
 * Elimina de `manifest.xml` las `<manifest:file-entry>` cuyo `full-path`
 * referencia un fichero que ya no existe en el paquete (la raíz `/` se
 * conserva). Devuelve `null` si el XML no se puede interpretar.
 */
function pruneManifest(text: string, kept: Set<string>): string | null {
  const parts: string[] = []
  let cursor = 0
  let searchFrom = 0
  for (;;) {
    const start = text.indexOf(FILE_ENTRY_OPEN, searchFrom)
    if (start < 0) break
    const boundary = text[start + FILE_ENTRY_OPEN.length]
    if (boundary !== '>' && boundary !== '/' && !/\s/.test(boundary ?? '')) {
      searchFrom = start + FILE_ENTRY_OPEN.length
      continue
    }
    const tagEnd = findTagEnd(text, start)
    if (tagEnd < 0) return null
    const tagText = text.slice(start, tagEnd)
    let elementEnd = tagEnd
    if (!tagText.endsWith('/>')) {
      const close = text.indexOf(FILE_ENTRY_CLOSE, tagEnd)
      if (close < 0) return null
      elementEnd = close + FILE_ENTRY_CLOSE.length
    }
    searchFrom = elementEnd
    const fullPath = readFullPath(tagText)
    const keep = fullPath === null || fullPath === '/' || kept.has(fullPath)
    if (!keep) {
      parts.push(text.slice(cursor, start))
      cursor = elementEnd
    }
  }
  parts.push(text.slice(cursor))
  return parts.join('')
}

/** Limpieza ODT por bloques; el resto del paquete conserva sus bytes exactos. */
function stripOdf(bytes: Uint8Array, config: StripConfig): Uint8Array {
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  const entries = readZip(bytes)
  if (!entries) return bytes.slice()
  const want = (block: string): boolean => config.mode === 'deep' || config.blocks.includes(block)

  // `meta`: reescribir `meta.xml` para vaciar sus metadatos (sigue siendo válido).
  if (want('meta') && entries['meta.xml']) {
    const cleaned = emptyMetaXml(textOf(entries['meta.xml']!))
    if (cleaned === null) return bytes.slice()
    // Igual que el OPF del EPUB: si el resultado no es XML bien formado, passthrough.
    if (XMLValidator.validate(cleaned) !== true) return bytes.slice()
    entries['meta.xml'] = utf8(cleaned)
  }

  // `settings` y `thumb`: eliminar sus entradas del paquete.
  const dropSettings = want('settings')
  const dropThumb = want('thumb')
  const kept: ZipEntries = {}
  for (const [name, data] of Object.entries(entries)) {
    if (dropSettings && name === 'settings.xml') continue
    if (dropThumb && name.startsWith('Thumbnails/')) continue
    kept[name] = data
  }

  // El manifest nunca puede referenciar un fichero que ya no existe.
  const manifest = kept['META-INF/manifest.xml']
  if (manifest) {
    const pruned = pruneManifest(textOf(manifest), new Set(Object.keys(kept)))
    if (pruned === null) return bytes.slice()
    kept['META-INF/manifest.xml'] = utf8(pruned)
  }

  // `writeZip` devuelve null si no puede garantizar `mimetype` primero y almacenado.
  return writeZip(kept) ?? bytes.slice()
}

/* ── Dominio ── */

/** Dominio ODT de "Eliminar metadata": escaneo y limpieza por bloques. */
export const odfDomain: MetaDomain = {
  kinds: ['odt'],
  scan: async (bytes: Uint8Array): Promise<MetadataReport> => {
    try {
      return scanOdf(bytes)
    } catch {
      // Ante cualquier fallo de parseo, nunca lanzamos: report vacío.
      return EMPTY_REPORT
    }
  },
  strip: async (bytes: Uint8Array, _kind, config: StripConfig, report): Promise<Uint8Array> => {
    report('Limpiando metadata del ODT', 50)
    try {
      return stripOdf(bytes, config)
    } catch {
      // ODT no interpretable: passthrough de los mismos bytes.
      return bytes.slice()
    }
  },
}
