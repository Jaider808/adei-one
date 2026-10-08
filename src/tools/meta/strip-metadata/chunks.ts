/**
 * ADEI-ONE — Cirugía binaria base de "Eliminar metadata": JPEG, PNG y WebP.
 *
 * Es lossless PURA (sin canvas, Node-testable): se recorren las estructuras
 * binarias y se descartan SOLO los segmentos/chunks que cargan metadata
 * (EXIF/GPS/XMP/ICCP/texto incrustado/tiempo). Conserva píxeles, transparencia
 * y datos de imagen visibles.
 *
 * Soporta selección por BLOQUES (los IDs que envía el wizard en `blocks`):
 * - 'exif'  → EXIF/GPS      (JPEG APP1 Exif, PNG eXIf, WebP EXIF)
 * - 'xmp'   → XMP           (JPEG APP1 Adobe XMP, WebP XMP )
 * - 'icc'   → perfil ICC    (JPEG APP2 ICC_PROFILE, PNG iCCP, WebP ICCP)
 * - 'text'  → comentarios   (JPEG COM, PNG tEXt/zTXt/iTXt/tIME)
 * Si no se pasa bloque (undefined) se eliminan TODOS los anteriores (legacy).
 *
 * También exporta accesos de LECTURA para el visor de metadata:
 * findJpegSegments / listJpegCom / listPngChunks / listPngText / listWebpChunks.
 */
import { deflateSync, inflateSync } from 'fflate'

/** ID de bloque para EXIF/GPS. */
export const BLOCK_EXIF = 'exif'
/** ID de bloque para XMP. */
export const BLOCK_XMP = 'xmp'
/** ID de bloque para ICC. */
export const BLOCK_ICC = 'icc'
/** ID de bloque para texto/comentarios/tiempo. */
export const BLOCK_TEXT = 'text'

/* ── Ayudantes binarios ── */

/** Texto ASCII → bytes (para construir cabeceras/etiquetas). */
function asciiText(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0) & 0xff))
}

/** Une varios `Uint8Array` en uno nuevo (no muta la entrada). */
export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Lee 4 bytes ASCII desde `offset` (FourCC WebP / tipo de chunk PNG). */
export function asciiAt(bytes: Uint8Array, offset: number): string {
  return (
    String.fromCharCode(bytes[offset]) +
    String.fromCharCode(bytes[offset + 1]) +
    String.fromCharCode(bytes[offset + 2]) +
    String.fromCharCode(bytes[offset + 3])
  )
}

/** Entero de 2 bytes big-endian (>>> 0 para que 0xFFFF no sea negativo). */
export function readU16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 8) | bytes[offset + 1]) >>> 0
}

/** Entero de 4 bytes big-endian sin signo. */
export function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
  )
}

/** Entero de 4 bytes little-endian sin signo (tamaños RIFF). */
export function readU32LE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  )
}

/** Escribe un entero de 4 bytes little-endian (muta el array; uso interno). */
export function writeU32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

/** Escribe un entero de 4 bytes big-endian (muta el array; uso interno). */
export function writeU32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

/** Entero → 4 bytes big-endian (nuevo array). */
function u32beBytes(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

/** Entero → 2 bytes big-endian (nuevo array). */
function u16beBytes(n: number): Uint8Array {
  return Uint8Array.from([(n >> 8) & 0xff, n & 0xff])
}

/** Entero → 2 bytes little-endian (nuevo array). */
function u16leBytes(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >> 8) & 0xff])
}

/** Entero → 4 bytes little-endian (nuevo array). */
function u32leBytes(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])
}

/* ── CRC-32 (PNG) ── */

/** CRC-32 estándar (polinomio 0xEDB88320). Usado al re-insertar chunks PNG. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Chunk PNG completo (length + type + data + crc) para re-inserciones. */
export function pngChunkBytes(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = asciiText(type)
  const crc = crc32(concat([typeBytes, data]))
  return concat([u32beBytes(data.length), typeBytes, data, u32beBytes(crc)])
}

/* ── Perfil de color ICC: extraer y re-insertar (se conserva siempre) ── */

/** Chunk WebP/RIFF completo (fourcc + size + data + pad). */
function webpChunkBytes(fourcc: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 === 1 ? Uint8Array.of(0) : new Uint8Array()
  return concat([asciiText(fourcc), u32leBytes(data.length), data, pad])
}

/**
 * Extrae el perfil ICC crudo de una imagen (JPEG APP2, PNG iCCP, WebP ICCP).
 * Devuelve null si no hay perfil (nunca lanza).
 */
export function extractIcc(bytes: Uint8Array, kind: ('jpg' | 'png' | 'webp') | string): Uint8Array | null {
  try {
    if (kind === 'jpg') {
      const segs = findJpegSegments(bytes)
        .filter((s) => s.marker === 0xe2 && String.fromCharCode(...s.payload.slice(0, 14)).startsWith('ICC_PROFILE\0'))
        .map((s) => ({ seq: s.payload[12] ?? 0, data: s.payload.slice(14) }))
        .sort((a, b) => a.seq - b.seq)
      if (segs.length === 0) return null
      return concat(segs.map((s) => s.data))
    }
    if (kind === 'png') {
      const chunk = listPngChunks(bytes).find((c) => c.type === 'iCCP')
      if (!chunk) return null
      const nul = chunk.data.indexOf(0)
      if (nul < 0 || chunk.data[nul + 1] !== 0) return null
      return inflateSync(chunk.data.slice(nul + 2))
    }
    if (kind === 'webp') {
      const chunk = listWebpChunks(bytes).find((c) => c.fourcc === 'ICCP')
      return chunk ? chunk.data.slice() : null
    }
    return null
  } catch {
    return null
  }
}

/** Re-inserta un perfil ICC en un JPEG (segmento(s) APP2 tras el SOI). */
export function insertJpegIcc(bytes: Uint8Array, profile: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes.slice()
  if (profile.length === 0) return bytes.slice()
  const parts: Uint8Array[] = [bytes.slice(0, 2)]
  const perSegment = 65533 - 14 // payload máximo por APP2 (18 bytes de cabecera)
  const segments = Math.max(1, Math.ceil(profile.length / perSegment))
  for (let seq = 1; seq <= segments; seq++) {
    const from = (seq - 1) * perSegment
    const data = profile.slice(from, Math.min(from + perSegment, profile.length))
    const payload = concat([asciiText('ICC_PROFILE\0'), Uint8Array.of(seq, segments), data])
    parts.push(Uint8Array.of(0xff, 0xe2), u16beBytes(2 + payload.length), payload)
  }
  parts.push(bytes.slice(2))
  return concat(parts)
}

/** Re-inserta un perfil ICC en un PNG (chunk iCCP tras IHDR). */
export function insertPngIcc(bytes: Uint8Array, profile: Uint8Array): Uint8Array {
  if (profile.length === 0) return bytes.slice()
  const ihdr = listPngChunks(bytes).find((c) => c.type === 'IHDR')
  if (!ihdr) return bytes.slice()
  const compressed = deflateSync(profile)
  const data = concat([asciiText('ICC'), Uint8Array.of(0), Uint8Array.of(0), compressed])
  const chunk = pngChunkBytes('iCCP', data)
  return concat([bytes.slice(0, ihdr.end), chunk, bytes.slice(ihdr.end)])
}

/**
 * Re-inserta un perfil ICC en un WebP respetando el orden que exige libwebp:
 * `VP8X` SIEMPRE primero (cuando existe), el `ICCP` después de `VP8X` y antes
 * de los píxeles. Si el WebP es simple (sin `VP8X`) los píxeles van primero, de
 * modo que la metadata nunca queda como primer chunk. Re-escribe el tamaño RIFF.
 */
export function insertWebpIcc(bytes: Uint8Array, profile: Uint8Array): Uint8Array {
  if (profile.length === 0) return bytes.slice()
  if (bytes.length < 12 || asciiAt(bytes, 0) !== 'RIFF' || asciiAt(bytes, 8) !== 'WEBP') return bytes.slice()
  return rebuildWebp(bytes, [{ fourcc: 'ICCP', data: profile }], new Set(['ICCP', 'EXIF', 'XMP ']))
}

/** Conserva el perfil ICC del ORIGINAL dentro del resultado limpio. */
export function preserveIcc(original: Uint8Array, kind: 'jpg' | 'png' | 'webp', cleaned: Uint8Array): Uint8Array {
  const profile = extractIcc(original, kind)
  if (!profile) return cleaned
  if (kind === 'jpg') return insertJpegIcc(cleaned, profile)
  if (kind === 'png') return insertPngIcc(cleaned, profile)
  return insertWebpIcc(cleaned, profile)
}

/* ── EXIF mínimo: conservar SOLO la orientación sin re-codificar ── */

/** Byte order del TIFF: 'II' (little-endian) o 'MM' (big-endian). */
export type TiffByteOrder = 'II' | 'MM'

/** Prefijo EXIF estándar de los datos crudos de un segmento APP1 ('Exif\0\0'). */
const EXIF_PREFIX = 'Exif\x00\x00'

/** ¿Unos datos EXIF crudos empiezan por 'Exif\0\0'? (WebP/PNG suelen no llevarlo). */
function hasExifPrefix(data: Uint8Array): boolean {
  return data.length >= 6 && String.fromCharCode(...data.slice(0, 6)) === EXIF_PREFIX
}

/**
 * Construye un TIFF mínimo con UNA sola entrada IFD0: `Orientation` (tag 0x0112,
 * tipo SHORT=3, count 1). Conserva el byte order pedido. Layout:
 * cabecera(8) + nº entradas(2) + entrada(12) + siguiente IFD(4) = 26 bytes.
 * El valor va en los 2 PRIMEROS bytes del campo de 4 (SHORT en TIFF inline).
 */
export function minimalOrientationTiff(orientation: number, byteOrder: TiffByteOrder): Uint8Array {
  const le = byteOrder === 'II'
  const u16 = le ? u16leBytes : u16beBytes
  const u32 = le ? u32leBytes : u32beBytes
  const value = le
    ? Uint8Array.of(orientation & 0xff, (orientation >>> 8) & 0xff, 0, 0)
    : Uint8Array.of((orientation >>> 8) & 0xff, orientation & 0xff, 0, 0)
  return concat([
    asciiText(byteOrder), // 'II' | 'MM'
    u16(0x2a), // magic 42
    u32(8), // offset a IFD0
    u16(1), // nº de entradas
    u16(0x0112), // tag Orientation
    u16(3), // tipo SHORT
    u32(1), // count
    value, // valor en los 2 primeros bytes
    u32(0), // siguiente IFD: ninguno
  ])
}

/**
 * Datos EXIF mínimos (solo Orientation) a partir de los EXIF originales:
 * conserva el byte order TIFF y el prefijo 'Exif\0\0' si el original lo llevaba.
 * Devuelve null si los datos no empiezan por un byte order legible (nunca lanza).
 */
export function minimalOrientationExif(originalExif: Uint8Array, orientation: number): Uint8Array | null {
  const prefixed = hasExifPrefix(originalExif)
  const start = prefixed ? 6 : 0
  if (originalExif.length < start + 2) return null
  const order = String.fromCharCode(originalExif[start], originalExif[start + 1])
  if (order !== 'II' && order !== 'MM') return null
  const tiff = minimalOrientationTiff(orientation, order)
  return prefixed ? concat([asciiText(EXIF_PREFIX), tiff]) : tiff
}

/** Segmento JPEG completo (marcador + longitud + payload). */
function jpegSegmentBytes(marker: number, payload: Uint8Array): Uint8Array {
  return concat([Uint8Array.of(0xff, marker), u16beBytes(2 + payload.length), payload])
}

/* ── JPEG ── */

/** Marcadores JPEG sin segmento de longitud (SOI, RSTn, TEM). */
function isStandaloneJpegMarker(marker: number): boolean {
  return marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01
}

/** Identificadores que distinguen los APPn de JPEG (no mutables). */
const JPEG_APP1_EXIF = 'Exif\x00\x00'
const JPEG_APP1_XMP = 'http://ns.adobe.com/xap/1.0/\x00'
const JPEG_APP1_XMP_EXT = 'http://ns.adobe.com/xmp/extension/\x00'
const JPEG_APP2_ICC = 'ICC_PROFILE\x00'

/** Clasifica un segmento JPEG (payload) en un bloque o null si no es metadata. */
function jpegBlockOf(marker: number, payload: Uint8Array): string | null {
  if (marker === 0xfe) return BLOCK_TEXT // COM
  if (marker === 0xe1) {
    const head = String.fromCharCode(...payload.slice(0, 48))
    if (head.startsWith(JPEG_APP1_EXIF)) return BLOCK_EXIF
    if (head.startsWith(JPEG_APP1_XMP) || head.startsWith(JPEG_APP1_XMP_EXT)) return BLOCK_XMP
  }
  if (marker === 0xe2 && String.fromCharCode(...payload.slice(0, 16)).startsWith(JPEG_APP2_ICC)) {
    return BLOCK_ICC
  }
  return null
}

/**
 * Recorre los segmentos de un JPEG. Devuelve { marker, payload } de cada
 * segmento (payload = datos tras la longitud). Al llegar a SOS (0xDA) se para:
 * el resto son datos de compresión, no segmentos interpretables.
 */
export function findJpegSegments(bytes: Uint8Array): Array<{ marker: number; payload: Uint8Array }> {
  const out: Array<{ marker: number; payload: Uint8Array }> = []
  let i = 0
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1
      continue
    }
    if (i + 1 >= bytes.length) break
    const marker = bytes[i + 1]
    if (marker === 0xd9 || isStandaloneJpegMarker(marker)) {
      i += 2
      if (marker === 0xd9) break
      continue
    }
    if (i + 3 >= bytes.length) break
    const length = readU16BE(bytes, i + 2)
    if (marker === 0xda || length < 2 || i + 2 + length > bytes.length) break
    out.push({ marker, payload: bytes.slice(i + 4, i + 2 + length) })
    i = i + 2 + length
  }
  return out
}

/** Comentarios COM (0xFE) de un JPEG, como texto (para el visor). */
export function listJpegCom(bytes: Uint8Array): string[] {
  return findJpegSegments(bytes)
    .filter((s) => s.marker === 0xfe)
    .map((s) => new TextDecoder().decode(s.payload).trim())
    .filter(Boolean)
}

/**
 * Elimina los segmentos de metadata de un JPEG.
 * Con `blocks` undefined elimina APP1/APP2/COM (legacy: todo). Con un Set,
 * elimina solo los bloqueos seleccionados.
 */
export function stripJpegMetadata(bytes: Uint8Array, blocks?: Set<string>): Uint8Array {
  const parts: Uint8Array[] = []
  let i = 0
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      parts.push(bytes.slice(i, i + 1))
      i += 1
      continue
    }
    if (i + 1 >= bytes.length) {
      parts.push(bytes.slice(i))
      break
    }
    const marker = bytes[i + 1]
    if (marker === 0xd9 || isStandaloneJpegMarker(marker)) {
      parts.push(bytes.slice(i, i + 2))
      i += 2
      if (marker === 0xd9) break
      continue
    }
    if (i + 3 >= bytes.length) {
      parts.push(bytes.slice(i))
      break
    }
    const length = readU16BE(bytes, i + 2)
    if (marker === 0xda || length < 2 || i + 2 + length > bytes.length) {
      parts.push(bytes.slice(i))
      break
    }
    const segmentEnd = i + 2 + length
    let drop = false
    if (!blocks) {
      drop = marker === 0xe1 || marker === 0xe2 || marker === 0xfe
    } else {
      const block = jpegBlockOf(marker, bytes.slice(i + 4, segmentEnd))
      drop = block !== null && blocks.has(block)
    }
    if (!drop) parts.push(bytes.slice(i, segmentEnd))
    i = segmentEnd
  }
  return concat(parts)
}

/**
 * Igual que `stripJpegMetadata`, pero cuando el bloque EXIF se elimina y hay un
 * EXIF mínimo que conservar, lo sustituye EN SU MISMA POSICIÓN (solo el tag
 * Orientation). El resto de segmentos y los datos de imagen (tras SOS) quedan
 * byte a byte intactos: no hay canvas, ni re-encode, ni rotación de píxeles.
 */
export function stripJpegMetadataKeepingExif(
  bytes: Uint8Array,
  blocks: Set<string>,
  minimalExif: Uint8Array | null,
): Uint8Array {
  if (!minimalExif || !blocks.has(BLOCK_EXIF)) return stripJpegMetadata(bytes, blocks)
  const parts: Uint8Array[] = []
  let i = 0
  let replaced = false
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      parts.push(bytes.slice(i, i + 1))
      i += 1
      continue
    }
    if (i + 1 >= bytes.length) {
      parts.push(bytes.slice(i))
      break
    }
    const marker = bytes[i + 1]
    if (marker === 0xd9 || isStandaloneJpegMarker(marker)) {
      parts.push(bytes.slice(i, i + 2))
      i += 2
      if (marker === 0xd9) break
      continue
    }
    if (i + 3 >= bytes.length) {
      parts.push(bytes.slice(i))
      break
    }
    const length = readU16BE(bytes, i + 2)
    if (marker === 0xda || length < 2 || i + 2 + length > bytes.length) {
      parts.push(bytes.slice(i))
      break
    }
    const segmentEnd = i + 2 + length
    const block = jpegBlockOf(marker, bytes.slice(i + 4, segmentEnd))
    if (block === BLOCK_EXIF && !replaced) {
      parts.push(jpegSegmentBytes(0xe1, minimalExif))
      replaced = true
    } else if (block === null || !blocks.has(block)) {
      parts.push(bytes.slice(i, segmentEnd))
    }
    i = segmentEnd
  }
  return concat(parts)
}

/**
 * Limpieza PROFUNDA de JPEG: elimina TODOS los segmentos APP (0xE0–0xEF,
 * incluido el APP0 JFIF que inyectan los encoders) y los comentarios COM.
 * Solo para re-encodear en modo 'deep': el JPEG ya está en sRGB y los APPn
 * sobran.
 */
export function stripJpegAllSegments(bytes: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = []
  let i = 0
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) {
      parts.push(bytes.slice(i, i + 1))
      i += 1
      continue
    }
    if (i + 1 >= bytes.length) {
      parts.push(bytes.slice(i))
      break
    }
    const marker = bytes[i + 1]
    if (marker === 0xd9 || isStandaloneJpegMarker(marker)) {
      parts.push(bytes.slice(i, i + 2))
      i += 2
      if (marker === 0xd9) break
      continue
    }
    if (i + 3 >= bytes.length) {
      parts.push(bytes.slice(i))
      break
    }
    const length = readU16BE(bytes, i + 2)
    if (marker === 0xda || length < 2 || i + 2 + length > bytes.length) {
      parts.push(bytes.slice(i))
      break
    }
    const segmentEnd = i + 2 + length
    const isMetadata = marker === 0xfe || (marker >= 0xe0 && marker <= 0xef)
    if (!isMetadata) parts.push(bytes.slice(i, segmentEnd))
    i = segmentEnd
  }
  return concat(parts)
}

/* ── PNG ── */

/** Largo de la firma PNG (8 bytes fijos al inicio). */
export const PNG_SIGNATURE_LENGTH = 8

/** Tipo de chunk PNG → bloque de metadata (o null). */
function pngBlockOf(type: string): string | null {
  switch (type) {
    case 'eXIf':
      return BLOCK_EXIF
    case 'iCCP':
      return BLOCK_ICC
    case 'tEXt':
    case 'zTXt':
    case 'iTXt':
    case 'tIME':
      return BLOCK_TEXT
    default:
      return null
  }
}

/** Chunk PNG crudo: { type, data, start, end } (length(4BE)+type+data+crc(4)). */
export interface PngChunk {
  type: string
  data: Uint8Array
  start: number
  end: number
}

/** Recorre los chunks de un PNG (firma + lista). Nunca lanza. */
export function listPngChunks(bytes: Uint8Array): PngChunk[] {
  const out: PngChunk[] = []
  let i = PNG_SIGNATURE_LENGTH
  while (i + 8 <= bytes.length) {
    const length = readU32BE(bytes, i)
    const chunkEnd = i + 12 + length
    if (chunkEnd > bytes.length) break
    out.push({
      type: asciiAt(bytes, i + 4),
      data: bytes.slice(i + 8, i + 8 + length),
      start: i,
      end: chunkEnd,
    })
    i = chunkEnd
  }
  return out
}

/** Texto legible de los chunks tEXt/iTXt/zTXt (zTXt se descomprime con fflate). */
export function listPngText(bytes: Uint8Array): Array<{ keyword: string; value: string }> {
  const out: Array<{ keyword: string; value: string }> = []
  for (const chunk of listPngChunks(bytes)) {
    if (chunk.type === 'tEXt') {
      const nul = chunk.data.indexOf(0)
      if (nul < 0) continue
      out.push({
        keyword: new TextDecoder().decode(chunk.data.slice(0, nul)),
        value: new TextDecoder().decode(chunk.data.slice(nul + 1)),
      })
    } else if (chunk.type === 'zTXt') {
      const nul = chunk.data.indexOf(0)
      if (nul < 0 || nul + 1 >= chunk.data.length) continue
      const keyword = new TextDecoder().decode(chunk.data.slice(0, nul))
      try {
        const value = new TextDecoder().decode(inflateSync(chunk.data.slice(nul + 2)))
        out.push({ keyword, value })
      } catch {
        /* zTXt corrupto: se omite */
      }
    } else if (chunk.type === 'iTXt') {
      const nul = chunk.data.indexOf(0)
      if (nul < 0) continue
      const keyword = new TextDecoder().decode(chunk.data.slice(0, nul))
      // 4 bytes: compresión(1) + método(1) + flag idioma(1) + flag traducido(1)
      const rest = chunk.data.slice(nul + 1)
      const langNul = rest.indexOf(0)
      if (langNul < 0) continue
      const translated = rest.slice(langNul + 1)
      const txtNul = translated.indexOf(0)
      const valueBytes = txtNul < 0 ? translated : translated.slice(txtNul + 1)
      out.push({ keyword, value: new TextDecoder().decode(valueBytes) })
    }
  }
  return out
}

/**
 * Elimina los chunks de metadata de un PNG, conservando firma/IHDR/IDAT/… 
 * Con `blocks` undefined elimina todos los conocidos; con Set, los elegidos.
 */
export function stripPngMetadata(bytes: Uint8Array, blocks?: Set<string>): Uint8Array {
  const parts: Uint8Array[] = [bytes.slice(0, PNG_SIGNATURE_LENGTH)]
  let i = PNG_SIGNATURE_LENGTH
  while (i + 8 <= bytes.length) {
    const length = readU32BE(bytes, i)
    const chunkEnd = i + 12 + length
    if (chunkEnd > bytes.length) {
      parts.push(bytes.slice(i))
      break
    }
    const type = asciiAt(bytes, i + 4)
    const block = pngBlockOf(type)
    const keep = block === null || (blocks !== undefined && !blocks.has(block))
    if (keep) parts.push(bytes.slice(i, chunkEnd))
    i = chunkEnd
  }
  return concat(parts)
}

/**
 * Igual que `stripPngMetadata`, pero sustituye el chunk `eXIf` por el EXIF
 * mínimo (solo Orientation) en su misma posición, recalculando su CRC. IDAT y
 * el resto de chunks quedan intactos: no se tocan los píxeles.
 */
export function stripPngMetadataKeepingExif(
  bytes: Uint8Array,
  blocks: Set<string>,
  minimalExif: Uint8Array | null,
): Uint8Array {
  if (!minimalExif || !blocks.has(BLOCK_EXIF)) return stripPngMetadata(bytes, blocks)
  const parts: Uint8Array[] = [bytes.slice(0, PNG_SIGNATURE_LENGTH)]
  let i = PNG_SIGNATURE_LENGTH
  let replaced = false
  while (i + 8 <= bytes.length) {
    const length = readU32BE(bytes, i)
    const chunkEnd = i + 12 + length
    if (chunkEnd > bytes.length) {
      parts.push(bytes.slice(i))
      break
    }
    const type = asciiAt(bytes, i + 4)
    const block = pngBlockOf(type)
    if (type === 'eXIf' && !replaced) {
      parts.push(pngChunkBytes('eXIf', minimalExif))
      replaced = true
    } else if (block === null || !blocks.has(block)) {
      parts.push(bytes.slice(i, chunkEnd))
    }
    i = chunkEnd
  }
  return concat(parts)
}

/**
 * Limpieza PROFUNDA de PNG: elimina además de metadata los chunks de color,
 * densidad y perfiles que suelen añadir los encoders (sRGB/gAMA/cHRM/pHYs…).
 * Conserva SIEMPRE IHDR/PLTE/IDAT/IEND/tRNS (datos visibles).
 */
export function stripPngDeep(bytes: Uint8Array): Uint8Array {
  const ancillary: ReadonlySet<string> = new Set([
    'eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME', 'iCCP',
    'sRGB', 'gAMA', 'cHRM', 'pHYs', 'bKGD', 'sPLT', 'hIST',
    'pCAL', 'sCAL', 'oFFs',
  ])
  const parts: Uint8Array[] = [bytes.slice(0, PNG_SIGNATURE_LENGTH)]
  let i = PNG_SIGNATURE_LENGTH
  while (i + 8 <= bytes.length) {
    const length = readU32BE(bytes, i)
    const chunkEnd = i + 12 + length
    if (chunkEnd > bytes.length) {
      parts.push(bytes.slice(i))
      break
    }
    const type = asciiAt(bytes, i + 4)
    if (!ancillary.has(type)) parts.push(bytes.slice(i, chunkEnd))
    i = chunkEnd
  }
  return concat(parts)
}

/* ── WebP (RIFF) ── */

/** Chunk WebP/RIFF: { fourcc, data } (RIFF pad incluido ya en la lectura). */
export interface WebpChunk {
  fourcc: string
  data: Uint8Array
}

/** Recorre los chunks de un contenedor RIFF WebP (sin validar tamaño). */
export function listWebpChunks(bytes: Uint8Array): WebpChunk[] {
  if (bytes.length < 12 || asciiAt(bytes, 0) !== 'RIFF' || asciiAt(bytes, 8) !== 'WEBP') return []
  const out: WebpChunk[] = []
  let i = 12
  while (i + 8 <= bytes.length) {
    const fourcc = asciiAt(bytes, i)
    const size = readU32LE(bytes, i + 4)
    const chunkEnd = i + 8 + size
    if (chunkEnd > bytes.length) break
    out.push({ fourcc, data: bytes.slice(i + 8, chunkEnd) })
    i = chunkEnd + (size & 1)
  }
  return out
}

/**
 * Reconstruye un contenedor WebP reubicando la metadata inyectada en el orden
 * que exige libwebp, porque el decoder solo omite chunks opcionales cuando
 * `VP8X` es el PRIMER chunk; si no, interpreta la metadata como bitstream y
 * falla. Reglas:
 * - `VP8X` (si existe) va SIEMPRE primero.
 * - `ICCP` (perfil de color) va tras `VP8X` y antes de los píxeles.
 * - El resto de la metadata (`EXIF`/`XMP `) va DESPUÉS de los datos de imagen.
 * - Sin `VP8X` (WebP simple lossy/lossless) los píxeles van primero: la
 *   metadata nunca queda como primer chunk.
 * `drop` enumera los FourCC ya presentes que se descartan antes de reinyectar.
 */
function rebuildWebp(
  bytes: Uint8Array,
  metadata: WebpChunk[],
  drop: ReadonlySet<string>,
): Uint8Array {
  const chunks = listWebpChunks(bytes)
  const vp8x = chunks.find((c) => c.fourcc === 'VP8X')
  const kept = chunks.filter((c) => c.fourcc !== 'VP8X' && !drop.has(c.fourcc))
  const before = metadata.filter((m) => m.fourcc === 'ICCP')
  const after = metadata.filter((m) => m.fourcc !== 'ICCP')
  const parts: Uint8Array[] = [asciiText('RIFF'), new Uint8Array(4), asciiText('WEBP')]
  if (vp8x) {
    parts.push(webpChunkBytes(vp8x.fourcc, vp8x.data))
    for (const chunk of before) parts.push(webpChunkBytes(chunk.fourcc, chunk.data))
    for (const chunk of kept) parts.push(webpChunkBytes(chunk.fourcc, chunk.data))
  } else {
    // WebP simple (sin VP8X): los píxeles van primero para que la metadata
    // nunca sea el primer chunk (el decoder leería los bytes como bitstream).
    for (const chunk of kept) parts.push(webpChunkBytes(chunk.fourcc, chunk.data))
    for (const chunk of before) parts.push(webpChunkBytes(chunk.fourcc, chunk.data))
  }
  for (const chunk of after) parts.push(webpChunkBytes(chunk.fourcc, chunk.data))
  const out = concat(parts)
  writeU32LE(out, 4, out.length - 8)
  return out
}

/** FourCC WebP → bloque de metadata (o null). */
function webpBlockOf(fourcc: string): string | null {
  switch (fourcc) {
    case 'EXIF':
      return BLOCK_EXIF
    case 'XMP ':
      return BLOCK_XMP
    case 'ICCP':
      return BLOCK_ICC
    default:
      return null
  }
}

/**
 * Elimina los chunks EXIF/XMP/ICCP de un WebP y re-escribe el tamaño RIFF
 * (offset 4, little-endian). Con `blocks` undefined elimina todos.
 */
export function stripWebpMetadata(bytes: Uint8Array, blocks?: Set<string>): Uint8Array {
  if (bytes.length < 12 || asciiAt(bytes, 0) !== 'RIFF' || asciiAt(bytes, 8) !== 'WEBP') {
    return bytes.slice()
  }
  const parts: Uint8Array[] = [bytes.slice(0, 4), bytes.slice(4, 12)]
  let i = 12
  while (i + 8 <= bytes.length) {
    const fourcc = asciiAt(bytes, i)
    const size = readU32LE(bytes, i + 4)
    const chunkEnd = i + 8 + size
    if (chunkEnd > bytes.length) break
    const block = webpBlockOf(fourcc)
    const keep = block === null || (blocks !== undefined && !blocks.has(block))
    if (keep) parts.push(bytes.slice(i, chunkEnd))
    i = chunkEnd + (size & 1)
  }
  const out = concat(parts)
  writeU32LE(out, 4, out.length - 8)
  return out
}

/**
 * Igual que `stripWebpMetadata`, pero sustituye el chunk `EXIF` por el EXIF
 * mínimo (solo Orientation) en su misma posición, re-escribiendo el tamaño
 * RIFF. El chunk de imagen (`VP8 `/`VP8L`/`VP8X`) queda intacto: no se
 * re-codifica nada.
 */
export function stripWebpMetadataKeepingExif(
  bytes: Uint8Array,
  blocks: Set<string>,
  minimalExif: Uint8Array | null,
): Uint8Array {
  if (!minimalExif || !blocks.has(BLOCK_EXIF)) return stripWebpMetadata(bytes, blocks)
  if (bytes.length < 12 || asciiAt(bytes, 0) !== 'RIFF' || asciiAt(bytes, 8) !== 'WEBP') {
    return bytes.slice()
  }
  const parts: Uint8Array[] = [bytes.slice(0, 4), bytes.slice(4, 12)]
  let i = 12
  let replaced = false
  while (i + 8 <= bytes.length) {
    const fourcc = asciiAt(bytes, i)
    const size = readU32LE(bytes, i + 4)
    const chunkEnd = i + 8 + size
    if (chunkEnd > bytes.length) break
    const block = webpBlockOf(fourcc)
    if (block === BLOCK_EXIF && !replaced) {
      parts.push(webpChunkBytes('EXIF', minimalExif))
      replaced = true
    } else if (block === null || !blocks.has(block)) {
      parts.push(bytes.slice(i, chunkEnd))
    }
    i = chunkEnd + (size & 1)
  }
  const out = concat(parts)
  writeU32LE(out, 4, out.length - 8)
  return out
}

/* ── Re-inyección de orientación tras re-encodear (modo profundo) ── */

/** Inserta un segmento APP1-EXIF tras el SOI de un JPEG. */
function insertJpegExif(bytes: Uint8Array, payload: Uint8Array): Uint8Array {
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes.slice()
  return concat([bytes.slice(0, 2), jpegSegmentBytes(0xe1, payload), bytes.slice(2)])
}

/** Inserta un chunk `eXIf` (TIFF crudo, sin prefijo) tras el IHDR de un PNG. */
function insertPngExif(bytes: Uint8Array, tiff: Uint8Array): Uint8Array {
  const ihdr = listPngChunks(bytes).find((c) => c.type === 'IHDR')
  if (!ihdr) return bytes.slice()
  return concat([bytes.slice(0, ihdr.end), pngChunkBytes('eXIf', tiff), bytes.slice(ihdr.end)])
}

/**
 * Inserta un chunk `EXIF` (TIFF crudo) en un WebP respetando el orden que exige
 * libwebp: `VP8X` primero (cuando existe) y el `EXIF` DESPUÉS de los datos de
 * imagen. Sin `VP8X` los píxeles van primero, así la metadata nunca queda como
 * primer chunk. Re-escribe el tamaño RIFF.
 */
function insertWebpExif(bytes: Uint8Array, tiff: Uint8Array): Uint8Array {
  if (bytes.length < 12 || asciiAt(bytes, 0) !== 'RIFF' || asciiAt(bytes, 8) !== 'WEBP') return bytes.slice()
  return rebuildWebp(bytes, [{ fourcc: 'EXIF', data: tiff }], new Set(['EXIF']))
}

/**
 * Re-inyecta un EXIF mínimo con SOLO el tag `Orientation` en una imagen que ya
 * fue re-codificada y limpiada (modo profundo). Así la foto se sigue viendo
 * exactamente igual que antes aunque el canvas no haya rotado ningún píxel.
 * Sin orientación (`undefined` o `1`) devuelve los bytes sin tocar. Es cirugía
 * binaria pura (Node-testable): no usa canvas. El byte order del EXIF nuevo es
 * little-endian (`II`), válido para cualquier visualizador.
 */
export function reinjectOrientation(
  bytes: Uint8Array,
  kind: 'jpg' | 'png' | 'webp',
  orientation: number | undefined,
): Uint8Array {
  if (orientation === undefined || orientation <= 1) return bytes.slice()
  const tiff = minimalOrientationTiff(orientation, 'II')
  if (kind === 'jpg') return insertJpegExif(bytes, concat([asciiText(EXIF_PREFIX), tiff]))
  if (kind === 'png') return insertPngExif(bytes, tiff)
  return insertWebpExif(bytes, tiff)
}

/* ── ISO-BMFF: re-escritura de offsets (remux lossless) ── */

/**
 * Suma `delta` a cada entrada de `stco`/`co64` de un `moov` re-construido.
 * Es lo que hacen los remuxers (ffmpeg) para que los offsets absolutos de los
 * chunks sigan apuntando al `mdat` cuando `moov` se encoge.
 *
 * SOLO desciende por cajas CONTAINER conocidas (moov/trak/mdia/minf/stbl…):
 * las FullBox (stco, stts, mvhd…) empiezan su payload con versión/flags que
 * suelen ser `0x00000000`, y un parser genérico lo leería como una caja de
 * tamaño 0 → recursión infinita. Con el allowlist + tope de profundidad el
 * walker es robusto ante cualquier contenedor real.
 */
const MP4_STCO_CONTAINERS: ReadonlySet<string> = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'moof', 'traf',
])

export function patchMp4Stco(moov: Uint8Array, delta: number): void {
  if (delta === 0) return
  const walk = (bytes: Uint8Array, start: number, end: number, depth: number): void => {
    if (depth > 32) return
    let offset = start
    while (offset + 8 <= end) {
      const size = readU32BE(bytes, offset)
      let header = 8
      let total = size
      if (size === 1) {
        header = 16
        if (offset + 16 > end) break
        if (readU32BE(bytes, offset + 8) !== 0) break
        total = readU32BE(bytes, offset + 12)
      } else if (size === 0) {
        total = end - offset
      }
      if (total < header || offset + total > end) break
      const type = asciiAt(bytes, offset + 4)
      const dataStart = offset + header
      if (type === 'stco') {
        const count = readU32BE(bytes, dataStart + 4)
        for (let n = 0; n < count; n++) {
          const p = dataStart + 8 + n * 4
          const v = readU32BE(bytes, p)
          writeU32BE(bytes, p, (v + delta) >>> 0)
        }
      } else if (type === 'co64') {
        const count = readU32BE(bytes, dataStart + 4)
        for (let n = 0; n < count; n++) {
          const p = dataStart + 8 + n * 8
          const hi = readU32BE(bytes, p)
          const lo = readU32BE(bytes, p + 4)
          const v = hi * 0x100000000 + lo
          const nv = Math.max(0, v + delta)
          writeU32BE(bytes, p, Math.floor(nv / 0x100000000))
          writeU32BE(bytes, p + 4, nv % 0x100000000)
        }
      } else if (MP4_STCO_CONTAINERS.has(type)) {
        walk(bytes, dataStart, offset + total, depth + 1)
      }
      offset += total
    }
  }
  walk(moov, 0, moov.length, 0)
}