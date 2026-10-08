/**
 * ADEI-ONE — Motor de "Eliminar metadata" (`meta.strip`). Tool ÚNICA transversal.
 *
 * Dos operaciones:
 *  - `scanMetadata(bytes, kind)`: reporta la metadata por BLOQUES (visor).
 *  - `stripMetadata(input)`: devuelve el archivo limpio según `config`.
 *
 * Modos (semántica documentada en `domain.ts`):
 *  - 'light' lossless estricto: elimina SOLO los bloques de `config.blocks`
 *    (vacío = passthrough de los mismos bytes) → NO toca el contenido:
 *    JPEG/PNG/WebP por cirugía de segmentos/chunks; PDF re-serializa vía
 *    pdf-lib (el texto sigue seleccionable); OOXML dropea partes del ZIP;
 *    Markdown quita el frontmatter; audio/video/imagen-extra delegan en sus
 *    dominios (también lossless).
 *  - 'deep' máxima limpieza: re-genera cuando el formato lo permite (imagen →
 *    canvas re-encode: se vuelve a comprimir; PDF → rasterización por páginas:
 *    el texto deja de ser seleccionable) y en el resto elimina TODOS los
 *    bloques + restos (padding/basura) sin tocar el contenido.
 *
 * Lazy-loading: exifr y pdf.js se importan SOLO cuando se usan (no pesan al
 * arranque).
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFString,
  decodePDFRawStream,
} from 'pdf-lib'
import { XMLParser } from 'fast-xml-parser'
import { strFromU8, inflateSync, unzipSync, zipSync } from 'fflate'
import { baseName } from '@/tools/common/pdf-helpers'
import { canvasToBytes, decodeToCanvas } from '@/tools/image/shared'
import { audioDomain } from './audio'
import {
  BLOCK_EXIF,
  BLOCK_ICC,
  BLOCK_TEXT,
  BLOCK_XMP,
  findJpegSegments,
  listJpegCom,
  listPngChunks,
  listPngText,
  listWebpChunks,
  preserveIcc,
  readU16BE,
  readU32BE,
  stripJpegAllSegments,
  stripJpegMetadata,
  stripPngDeep,
  stripPngMetadata,
  stripWebpMetadata,
} from './chunks'
import { EMPTY_REPORT, makeReporter, shortHex } from './domain'
import { imagePlusDomain } from './image-plus'
import { videoDomain } from './video'
import type { Reporter, StripConfig } from './domain'
import type {
  ActionConfig,
  EngineInput,
  FileKind,
  MetadataBlock,
  MetadataField,
  MetadataReport,
  MetaEntry,
  ProcessResult,
  ProgressEvent,
  RegenerationRisk,
  VerificationResult,
} from '@/core/types'

/* ── Constantes y helpers generales ── */

const MIME_BY_KIND: Partial<Record<FileKind, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  xml: 'application/xml',
  json: 'application/json',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  tiff: 'image/tiff',
  heic: 'image/heic',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  webm: 'video/webm',
}

function mime(kind: FileKind): string {
  return MIME_BY_KIND[kind] ?? 'application/octet-stream'
}

/** `Uint8Array -> Blob` (copia a un ArrayBuffer propio: fricción de tipos TS 5.9). */
function blobFrom(bytes: Uint8Array, type: string): Blob {
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  return new Blob([buf], { type })
}

/** `nombre` con sufijo `-limpio`, conservando la extensión original. */
function cleanedName(name: string): string {
  const ext = name.match(/\.[^.]+$/)
  return `${baseName(name)}-limpio${ext?.[0] ?? ''}`
}

/** Aplica la política de bloques del wizard sobre la config cruda. */
function readConfig(config: ActionConfig): StripConfig {
  const mode = config?.mode === 'deep' ? 'deep' : 'light'
  const raw = Array.isArray(config?.blocks) ? (config.blocks as unknown[]) : []
  return { mode, blocks: raw.filter((b): b is string => typeof b === 'string') }
}

/**
 * ¿Dos entradas del inventario describen el MISMO dato con el MISMO valor? Se
 * compara la ruta y la clave cruda (identidad física) junto con el valor legible
 * y el hex (contenido): un dato cuyo valor cambió ya no es el mismo dato. Un
 * dato sin contenido (valor vacío y sin hex) no es metadata "presente" y no
 * puede contarse como resto (p. ej. una fecha ISO-BMFF puesta a cero).
 */
function sameEntry(a: MetaEntry, b: MetaEntry): boolean {
  if (a.value === '' && a.hex === undefined) return false
  return a.where === b.where && a.key === b.key && a.value === b.value && (a.hex ?? '') === (b.hex ?? '')
}

/**
 * Comprueba que los bytes limpios no conservan metadata eliminable comparando el
 * inventario ANTES (bytes originales) y DESPUÉS (bytes limpios) con el mismo
 * `scanMetadata`. Cuenta como restos solo las entradas eliminables del original
 * (`removal !== 'never'`) que siguen presentes con el MISMO valor en el
 * resultado: un dato cuyo valor cambió o desapareció (p. ej. una fecha puesta a
 * cero) ya no está. Si NI el original NI el resultado se pudieron interpretar
 * (dos reportes vacíos), informa 'unverifiable', nunca 'clean' a ciegas. NUNCA
 * lanza: si el escaneo falla, la operación sigue y se informa 'unverifiable'.
 */
async function verifyClean(kind: FileKind, original: Uint8Array, cleaned: Uint8Array): Promise<VerificationResult> {
  try {
    const before = await scanMetadata({ bytes: original, kind })
    const after = await scanMetadata({ bytes: cleaned, kind })
    // `EMPTY_REPORT` significa "sin metadata" Y "no parseable"; dos reportes
    // vacíos no permiten afirmar nada → 'unverifiable', jamás un 'clean' a ciegas.
    if (before.entries.length === 0 && after.entries.length === 0) {
      return { status: 'unverifiable' }
    }
    const leftovers = before.entries.filter(
      (entry) => entry.removal !== 'never' && after.entries.some((candidate) => sameEntry(candidate, entry)),
    )
    if (leftovers.length === 0) return { status: 'clean' }
    return {
      status: 'remaining',
      remaining: leftovers.length,
      sample: leftovers.slice(0, 5).map((entry) => entry.label ?? entry.key),
    }
  } catch {
    return { status: 'unverifiable' }
  }
}

/** Constituye un ProcessResult (con verificación) y emite el evento final. */
async function done(
  kind: FileKind,
  name: string,
  original: Uint8Array,
  bytes: Uint8Array,
  report: Reporter,
): Promise<ProcessResult> {
  report('Generando archivo', 90)
  const blob = blobFrom(bytes, mime(kind))
  const verification = await verifyClean(kind, original, bytes)
  report('Listo', 100)
  return { name, kind, blob, size: blob.size, verification }
}

/** Texto seguro para un campo (sin saltos de línea largos ni binario). */
function txt(value: string, max = 400): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/* ── Escaneo ── */

/** Frontmatter YAML inicial (`---\n … \n---`): bloques `clave: valor`. */
function parseFrontmatter(content: string): { fields: MetadataField[]; rest: string; found: boolean } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return { fields: [], rest: content, found: false }
  const fields: MetadataField[] = []
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const kv = line.match(/^\s*([^:]+):\s*(.*?)\s*$/)
    if (!kv) continue
    const key = kv[1]?.trim()
    if (!key) continue
    fields.push({ name: key, value: (kv[2] ?? '').trim(), sensitivity: 'medium' })
  }
  return { fields, rest: content.slice(match[0].length), found: true }
}

/** Etiquetas legibles del diccionario de información PDF (clave cruda → nombre + sensibilidad). */
const PDF_INFO_LABELS: Record<string, { label: string; sensitivity: MetadataField['sensitivity'] }> = {
  Title: { label: 'Título', sensitivity: 'low' },
  Author: { label: 'Autor', sensitivity: 'medium' },
  Subject: { label: 'Asunto', sensitivity: 'low' },
  Keywords: { label: 'Palabras clave', sensitivity: 'low' },
  Creator: { label: 'Creador', sensitivity: 'medium' },
  Producer: { label: 'Productor', sensitivity: 'low' },
  CreationDate: { label: 'Fecha de creación', sensitivity: 'medium' },
  ModDate: { label: 'Fecha de modificación', sensitivity: 'medium' },
  Trapped: { label: 'Atrapado', sensitivity: 'low' },
}

/** Valor de un objeto PDF → texto legible (cadenas, nombres, números, booleanos, arrays). */
function pdfValueToText(value: unknown): string {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText()
  if (value instanceof PDFName) return value.asString()
  if (value instanceof PDFNumber) return String(value.asNumber())
  if (value instanceof PDFBool) return value.asBoolean() ? 'Sí' : 'No'
  if (value instanceof PDFArray) return value.asArray().map((item) => pdfValueToText(item)).join(', ')
  if (value === null || value === undefined) return ''
  return String(value)
}

/** Enumera TODAS las claves del diccionario de información (`/Title`, `/Author`… y las desconocidas). */
function pushPdfInfoEntries(doc: PDFDocument, entries: MetaEntry[]): void {
  const infoRef = doc.context.trailerInfo.Info
  if (!infoRef) return
  const info = doc.context.lookup(infoRef)
  if (!(info instanceof PDFDict)) return
  for (const [name, rawValue] of info.entries()) {
    // Los nombres parseados conservan la barra inicial (`/Title`): se normaliza a clave cruda.
    const key = name.asString().replace(/^\//, '')
    const mapped = PDF_INFO_LABELS[key]
    entries.push({
      where: 'info dictionary',
      key,
      label: mapped?.label,
      value: txt(pdfValueToText(doc.context.lookup(rawValue))),
      sensitivity: mapped?.sensitivity ?? 'medium',
      // `stripPdfLight` elimina TODAS las claves del Info dict (incluidas las
      // personalizadas): cualquiera puede declararse como eliminada.
      removal: 'with-container',
    })
  }
}

/** Claves estructurales de XMP que NO son propiedades (contenedores RDF, namespaces, xml:*). */
const XMP_STRUCTURAL: ReadonlySet<string> = new Set([
  'rdf:RDF',
  'rdf:Description',
  'rdf:Alt',
  'rdf:Bag',
  'rdf:Seq',
  'rdf:li',
  'x:xmpmeta',
])

/** ¿Es una clave estructural (no una propiedad XMP real)? */
function isXmpStructural(key: string): boolean {
  return (
    XMP_STRUCTURAL.has(key) ||
    key.startsWith('xmlns') ||
    key.startsWith('?') ||
    key === 'rdf:about' ||
    key === 'rdf:parseType' ||
    key === 'rdf:resource' ||
    key === 'rdf:datatype' ||
    key === 'rdf:nodeID' ||
    key === 'xml:lang'
  )
}

/** Entrada de inventario de una propiedad XMP (atributo o elemento hoja). */
function xmpEntry(key: string, value: string): MetaEntry {
  return { where: 'XMP', key, value: txt(value), sensitivity: 'medium', removal: 'with-container' }
}

/**
 * Recorre el objeto XML de XMP y emite una entrada por propiedad (atributo o
 * elemento hoja), conservando el nombre crudo (`dc:title`, `pdf:Producer`…).
 * Los contenedores RDF se atraviesan sin emitirse.
 */
function pushXmpEntries(node: unknown, entries: MetaEntry[], prop?: string): void {
  if (node === null || node === undefined) return
  if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
    if (prop) entries.push(xmpEntry(prop, String(node)))
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) pushXmpEntries(item, entries, prop)
    return
  }
  if (typeof node !== 'object') return
  for (const [rawKey, value] of Object.entries(node as Record<string, unknown>)) {
    const key = rawKey.startsWith('@_') ? rawKey.slice(2) : rawKey
    if (rawKey === '#text') {
      if (prop) entries.push(xmpEntry(prop, String(value)))
      continue
    }
    if (isXmpStructural(key)) {
      pushXmpEntries(value, entries, prop)
      continue
    }
    if (value === null || value === undefined) continue
    if (typeof value === 'object') pushXmpEntries(value, entries, key)
    else entries.push(xmpEntry(key, String(value)))
  }
}

/** Extrae el paquete XMP del PDF (stream `/Metadata` decodificado o búsqueda cruda). */
function extractXmpText(doc: PDFDocument, bytes: Uint8Array): string | null {
  const meta = doc.catalog.get(PDFName.of('Metadata'))
  if (meta) {
    try {
      const resolved = doc.context.lookup(meta)
      if (resolved instanceof PDFRawStream) {
        const text = new TextDecoder().decode(decodePDFRawStream(resolved).decode())
        if (text.includes('<x:xmpmeta')) return text
      }
    } catch {
      /* stream XMP no decodificable */
    }
  }
  // Streams XMP sin comprimir: búsqueda cruda en el primer MB.
  const raw = new TextDecoder('latin1').decode(bytes.slice(0, Math.min(bytes.length, 1_000_000)))
  const start = raw.indexOf('<x:xmpmeta')
  if (start < 0) return null
  const end = raw.indexOf('</x:xmpmeta>', start)
  return end < 0 ? raw.slice(start) : raw.slice(start, end + '</x:xmpmeta>'.length)
}

/* ── Avisos de regeneración (detección read-only; nunca cambia el strip) ── */

/** ¿Algún campo del árbol AcroForm (incl. Kids) declara el tipo `/FT` pedido? */
function acroFormHasFieldType(doc: PDFDocument, fields: PDFArray, wanted: string): boolean {
  const seen = new Set<PDFDict>()
  const visit = (node: PDFObject, depth: number): boolean => {
    if (depth > 16) return false
    const resolved = doc.context.lookup(node)
    if (!(resolved instanceof PDFDict) || seen.has(resolved)) return false
    seen.add(resolved)
    const ft = resolved.get(PDFName.of('FT'))
    const ftName = ft ? doc.context.lookup(ft) : undefined
    if (ftName instanceof PDFName && ftName.asString() === wanted) return true
    const kidsRef = resolved.get(PDFName.of('Kids'))
    const kids = kidsRef ? doc.context.lookup(kidsRef) : undefined
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) if (visit(kids.get(i), depth + 1)) return true
    }
    return false
  }
  for (let i = 0; i < fields.size(); i++) if (visit(fields.get(i), 0)) return true
  return false
}

/** Cuenta las anotaciones de todas las páginas y cuántas son enlaces (`/Subtype /Link`). */
function pdfAnnotationStats(doc: PDFDocument): { total: number; links: number } {
  let total = 0
  let links = 0
  for (const page of doc.getPages()) {
    const annotsRef = page.node.get(PDFName.of('Annots'))
    const annots = annotsRef ? doc.context.lookup(annotsRef) : undefined
    if (!(annots instanceof PDFArray)) continue
    for (let i = 0; i < annots.size(); i++) {
      total += 1
      const annot = doc.context.lookup(annots.get(i))
      if (!(annot instanceof PDFDict)) continue
      const sub = annot.get(PDFName.of('Subtype'))
      const subName = sub ? doc.context.lookup(sub) : undefined
      if (subName instanceof PDFName && subName.asString() === '/Link') links += 1
    }
  }
  return { total, links }
}

/**
 * Avisos de regeneración de un PDF: qué pierde el modo profundo (rasteriza el
 * documento). Solo emite avisos de rasgos REALMENTE presentes. Nunca lanza.
 */
function pdfRisks(doc: PDFDocument): RegenerationRisk[] {
  const risks: RegenerationRisk[] = []
  const acroRef = doc.catalog.get(PDFName.of('AcroForm'))
  const acro = acroRef ? doc.context.lookup(acroRef) : undefined
  if (acro instanceof PDFDict) {
    const fieldsRef = acro.get(PDFName.of('Fields'))
    const fields = fieldsRef ? doc.context.lookup(fieldsRef) : undefined
    if (fields instanceof PDFArray && fields.size() > 0) {
      const n = fields.size()
      risks.push({
        id: 'pdf-forms',
        label: 'Formularios',
        detail: `El modo profundo elimina los formularios rellenables (${n} ${n === 1 ? 'campo' : 'campos'}).`,
        severity: 'high',
        affects: 'deep',
      })
    }
    const signed =
      acro.has(PDFName.of('SigFlags')) ||
      (fields instanceof PDFArray && acroFormHasFieldType(doc, fields, '/Sig'))
    if (signed) {
      risks.push({
        id: 'pdf-signatures',
        label: 'Firmas digitales',
        detail: 'El modo profundo elimina las firmas digitales del documento.',
        severity: 'high',
        affects: 'deep',
      })
    }
  }
  const { total, links } = pdfAnnotationStats(doc)
  if (links > 0) {
    risks.push({
      id: 'pdf-links',
      label: 'Enlaces',
      detail: `El modo profundo elimina los enlaces seleccionables (${links} ${links === 1 ? 'enlace' : 'enlaces'}).`,
      severity: 'medium',
      affects: 'deep',
    })
  }
  if (total > 0) {
    risks.push({
      id: 'pdf-annotations',
      label: 'Anotaciones',
      detail: `El modo profundo elimina las anotaciones y comentarios (${total}).`,
      severity: 'medium',
      affects: 'deep',
    })
  }
  if (doc.catalog.has(PDFName.of('Outlines'))) {
    risks.push({
      id: 'pdf-outlines',
      label: 'Marcadores',
      detail: 'El modo profundo elimina los marcadores (índice del documento).',
      severity: 'medium',
      affects: 'deep',
    })
  }
  return risks
}

/** Escaneo PDF: toda clave del Info dict + toda propiedad XMP + datos técnicos (nunca lanza). */
async function scanPdf(bytes: Uint8Array): Promise<MetadataReport> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false })
    const fields: MetadataField[] = []
    const push = (name: string, value: string | undefined, sensitivity: MetadataField['sensitivity']): void => {
      if (value) fields.push({ name, value: txt(value), sensitivity })
    }
    push('Título', doc.getTitle(), 'low')
    push('Autor', doc.getAuthor(), 'medium')
    push('Asunto', doc.getSubject(), 'low')
    push('Palabras clave', doc.getKeywords(), 'low')
    push('Creador', doc.getCreator(), 'medium')
    push('Productor', doc.getProducer(), 'low')
    push('Fecha de creación', doc.getCreationDate()?.toISOString(), 'medium')
    push('Fecha de modificación', doc.getModificationDate()?.toISOString(), 'medium')
    const blocks: MetadataBlock[] = [
      { id: 'info', label: 'Información del documento', fields, removableIn: 'light' },
      {
        id: 'format',
        label: 'Estructura del documento',
        removableIn: 'never',
        fields: [
          { name: 'Número de páginas', value: String(doc.getPageCount()), sensitivity: 'low' },
          { name: 'Protegido con contraseña', value: doc.isEncrypted ? 'Sí' : 'No', sensitivity: 'low' },
        ],
      },
    ]
    // Inventario exhaustivo: cada clave real del Info dict (incluidas las personalizadas).
    const entries: MetaEntry[] = []
    pushPdfInfoEntries(doc, entries)
    entries.push({
      where: 'page tree',
      key: 'PageCount',
      label: 'Número de páginas',
      value: String(doc.getPageCount()),
      sensitivity: 'low',
      removal: 'never',
    })
    entries.push({
      where: 'trailer',
      key: 'Encrypt',
      label: 'Protegido con contraseña',
      value: doc.isEncrypted ? 'Sí' : 'No',
      sensitivity: 'low',
      removal: 'never',
    })
    const xmpText = extractXmpText(doc, bytes)
    let sawXmpProp = false
    if (xmpText) {
      try {
        const parsed = new XMLParser({ ignoreAttributes: false }).parse(xmpText) as Record<string, unknown>
        pushXmpEntries(parsed, entries)
        sawXmpProp = entries.some((e) => e.where === 'XMP')
      } catch {
        /* XMP no parseable: se reporta solo su presencia */
      }
      blocks.push({
        id: 'xmp',
        label: 'Metadatos XMP',
        removableIn: 'light',
        fields: [{ name: 'Metadatos XMP', value: 'Presentes', sensitivity: 'medium' }],
      })
      if (!sawXmpProp) {
        entries.push({
          where: 'XMP',
          key: 'xmp',
          label: 'Metadatos XMP',
          value: 'Presentes',
          sensitivity: 'medium',
          removal: 'with-container',
        })
      }
    }
    let risks: RegenerationRisk[] = []
    try {
      risks = pdfRisks(doc)
    } catch {
      /* un PDF no interpretable no produce avisos */
    }
    return { fields, count: fields.length, blocks, entries, risks }
  } catch {
    return EMPTY_REPORT
  }
}

/** Etiquetas EXIF/GPS más comunes (español) → nombre + sensibilidad. */
const EXIF_LABELS: Record<string, { label: string; sensitivity: MetadataField['sensitivity'] }> = {
  Make: { label: 'Fabricante', sensitivity: 'medium' },
  Model: { label: 'Modelo', sensitivity: 'medium' },
  Software: { label: 'Software', sensitivity: 'medium' },
  ProcessingSoftware: { label: 'Software de procesado', sensitivity: 'medium' },
  DateTimeOriginal: { label: 'Fecha original', sensitivity: 'medium' },
  CreateDate: { label: 'Fecha de creación', sensitivity: 'medium' },
  ModifyDate: { label: 'Fecha de modificación', sensitivity: 'medium' },
  OffsetTimeOriginal: { label: 'Desfase de hora', sensitivity: 'low' },
  ExposureTime: { label: 'Tiempo de exposición', sensitivity: 'low' },
  FNumber: { label: 'Apertura', sensitivity: 'low' },
  ISO: { label: 'Sensibilidad ISO', sensitivity: 'low' },
  FocalLength: { label: 'Distancia focal', sensitivity: 'low' },
  LensModel: { label: 'Objetivo', sensitivity: 'low' },
  LensMake: { label: 'Fabricante del objetivo', sensitivity: 'low' },
  Orientation: { label: 'Orientación', sensitivity: 'low' },
  WhiteBalance: { label: 'Balance de blancos', sensitivity: 'low' },
  Flash: { label: 'Flash', sensitivity: 'low' },
  Artist: { label: 'Artista', sensitivity: 'medium' },
  Copyright: { label: 'Copyright', sensitivity: 'medium' },
  ImageDescription: { label: 'Descripción', sensitivity: 'low' },
  UserComment: { label: 'Comentario', sensitivity: 'high' },
  GPSLatitude: { label: 'Latitud GPS', sensitivity: 'high' },
  GPSLongitude: { label: 'Longitud GPS', sensitivity: 'high' },
  GPSAltitude: { label: 'Altitud GPS', sensitivity: 'high' },
  GPSDateStamp: { label: 'Fecha GPS', sensitivity: 'high' },
  GPSTimeStamp: { label: 'Hora GPS', sensitivity: 'high' },
  ImageWidth: { label: 'Ancho', sensitivity: 'low' },
  ImageHeight: { label: 'Alto', sensitivity: 'low' },
  ExifImageWidth: { label: 'Ancho', sensitivity: 'low' },
  ExifImageHeight: { label: 'Alto', sensitivity: 'low' },
  ColorSpace: { label: 'Espacio de color', sensitivity: 'low' },
  Compression: { label: 'Compresión', sensitivity: 'low' },
  ResolutionUnit: { label: 'Unidad de resolución', sensitivity: 'low' },
  XResolution: { label: 'Resolución X', sensitivity: 'low' },
  YResolution: { label: 'Resolución Y', sensitivity: 'low' },
  SerialNumber: { label: 'Número de serie', sensitivity: 'high' },
  BodySerialNumber: { label: 'Número de serie (cuerpo)', sensitivity: 'high' },
  LensSerialNumber: { label: 'Número de serie (objetivo)', sensitivity: 'high' },
  ExifVersion: { label: 'Versión EXIF', sensitivity: 'low' },
  FlashpixVersion: { label: 'Versión FlashPix', sensitivity: 'low' },
  YCbCrPositioning: { label: 'Posicionamiento YCbCr', sensitivity: 'low' },
  SensitivityType: { label: 'Tipo de sensibilidad', sensitivity: 'low' },
  RecommendedExposureIndex: { label: 'Índice de exposición recomendado', sensitivity: 'low' },
  SubSecTime: { label: 'Subsegundo (hora)', sensitivity: 'low' },
  SubSecTimeOriginal: { label: 'Subsegundo (original)', sensitivity: 'low' },
  SubSecTimeDigitized: { label: 'Subsegundo (digitalización)', sensitivity: 'low' },
  ComponentsConfiguration: { label: 'Componentes de color', sensitivity: 'low' },
  ExposureProgram: { label: 'Programa de exposición', sensitivity: 'low' },
  MeteringMode: { label: 'Modo de medición', sensitivity: 'low' },
  LightSource: { label: 'Fuente de luz', sensitivity: 'low' },
  SceneCaptureType: { label: 'Tipo de escena', sensitivity: 'low' },
  ExposureMode: { label: 'Modo de exposición', sensitivity: 'low' },
  DigitalZoomRatio: { label: 'Zoom digital', sensitivity: 'low' },
  FocalLengthIn35mmFormat: { label: 'Distancia focal (35 mm)', sensitivity: 'low' },
  BrightnessValue: { label: 'Brillo', sensitivity: 'low' },
  ExposureCompensation: { label: 'Compensación de exposición', sensitivity: 'low' },
  MaxApertureValue: { label: 'Apertura máxima', sensitivity: 'low' },
  ShutterSpeedValue: { label: 'Velocidad de obturación', sensitivity: 'low' },
  ApertureValue: { label: 'Valor de apertura', sensitivity: 'low' },
  Contrast: { label: 'Contraste', sensitivity: 'low' },
  Saturation: { label: 'Saturación', sensitivity: 'low' },
  Sharpness: { label: 'Nitidez', sensitivity: 'low' },
  GainControl: { label: 'Control de ganancia', sensitivity: 'low' },
  SensingMethod: { label: 'Método de sensor', sensitivity: 'low' },
}

/** Valor EXIF → texto legible (fechas, arrays DMS de GPS, números, "arrays" de objeto…). */
function exifValue(key: string, value: unknown): string {
  if (value instanceof Date) return value.toISOString().replace('T', ' ').slice(0, 19) + ' (UTC)'
  if (Array.isArray(value)) {
    if ((key.startsWith('GPSLatitude') || key.startsWith('GPSLongitude')) && value.length === 3) {
      const [d, m, s] = value.map(Number)
      return `${d}° ${m}′ ${s.toFixed(2)}″`
    }
    return value.map((v) => exifValue(key, v)).join(', ')
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj)
    // Objetos tipo "array" (claves numéricas: ComponentsConfiguration {0:1,1:2…}).
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      return keys
        .sort((a, b) => Number(a) - Number(b))
        .map((k) => exifValue(key, obj[k]))
        .join(', ')
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toLocaleString()
  return String(value)
}

/** Convierte la salida de exifr en campos (toda la metadata, GPS marcada). */
function toExifFields(meta: Record<string, unknown>): MetadataField[] {
  const fields: MetadataField[] = []
  for (const [key, value] of Object.entries(meta)) {
    if (['errors', 'xmp', 'xmlns', 'thumbnail'].includes(key)) continue
    // Claves numéricas crudas (tags sin diccionario, p. ej. "544") → se omiten:
    // son ruido técnico sin etiqueta que confundía al visor.
    if (/^\d+$/.test(key)) continue
    if (value === undefined || value === null) continue
    const mapped = EXIF_LABELS[key]
    const sensitivity: MetadataField['sensitivity'] =
      mapped?.sensitivity ?? (key.startsWith('GPS') ? 'high' : 'medium')
    fields.push({
      name: mapped?.label ?? key,
      value: txt(exifValue(key, value)),
      sensitivity,
    })
  }
  return fields
}

/** Ruta de contenedor de cada bloque que devuelve exifr (`mergeOutput:false`). */
const EXIF_BLOCK_PATHS: Record<string, string> = {
  ifd0: 'EXIF IFD0',
  ifd1: 'EXIF IFD1',
  exif: 'EXIF SubIFD',
  gps: 'EXIF GPS',
  interop: 'EXIF Interop',
  iptc: 'IPTC',
}

/** Opciones de exifr para el inventario exhaustivo: bloques separados + XMP/IPTC. */
const STRUCTURED_EXIFR_OPTIONS = { mergeOutput: false, xmp: true, iptc: true } as const

/** ¿Es un objeto plano (no array ni binario ni fecha)? */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date)
  )
}

/**
 * Enumera el resultado estructurado de exifr: cada campo de cada IFD (IFD0,
 * SubIFD, GPS, Interop, IFD1) y cada propiedad XMP, con su ruta real. Las
 * claves desconocidas se listan con su clave cruda (nunca se descartan).
 * Devuelve true si enumeró alguna propiedad XMP.
 */
function pushStructuredExifEntries(meta: Record<string, unknown>, entries: MetaEntry[]): boolean {
  let sawXmp = false
  for (const [blockKey, blockValue] of Object.entries(meta)) {
    if (blockKey === 'errors' || blockKey === 'thumbnail' || blockKey === 'icc') continue
    if (!isPlainObject(blockValue)) continue
    const where = EXIF_BLOCK_PATHS[blockKey]
    if (!where) {
      // Namespace XMP (dc, photoshop, xmp…): una entrada por propiedad.
      // El namespace por defecto llega bajo la clave `xmp` y también se enumera.
      sawXmp = true
      for (const [prop, value] of Object.entries(blockValue)) {
        if (value === undefined || value === null) continue
        entries.push({
          where: 'XMP',
          key: `${blockKey}:${prop}`,
          value: txt(exifValue(prop, value)),
          sensitivity: 'medium',
          removal: 'with-container',
        })
      }
      continue
    }
    for (const [key, value] of Object.entries(blockValue)) {
      if (value === undefined || value === null) continue
      const mapped = EXIF_LABELS[key]
      const binary = value instanceof Uint8Array
      // IPTC no lo elimina la cirugía ligera (JPEG APP13 no se clasifica): se conserva.
      const technical = blockKey === 'iptc'
      entries.push({
        where,
        key,
        label: mapped?.label,
        value: binary ? '' : txt(exifValue(key, value)),
        ...(binary ? { size: value.length, hex: shortHex(value) } : {}),
        sensitivity: mapped?.sensitivity ?? (key.startsWith('GPS') ? 'high' : 'medium'),
        removal: technical ? 'never' : 'with-container',
      })
    }
  }
  return sawXmp
}

/** Ruta del contenedor técnico de cada imagen base (bloque `format`). */
const FORMAT_WHERE: Record<'jpg' | 'png' | 'webp', string> = {
  jpg: 'SOF',
  png: 'IHDR',
  webp: 'VP8',
}

/** Keyword + valor de un chunk de texto PNG (tEXt/zTXt/iTXt); null si no se puede. */
function decodePngTextChunk(type: string, data: Uint8Array): { keyword: string; value: string } | null {
  const nul = data.indexOf(0)
  if (nul < 0) return null
  const keyword = new TextDecoder().decode(data.slice(0, nul))
  if (type === 'tEXt') return { keyword, value: new TextDecoder().decode(data.slice(nul + 1)) }
  if (type === 'zTXt') {
    if (nul + 1 >= data.length) return null
    try {
      return { keyword, value: new TextDecoder().decode(inflateSync(data.slice(nul + 2))) }
    } catch {
      return null
    }
  }
  // iTXt: compresión(1)+método(1) + idioma(0) + traducido(0) + texto.
  const rest = data.slice(nul + 1)
  const langNul = rest.indexOf(0)
  if (langNul < 0) return null
  const translated = rest.slice(langNul + 1)
  const txtNul = translated.indexOf(0)
  return { keyword, value: new TextDecoder().decode(txtNul < 0 ? translated : translated.slice(txtNul + 1)) }
}

/** Entradas del texto incrustado PNG (tEXt/zTXt/iTXt) con su tipo de chunk real. */
function pushPngTextEntries(bytes: Uint8Array, entries: MetaEntry[]): void {
  for (const chunk of listPngChunks(bytes)) {
    if (chunk.type !== 'tEXt' && chunk.type !== 'zTXt' && chunk.type !== 'iTXt') continue
    const decoded = decodePngTextChunk(chunk.type, chunk.data)
    if (!decoded) continue
    entries.push({
      where: `PNG > ${chunk.type}`,
      key: decoded.keyword || chunk.type,
      label: decoded.keyword || undefined,
      value: txt(decoded.value),
      size: chunk.data.length,
      sensitivity: 'medium',
      removal: 'with-container',
    })
  }
}

/** Entero de 2 bytes little-endian (para VP8/VP8L WebP). */
function readU16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0
}

/** ¿El WebP es animado? (chunk `ANMF` o `VP8X` con el flag de animación, bit 0x02). */
function webpIsAnimated(bytes: Uint8Array): boolean {
  const chunks = listWebpChunks(bytes)
  if (chunks.some((c) => c.fourcc === 'ANMF')) return true
  const vp8x = chunks.find((c) => c.fourcc === 'VP8X')
  return !!vp8x && vp8x.data.length >= 1 && (vp8x.data[0] & 0x02) !== 0
}

/** Datos técnicos del formato (ancho/alto/bits) para el visor — NUNCA se borran. */
function formatBlockFor(bytes: Uint8Array, kind: 'jpg' | 'png' | 'webp'): MetadataBlock | null {
  const fields: MetadataField[] = []
  const push = (label: string, value: string): void => {
    fields.push({ name: label, value, sensitivity: 'low', removableIn: 'never' })
  }
  if (kind === 'png') {
    const ihdr = listPngChunks(bytes).find((c) => c.type === 'IHDR')
    if (ihdr && ihdr.data.length >= 13) {
      push('Ancho (px)', String(readU32BE(ihdr.data, 0)))
      push('Alto (px)', String(readU32BE(ihdr.data, 4)))
      push('Bits por canal', String(ihdr.data[8]))
      push('Tipo de color', `#${ihdr.data[9]}`)
    }
  } else if (kind === 'jpg') {
    for (const seg of findJpegSegments(bytes)) {
      const m = seg.marker
      const isSof = (m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)
      if (isSof && seg.payload.length >= 5) {
        push('Bits por muestreo', String(seg.payload[0]))
        push('Alto (px)', String(readU16BE(seg.payload, 1)))
        push('Ancho (px)', String(readU16BE(seg.payload, 3)))
        break
      }
    }
  } else {
    const webpChunks = listWebpChunks(bytes)
    const vp8 = webpChunks.find((c) => c.fourcc === 'VP8 ')
    if (vp8 && vp8.data.length >= 10) {
      push('Ancho (px)', String(readU16LE(vp8.data, 6) & 0x3fff))
      push('Alto (px)', String(readU16LE(vp8.data, 8) & 0x3fff))
    } else {
      const vp8l = webpChunks.find((c) => c.fourcc === 'VP8L')
      if (vp8l && vp8l.data.length >= 5) {
        // 4 bytes little-endian: ancho-1 (14 bits) + alto-1 (14 bits).
        const n = vp8l.data[1] | (vp8l.data[2] << 8) | (vp8l.data[3] << 16) | (vp8l.data[4] << 24)
        push('Ancho (px)', String((n & 0x3fff) + 1))
        push('Alto (px)', String(((n >>> 14) & 0x3fff) + 1))
      } else {
        const vp8x = webpChunks.find((c) => c.fourcc === 'VP8X')
        if (vp8x && vp8x.data.length >= 10) {
          const w = (vp8x.data[4] | (vp8x.data[5] << 8) | (vp8x.data[6] << 16)) + 1
          const h = (vp8x.data[7] | (vp8x.data[8] << 8) | (vp8x.data[9] << 16)) + 1
          push('Ancho (px)', String(w))
          push('Alto (px)', String(h))
        }
      }
    }
  }
  if (fields.length === 0) return null
  return { id: 'format', label: 'Formato de la imagen', removableIn: 'never', fields }
}

/** Escaneo de imágenes base (jpg/png/webp): EXIF vía exifr + XMP/ICC/texto estructural. */
async function scanBaseImage(bytes: Uint8Array, kind: 'jpg' | 'png' | 'webp'): Promise<MetadataReport> {
  const blocks: MetadataBlock[] = []
  const fields: MetadataField[] = []
  const entries: MetaEntry[] = []
  let sawXmp = false
  try {
    const exifr = await import('exifr')
    // Campos por bloques (compatibilidad del visor): EXIF/GPS aplanado, como hasta ahora.
    let meta: Record<string, unknown> | undefined
    if (kind === 'webp') {
      const exifChunk = listWebpChunks(bytes).find((c) => c.fourcc === 'EXIF')
      if (exifChunk) meta = (await exifr.parse(exifChunk.data)) as Record<string, unknown>
    } else {
      meta = (await exifr.parse(bytes)) as Record<string, unknown>
    }
    if (meta && Object.keys(meta).length) fields.push(...toExifFields(meta))
    // Inventario exhaustivo: EXIF por IFD + XMP + IPTC con su ruta real.
    let structured: Record<string, unknown> | undefined
    if (kind === 'webp') {
      const exifChunk = listWebpChunks(bytes).find((c) => c.fourcc === 'EXIF')
      if (exifChunk) structured = (await exifr.parse(exifChunk.data, STRUCTURED_EXIFR_OPTIONS)) as Record<string, unknown>
    } else {
      structured = (await exifr.parse(bytes, STRUCTURED_EXIFR_OPTIONS)) as Record<string, unknown>
    }
    if (structured) sawXmp = pushStructuredExifEntries(structured, entries)
  } catch {
    /* sin EXIF legible */
  }
  if (fields.length) blocks.push({ id: BLOCK_EXIF, label: 'Datos de cámara (EXIF/GPS)', fields, removableIn: 'light' })

  if (kind === 'jpg') {
    const segments = findJpegSegments(bytes)
    const hasXmp = segments.some(
      (s) => s.marker === 0xe1 && String.fromCharCode(...s.payload.slice(0, 48)).startsWith('http://ns.adobe.com/xap/1.0/'),
    )
    const hasIcc = segments.some(
      (s) => s.marker === 0xe2 && String.fromCharCode(...s.payload.slice(0, 16)).startsWith('ICC_PROFILE\x00'),
    )
    if (hasXmp) {
      blocks.push({ id: BLOCK_XMP, label: 'Metadatos XMP', removableIn: 'light', fields: [{ name: 'XMP', value: 'Presentes', sensitivity: 'medium' }] })
      if (!sawXmp) entries.push({ where: 'XMP', key: 'xmp', label: 'Metadatos XMP', value: 'Presentes', sensitivity: 'medium', removal: 'with-container' })
    }
    if (hasIcc) {
      blocks.push({ id: BLOCK_ICC, label: 'Perfil de color (ICC)', removableIn: 'never', fields: [{ name: 'Perfil ICC', value: 'Presentes', sensitivity: 'low' }] })
      entries.push({ where: 'ICC', key: 'ICC_PROFILE', label: 'Perfil de color (ICC)', value: 'Presentes', sensitivity: 'low', removal: 'never' })
    }
    const com = listJpegCom(bytes)
    if (com.length) {
      blocks.push({
        id: BLOCK_TEXT,
        label: 'Comentarios',
        removableIn: 'light',
        fields: com.map((c) => ({ name: 'Comentario', value: txt(c), sensitivity: 'low' })),
      })
      for (const c of com) {
        entries.push({ where: 'JPEG > COM', key: 'COM', label: 'Comentario', value: txt(c), sensitivity: 'low', removal: 'with-container' })
      }
    }
  } else if (kind === 'png') {
    const chunks = listPngChunks(bytes)
    const textFields = listPngText(bytes)
    if (textFields.length) {
      blocks.push({
        id: BLOCK_TEXT,
        label: 'Texto incrustado',
        removableIn: 'light',
        fields: textFields.map((t) => ({ name: t.keyword || 'Texto', value: txt(t.value), sensitivity: 'medium' })),
      })
    }
    pushPngTextEntries(bytes, entries)
    if (chunks.some((c) => c.type === 'iCCP')) {
      blocks.push({ id: BLOCK_ICC, label: 'Perfil de color (ICC)', removableIn: 'never', fields: [{ name: 'Perfil ICC', value: 'Presentes', sensitivity: 'low' }] })
      entries.push({ where: 'ICC', key: 'iCCP', label: 'Perfil de color (ICC)', value: 'Presentes', sensitivity: 'low', removal: 'never' })
    }
    if (chunks.some((c) => c.type === 'iTXt' && String.fromCharCode(...c.data.slice(0, 16)).includes('com.adobe.xmp'))) {
      blocks.push({ id: BLOCK_XMP, label: 'Metadatos XMP', removableIn: 'light', fields: [{ name: 'XMP', value: 'Presentes', sensitivity: 'medium' }] })
      if (!sawXmp) entries.push({ where: 'XMP', key: 'xmp', label: 'Metadatos XMP', value: 'Presentes', sensitivity: 'medium', removal: 'with-container' })
    }
  } else {
    const chunks = listWebpChunks(bytes)
    if (chunks.some((c) => c.fourcc === 'XMP ')) {
      blocks.push({ id: BLOCK_XMP, label: 'Metadatos XMP', removableIn: 'light', fields: [{ name: 'XMP', value: 'Presentes', sensitivity: 'medium' }] })
      if (!sawXmp) entries.push({ where: 'XMP', key: 'xmp', label: 'Metadatos XMP', value: 'Presentes', sensitivity: 'medium', removal: 'with-container' })
    }
    if (chunks.some((c) => c.fourcc === 'ICCP')) {
      blocks.push({ id: BLOCK_ICC, label: 'Perfil de color (ICC)', removableIn: 'never', fields: [{ name: 'Perfil ICC', value: 'Presentes', sensitivity: 'low' }] })
      entries.push({ where: 'ICC', key: 'ICCP', label: 'Perfil de color (ICC)', value: 'Presentes', sensitivity: 'low', removal: 'never' })
    }
  }

  const format = formatBlockFor(bytes, kind)
  if (format) {
    blocks.push(format)
    for (const field of format.fields) {
      entries.push({
        where: FORMAT_WHERE[kind],
        key: field.name,
        label: field.name,
        value: field.value,
        sensitivity: field.sensitivity,
        removal: 'never',
      })
    }
  }

  const risks: RegenerationRisk[] = []
  try {
    if (kind === 'webp' && webpIsAnimated(bytes)) {
      risks.push({
        id: 'webp-animated',
        label: 'WebP animado',
        detail: 'El modo profundo conserva solo el primer fotograma del WebP animado.',
        severity: 'medium',
        affects: 'deep',
      })
    }
    const orientation = await readOrientation(bytes, kind)
    if (orientation !== undefined && orientation > 1) {
      risks.push({
        id: 'image-orientation',
        label: 'Orientación EXIF',
        detail: 'El modo ligero re-codifica la imagen para enderezarla según su orientación EXIF: se pierde calidad.',
        severity: 'medium',
        affects: 'light',
      })
    }
  } catch {
    /* sin avisos */
  }

  const flat = blocks.flatMap((b) => b.fields)
  return { fields: flat, count: flat.length, blocks, entries, risks }
}

/** Oficina OOXML: etiquetas a detectar → etiqueta + sensibilidad (prefijo ignorado). */
const OFFICE_TAGS: Record<string, { label: string; sensitivity: MetadataField['sensitivity'] }> = {
  creator: { label: 'Autor', sensitivity: 'medium' },
  lastModifiedBy: { label: 'Última modificación por', sensitivity: 'medium' },
  title: { label: 'Título', sensitivity: 'low' },
  subject: { label: 'Asunto', sensitivity: 'low' },
  description: { label: 'Descripción', sensitivity: 'medium' },
  keywords: { label: 'Palabras clave', sensitivity: 'low' },
  category: { label: 'Categoría', sensitivity: 'low' },
  created: { label: 'Fecha de creación', sensitivity: 'medium' },
  modified: { label: 'Fecha de modificación', sensitivity: 'medium' },
  lastPrinted: { label: 'Última impresión', sensitivity: 'low' },
  revision: { label: 'Revisión', sensitivity: 'low' },
  contentStatus: { label: 'Estado', sensitivity: 'low' },
  Application: { label: 'Aplicación', sensitivity: 'medium' },
  Company: { label: 'Empresa', sensitivity: 'medium' },
  AppVersion: { label: 'Versión de la aplicación', sensitivity: 'low' },
  TotalTime: { label: 'Tiempo total de edición', sensitivity: 'low' },
}

/** Recorre el objeto XML en busca de hojas con etiquetas conocidas. */
function walkXmlTags(node: unknown, out: Map<string, Set<string>>, depth = 0): void {
  if (depth > 12 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walkXmlTags(item, out, depth + 1)
    return
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') {
      const local = key.includes(':') ? key.split(':').pop()! : key
      const mapped = OFFICE_TAGS[local]
      if (mapped) {
        const set = out.get(local) ?? new Set<string>()
        set.add(String(value))
        out.set(local, set)
      }
    } else if (value !== null && typeof value === 'object') {
      walkXmlTags(value, out, depth + 1)
    }
  }
}

/** Hoja de un XML de OOXML: nombre de etiqueta crudo (con prefijo) + valor. */
interface XmlLeaf {
  key: string
  value: string
}

/** Recorre el XML y devuelve TODAS las hojas (nombre crudo con prefijo, sin allowlist). */
function collectXmlLeaves(node: unknown, out: XmlLeaf[], depth = 0): void {
  if (depth > 20 || node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const item of node) collectXmlLeaves(item, out, depth + 1)
    return
  }
  if (typeof node !== 'object') return
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith('@_') || key === '#text') continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push({ key, value: String(value) })
    } else {
      collectXmlLeaves(value, out, depth + 1)
    }
  }
}

/** Texto de las hojas de un nodo (concatenado; ignora atributos). */
function leafText(node: unknown): string {
  const parts: string[] = []
  const walk = (n: unknown): void => {
    if (n === null || n === undefined) return
    if (typeof n === 'string' || typeof n === 'number' || typeof n === 'boolean') {
      parts.push(String(n))
      return
    }
    if (Array.isArray(n)) {
      for (const item of n) walk(item)
      return
    }
    if (typeof n === 'object') {
      for (const [key, value] of Object.entries(n as Record<string, unknown>)) {
        if (key.startsWith('@_')) continue
        walk(value)
      }
    }
  }
  walk(node)
  return parts.join(', ')
}

/** Enumera cada `property` de `docProps/custom.xml` con su atributo `name` crudo. */
function pushCustomPropertyEntries(xml: string, entries: MetaEntry[]): void {
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })
    const parsed = parser.parse(xml) as Record<string, unknown>
    const root = (parsed['Properties'] ?? parsed) as Record<string, unknown>
    const raw = root['property']
    const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const obj = item as Record<string, unknown>
      const name = obj['@_name'] ?? obj['@_pid'] ?? 'property'
      entries.push({
        where: 'docProps/custom.xml',
        key: String(name),
        value: txt(leafText(obj)),
        sensitivity: 'medium',
        removal: 'with-container',
      })
    }
  } catch {
    /* custom.xml sin parsear: se ignora */
  }
}

/** Escaneo OOXML: docProps (core/app) como bloque 'props' + custom/comments/thumbnail. */
function scanOffice(bytes: Uint8Array): MetadataReport {
  try {
    const files = unzipSync(bytes)
    const blocks: MetadataBlock[] = []
    const fields: MetadataField[] = []
    const entries: MetaEntry[] = []
    const parser = new XMLParser({ ignoreAttributes: true })
    for (const prop of ['docProps/core.xml', 'docProps/app.xml']) {
      if (!files[prop]) continue
      try {
        const parsed = parser.parse(strFromU8(files[prop]!)) as Record<string, unknown>
        const tags = new Map<string, Set<string>>()
        walkXmlTags(parsed, tags)
        for (const [key, values] of tags) {
          const mapped = OFFICE_TAGS[key]
          if (mapped) {
            fields.push({ name: mapped.label, value: txt([...values].join(', ')), sensitivity: mapped.sensitivity })
          }
        }
        // Inventario exhaustivo: TODAS las hojas con su clave cruda (incluidas las no mapeadas).
        const leaves: XmlLeaf[] = []
        collectXmlLeaves(parsed, leaves)
        for (const leaf of leaves) {
          const local = leaf.key.includes(':') ? leaf.key.split(':').pop()! : leaf.key
          const mapped = OFFICE_TAGS[local]
          entries.push({
            where: prop,
            key: leaf.key,
            label: mapped?.label,
            value: txt(leaf.value),
            sensitivity: mapped?.sensitivity ?? 'medium',
            removal: 'with-container',
          })
        }
      } catch {
        /* parte sin parsear: se ignora */
      }
    }
    if (fields.length) blocks.push({ id: 'props', label: 'Propiedades del documento', fields, removableIn: 'light' })

    if (files['docProps/custom.xml']) {
      blocks.push({ id: 'custom', label: 'Propiedades personalizadas', removableIn: 'light', fields: [{ name: 'Metadata', value: 'Presentes', sensitivity: 'medium' }] })
      pushCustomPropertyEntries(strFromU8(files['docProps/custom.xml']!), entries)
    }
    const commentHits = Object.keys(files).filter(
      (n) => /(comment|people\.xml|person\.xml)/i.test(n) && !n.startsWith('docProps/'),
    )
    if (commentHits.length) {
      blocks.push({ id: 'comments', label: 'Comentarios y revisores', removableIn: 'light', fields: [{ name: 'Partes', value: commentHits.join(', '), sensitivity: 'high' }] })
    }
    const thumbHits = Object.keys(files).filter((n) => /thumbnail/i.test(n))
    if (thumbHits.length) {
      blocks.push({ id: 'thumb', label: 'Miniatura', removableIn: 'light', fields: [{ name: 'Parte', value: thumbHits.join(', '), sensitivity: 'low' }] })
    }
    const risks: RegenerationRisk[] = []
    if (Object.keys(files).some((n) => /vbaProject|vbaData/i.test(n))) {
      risks.push({
        id: 'office-macros',
        label: 'Macros',
        detail: 'El modo profundo elimina las macros del documento (vbaProject).',
        severity: 'high',
        affects: 'deep',
      })
    }
    const flat = blocks.flatMap((b) => b.fields)
    return { fields: flat, count: flat.length, blocks, entries, risks }
  } catch {
    return EMPTY_REPORT
  }
}

/** Escaneo Markdown: claves del frontmatter YAML. */
async function scanMd(bytes: Uint8Array): Promise<MetadataReport> {
  const { fields } = parseFrontmatter(new TextDecoder().decode(bytes))
  const blocks: MetadataBlock[] = fields.length
    ? [{ id: 'frontmatter', label: 'Frontmatter YAML', removableIn: 'light', fields }]
    : []
  // Inventario exhaustivo: una entrada por clave del frontmatter con su clave cruda.
  const entries: MetaEntry[] = fields.map((field) => ({
    where: 'frontmatter',
    key: field.name,
    label: field.name,
    value: field.value,
    sensitivity: field.sensitivity,
    removal: 'with-container',
  }))
  return {
    fields,
    count: fields.length,
    blocks,
    entries,
  }
}

/** Encuentra el dominio (audio/video/imagen-extra) de un kind, o null. */
function domainOf(kind: FileKind) {
  if (audioDomain.kinds.includes(kind)) return audioDomain
  if (videoDomain.kinds.includes(kind)) return videoDomain
  if (imagePlusDomain.kinds.includes(kind)) return imagePlusDomain
  return null
}

/**
 * Reporta la metadata encontrada por kind, agrupada en bloques. NUNCA lanza:
 * errores de parseo → report vacío. Es lo que alimenta el visor de la tool.
 */
export async function scanMetadata(input: { bytes: Uint8Array; kind: FileKind }): Promise<MetadataReport> {
  switch (input.kind) {
    case 'pdf':
      return scanPdf(input.bytes)
    case 'docx':
    case 'xlsx':
    case 'pptx':
      return scanOffice(input.bytes)
    case 'md':
      return scanMd(input.bytes)
    case 'jpg':
    case 'png':
    case 'webp':
      return scanBaseImage(input.bytes, input.kind)
    default: {
      const domain = domainOf(input.kind)
      if (domain) return domain.scan(input.bytes)
      return EMPTY_REPORT
    }
  }
}

/* ── Strip: PDF ── */

/**
 * Elimina TODAS las claves del diccionario de información (lossless: la clave
 * desaparece). Se recogen las claves antes de borrar para no mutar el
 * diccionario mientras se itera.
 */
function removeAllInfoEntries(doc: PDFDocument): void {
  const info = doc.context.lookup(doc.context.trailerInfo.Info)
  if (!(info instanceof PDFDict)) return
  const keys = info.keys()
  for (const key of keys) info.delete(key)
}

/** PDF ligero (lossless): borra TODAS las claves del Info dict y el stream XMP. */
async function stripPdfLight(bytes: Uint8Array, config: StripConfig): Promise<Uint8Array> {
  // Sin bloques seleccionados: passthrough de los mismos bytes (nada que limpiar).
  if (config.blocks.length === 0) return bytes.slice()
  const doc = await PDFDocument.load(bytes, { updateMetadata: false })
  const wantInfo = config.blocks.includes('info')
  const wantXmp = config.blocks.includes('xmp')
  if (wantInfo) {
    // Se eliminan TODAS las claves (no solo Title/Author/…): una clave
    // personalizada (`/MyCustomKey`) también desaparece.
    removeAllInfoEntries(doc)
  }
  if (wantXmp && doc.catalog.has(PDFName.of('Metadata'))) {
    doc.catalog.delete(PDFName.of('Metadata'))
  }
  return new Uint8Array(await doc.save())
}

/** API tipada de pdf.js (build legacy; mismo patrón que extract-text). */
type PdfJsApi = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

let pdfjsPromise: Promise<PdfJsApi> | null = null

function loadPdfjs(): Promise<PdfJsApi> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then(async (pdfjs) => {
      if (typeof window !== 'undefined' && !pdfjs.GlobalWorkerOptions.workerSrc) {
        const { default: workerUrl } = await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url')
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      }
      return pdfjs
    })
  }
  return pdfjsPromise
}

/** Renderiza cada página a PNG e incrusta la imagen en un PDF NUEVO (sin metadata). */
async function stripPdfDeep(input: EngineInput, report: Reporter): Promise<Uint8Array> {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('Rasterizar el PDF requiere el navegador')
  }
  const pdfjs = await loadPdfjs()
  const source = await pdfjs.getDocument({ data: input.bytes.slice() }).promise
  const out = await PDFDocument.create({ updateMetadata: false })
  try {
    for (let i = 1; i <= source.numPages; i++) {
      report('Rasterizando páginas', Math.round(30 + (i / source.numPages) * 60))
      const page = await source.getPage(i)
      const viewport = page.getViewport({ scale: 1.5 }) // ~150 dpi
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(Math.max(1, viewport.width))
      canvas.height = Math.ceil(Math.max(1, viewport.height))
      await page.render({ canvas, viewport }).promise
      const pngBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        canvas.toBlob(
          (b) => (b ? b.arrayBuffer().then(resolve) : reject(new Error('No se pudo generar la página'))),
          'image/png',
        )
      })
      const png = new Uint8Array(pngBytes)
      const base = page.getViewport({ scale: 1 })
      const widthPt = (base.width * 72) / 96
      const heightPt = (base.height * 72) / 96
      const image = await out.embedPng(png)
      const target = out.addPage([widthPt, heightPt])
      target.drawImage(image, { x: 0, y: 0, width: widthPt, height: heightPt })
    }
  } finally {
    try {
      await (source as unknown as { loadingTask: { destroy(): Promise<void> } }).loadingTask.destroy()
    } catch {
      /* ya liberado */
    }
  }
  return new Uint8Array(await out.save())
}

/* ── Strip: Office (zip OOXML) ── */

/** ¿Se elimina una parte del ZIP según su bloque y el modo/bloques pedidos? */
function shouldDrop(block: string, config: StripConfig): boolean {
  return config.mode === 'deep' || (config.blocks.length > 0 && config.blocks.includes(block))
}

/** Limpia OOXML (light o deep): elimina docProps/comentarios/miniatura/custom según política. */
async function stripOffice(bytes: Uint8Array, config: StripConfig): Promise<Uint8Array> {
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  const files = unzipSync(bytes)
  const clean: Record<string, Uint8Array> = {}
  for (const [name, data] of Object.entries(files)) {
    // `props` y `custom` son partes DISTINTAS: no se pueden arrastrar sin seleccionar
    // (docProps/custom.xml vive en la misma carpeta que core/app).
    const isProps = name === 'docProps/core.xml' || name === 'docProps/app.xml'
    const isCustom = name === 'docProps/custom.xml' || name.startsWith('customXml/')
    const isComments = /(comment|people\.xml|person\.xml)/i.test(name) && !name.startsWith('docProps/')
    const isThumb = /thumbnail/i.test(name)
    const isMacro = /vbaProject|vbaData/i.test(name)
    const drop =
      (isProps && shouldDrop('props', config)) ||
      (isComments && shouldDrop('comments', config)) ||
      (isThumb && shouldDrop('thumb', config)) ||
      (isCustom && shouldDrop('custom', config)) ||
      (isMacro && config.mode === 'deep')
    if (!drop) clean[name] = data
  }
  return zipSync(clean)
}

/* ── Strip: imágenes base ── */

/** JPEG de salida para el re-encode profundo (calidad). */
function qualityFor(kind: 'jpg' | 'png' | 'webp'): number {
  return kind === 'jpg' ? 0.92 : 0.95
}

/**
 * Lee el EXIF `Orientation` (1..8, numérico). undefined si la foto no guarda
 * orientación. Usa exifr sin traducción de valores (solo lectura del IFD0).
 */
async function readOrientation(bytes: Uint8Array, kind: 'jpg' | 'png' | 'webp'): Promise<number | undefined> {
  try {
    const exifr = await import('exifr')
    const opts = {
      translateValues: false,
      translateKeys: true,
      reviveValues: false,
      silentErrors: true,
    }
    let meta: Record<string, unknown> | undefined
    if (kind === 'webp') {
      const exifChunk = listWebpChunks(bytes).find((c) => c.fourcc === 'EXIF')
      if (!exifChunk) return undefined
      meta = (await exifr.parse(exifChunk.data, opts)) as Record<string, unknown>
    } else {
      meta = (await exifr.parse(bytes, opts)) as Record<string, unknown>
    }
    const orientation = meta?.['Orientation']
    return typeof orientation === 'number' ? orientation : undefined
  } catch {
    return undefined
  }
}

/**
 * Devuelve un canvas con la EXIF Orientation APLICADA a los píxeles (gracias a
 * esto, al borrar el tag la foto no se gira: es el mismo criterio que mat2/
 * GdkPixbuf `apply_embedded_orientation`). Orientación 1 = sin cambios.
 */
async function buildOrientedCanvas(bytes: Uint8Array, kind: 'jpg' | 'png' | 'webp'): Promise<HTMLCanvasElement> {
  const orientation = await readOrientation(bytes, kind)
  const { canvas } = await decodeToCanvas(bytes)
  if (!orientation || orientation === 1) return canvas
  const swap = orientation >= 5 && orientation <= 8
  const out = document.createElement('canvas')
  out.width = swap ? canvas.height : canvas.width
  out.height = swap ? canvas.width : canvas.height
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('No se pudo preparar el lienzo')
  ctx.translate(Math.round(out.width / 2), Math.round(out.height / 2))
  const matrix: Record<number, [number, number, number, number]> = {
    2: [-1, 0, 0, 1],
    3: [-1, 0, 0, -1],
    4: [1, 0, 0, -1],
    5: [0, 1, 1, 0],
    6: [0, 1, -1, 0],
    7: [0, -1, -1, 0],
    8: [0, -1, 1, 0],
  }
  const t = matrix[orientation] ?? [1, 0, 0, 1]
  ctx.transform(t[0], t[1], t[2], t[3], 0, 0)
  ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2)
  return out
}

/**
 * Re-encode por canvas con orientación aplicada (deep): se vuelve a comprimir,
 * se endereza la foto si hace falta y se elimina TODO rastro. Los encoders del
 * navegador inyectan su propia metadata (APP0-JFIF, sRGB/gAMA) → se limpia.
 * El perfil ICC (dato "importante") se conserva del original.
 */
async function deepCleanImage(bytes: Uint8Array, kind: 'jpg' | 'png' | 'webp'): Promise<Uint8Array> {
  const canvas = await buildOrientedCanvas(bytes, kind)
  const mime = kind === 'jpg' ? 'image/jpeg' : kind === 'png' ? 'image/png' : 'image/webp'
  let out = await canvasToBytes(canvas, mime, qualityFor(kind))
  canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  if (kind === 'jpg') out = stripJpegAllSegments(out)
  else if (kind === 'png') out = stripPngDeep(out)
  else out = stripWebpMetadata(out)
  return preserveIcc(bytes, kind, out)
}

/** Cirugía lossless de un conjunto de bloques (compartida por light). */
function stripImageBlocks(bytes: Uint8Array, kind: 'jpg' | 'png' | 'webp', blockIds: string[]): Uint8Array {
  const blocks = new Set(blockIds)
  return kind === 'png'
    ? stripPngMetadata(bytes, blocks)
    : kind === 'webp'
      ? stripWebpMetadata(bytes, blocks)
      : stripJpegMetadata(bytes, blocks)
}

/* ── Strip: restos (passthrough) ── */

/** Formatos sin metadata estándar → passthrough de los mismos bytes. */
const PLAIN_KINDS: ReadonlySet<FileKind> = new Set([
  'txt', 'csv', 'xml', 'json', 'html', 'yaml', 'toml', 'zip', 'epub', 'rtf', 'odt', 'svg', 'adei',
])

/* ── Engine ── */

/**
 * Elimina la metadata y devuelve el archivo limpio.
 * El modo y los bloques se leen de `input.config` (ver `readConfig`).
 */
export async function stripMetadata(
  input: EngineInput,
  onProgress?: (e: ProgressEvent) => void,
): Promise<ProcessResult> {
  if (!input.bytes || input.bytes.length === 0) throw new Error('Se necesita un archivo')
  const report = makeReporter(onProgress)
  const config = readConfig(input.config)
  report('Leyendo', 10)

  switch (input.kind) {
    case 'pdf': {
      report('Limpiando metadata', 50)
      const bytes = config.mode === 'deep' ? await stripPdfDeep(input, report) : await stripPdfLight(input.bytes, config)
      return done('pdf', cleanedName(input.name), input.bytes, bytes, report)
    }
    case 'docx':
    case 'xlsx':
    case 'pptx': {
      report('Limpiando metadata', 50)
      const bytes = await stripOffice(input.bytes, config)
      return done(input.kind, cleanedName(input.name), input.bytes, bytes, report)
    }
    case 'md': {
      report('Limpiando metadata', 50)
      // Light sin bloques → passthrough; si no, (o deep) se quita el frontmatter.
      const content = new TextDecoder().decode(input.bytes)
      const shouldStrip = config.mode === 'deep' || config.blocks.includes('frontmatter')
      const rest = shouldStrip ? parseFrontmatter(content).rest : content
      return done('md', cleanedName(input.name), input.bytes, new TextEncoder().encode(rest), report)
    }
    case 'jpg':
    case 'png':
    case 'webp': {
      report('Limpiando metadata', 50)
      const kind = input.kind
      let bytes: Uint8Array
      if (config.mode === 'deep') {
        bytes = await deepCleanImage(input.bytes, kind)
      } else if (config.blocks.length === 0) {
        bytes = input.bytes.slice()
      } else {
        const orientation = await readOrientation(input.bytes, kind)
        if (orientation !== undefined && orientation > 1) {
          // Foto con orientación EXIF (típico de móvil tomada en vertical):
          // se enderezan los píxeles y luego se limpia, para que la foto NO se
          // gire al eliminar el tag (mismo criterio que mat2).
          const oriented = await deepCleanImage(input.bytes, kind)
          bytes = stripImageBlocks(oriented, kind, config.blocks)
        } else {
          bytes = stripImageBlocks(input.bytes, kind, config.blocks)
        }
      }
      return done(input.kind, cleanedName(input.name), input.bytes, bytes, report)
    }
    default: {
      if (PLAIN_KINDS.has(input.kind)) {
        return done(input.kind, cleanedName(input.name), input.bytes, input.bytes.slice(), report)
      }
      const domain = domainOf(input.kind)
      if (domain) {
        report('Limpiando metadata', 50)
        const bytes = await domain.strip(input.bytes, input.kind, config, report)
        return done(input.kind, cleanedName(input.name), input.bytes, bytes, report)
      }
      throw new Error('La limpieza de metadata para este formato llega en una fase próxima')
    }
  }
}