/**
 * ADEI-ONE — Dominio IMAGEN EXTRA de "Eliminar metadata" (gif, tiff, heic).
 *
 * Mismo contrato que los demás dominios (`domain.ts`): cirugía binaria PURA,
 * Node-testable, sin DOM ni canvas. Estos formatos NO admiten re-generación
 * (canvas solo exporta jpg/png/webp), así que el modo 'deep' se degrada al
 * mismo camino lossless: eliminar TODOS los bloques de metadata conocidos.
 *
 * Alcance por formato (honesto):
 * - **gif (completo)**: conserva cabecera "GIF87a"/"GIF89a", Logical Screen
 *   Descriptor, imágenes (descriptor + datos LZW), extensiones no-metadata
 *   (GCE, Netscape loop…) y el trailer 0x3B. Bloques:
 *     - 'text' → extensión de comentario (0x21 0xFE) y texto plano (0x21 0x01).
 *     - 'xmp'  → extensión de aplicación (0x21 0xFF) con id "XMP DataXMP".
 *     - 'format' (técnico, nunca se borra) → ancho/alto del Logical Screen
 *       Descriptor, resolución de color, paleta global y nº de imágenes.
 *   El scan reporta los comentarios (texto) y la presencia de XMP.
 * - **tiff (completo)**: cabecera "II*\0" / "MM\0*" y la cadena de IFD. Se
 *   eliminan las entradas de metadata (bajo el bloque 'exif': Make, Model,
 *   Software, DateTime, Artist, ImageDescription, Copyright, UserComment,
 *   CameraOwnerName, BodySerialNumber, LensMake/LensModel y los punteros
 *   EXIF/GPS 0x8769/0x8825). Al reescribir un IFD se recalculan los offsets
 *   fuera de línea (StripOffsets 0x0111, TileOffsets 0x0144 y demás valores
 *   desplazados) con el delta acumulado, de modo que el archivo resultante
 *   siga siendo un TIFF válido; los datos de imagen se copian sin tocar.
 *   El scan lee SOLO los IFD (nunca decodifica píxeles) y traduce los tags a
 *   español, incl. latitud/longitud del sub-IFD GPS (0x8825, tags 0x0002/0x0004).
 *   El bloque 'format' (nunca se borra) reporta los tags estructurales del IFD0
 *   (ancho/alto/bits/compresión/interpretación fotométrica…).
 * - **heic (best-effort, honesto)**: contenedor ISO-BMFF (cajas tamaño 4BE +
 *   tipo 4). El scan usa `exifr` (import dinámico) y traduce las claves a
 *   español (Make→Fabricante, Model→Modelo, DateTimeOriginal→Fecha original,
 *   GPSLatitude→Latitud GPS…). El strip elimina de nivel superior las cajas
 *   'uuid'/'free'/'skip'/'wide'/'pict' (junk/marca) de forma lossless, pero
 *   NUNCA elimina 'meta' (contiene la info esencial de items para decodificar).
 *   El scan reporta además el bloque 'format' (nunca se borra) con las marcas
 *   del ftyp y, si exifr las provee, el ancho/alto.
 *   El borrado fino del item EXIF dentro de `meta` (iinf/iloc) queda para una
 *   fase próxima: si no hay nada que quitar, passthrough de los mismos bytes.
 *
 * Nunca lanza: parseo inválido → `EMPTY_REPORT` (scan) o passthrough con
 * mensaje claro ("…fase próxima") vía `report` (strip).
 */
import {
  BLOCK_EXIF,
  BLOCK_TEXT,
  BLOCK_XMP,
  asciiAt,
  concat,
  readU16BE,
  readU32BE,
  readU32LE,
  writeU32LE,
} from './chunks'
import { EMPTY_REPORT } from './domain'
import type { MetaDomain, Reporter, StripConfig } from './domain'
import type { FileKind, MetadataBlock, MetadataField, MetadataReport, MetaEntry } from '@/core/types'

/** ID de bloque para las cajas de relleno/junk de heic. */
const BLOCK_JUNK = 'junk'
/** ID de bloque técnico del formato (nunca se borra; compartido con jpg/png/webp). */
const BLOCK_FORMAT = 'format'

/* ── Ayudantes binarios ── */

/** Entero de 2 bytes little-endian sin signo. */
function readU16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0
}

/** Lee un entero de 2 bytes en el endianness pedido. */
function readU16(bytes: Uint8Array, offset: number, le: boolean): number {
  return le ? readU16LE(bytes, offset) : readU16BE(bytes, offset)
}

/** Lee un entero de 4 bytes en el endianness pedido. */
function readU32(bytes: Uint8Array, offset: number, le: boolean): number {
  return le ? readU32LE(bytes, offset) : readU32BE(bytes, offset)
}

/** Escribe un entero de 2 bytes en el endianness pedido (muta el array). */
function writeU16(bytes: Uint8Array, offset: number, value: number, le: boolean): void {
  if (le) {
    bytes[offset] = value & 0xff
    bytes[offset + 1] = (value >>> 8) & 0xff
  } else {
    bytes[offset] = (value >>> 8) & 0xff
    bytes[offset + 1] = value & 0xff
  }
}

/** Escribe un entero de 4 bytes en el endianness pedido (muta el array). */
function writeU32(bytes: Uint8Array, offset: number, value: number, le: boolean): void {
  if (le) {
    writeU32LE(bytes, offset, value)
  } else {
    bytes[offset] = (value >>> 24) & 0xff
    bytes[offset + 1] = (value >>> 16) & 0xff
    bytes[offset + 2] = (value >>> 8) & 0xff
    bytes[offset + 3] = value & 0xff
  }
}

/** ¿Los `len` bytes a partir de `offset` son exactamente `text`? */
function asciiEquals(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false
  }
  return true
}

/** Texto seguro para un campo (sin saltos de línea largos ni binario). */
function cleanText(value: string, max = 400): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/* ── GIF ── */

/** Etiqueta de extensión de comentario. */
const GIF_COMMENT_LABEL = 0xfe
/** Etiqueta de extensión de texto plano. */
const GIF_PLAIN_TEXT_LABEL = 0x01
/** Etiqueta de extensión de aplicación. */
const GIF_APP_LABEL = 0xff
/** Identificador de la extensión de aplicación XMP (11 bytes exactos). */
const XMP_APP_ID = 'XMP DataXMP'

/** Segmento contiguo de un GIF (extensión, imagen o trailer). */
interface GifSegment {
  start: number
  end: number
  /** Etiqueta de extensión (0xFE comentario, 0x01 texto plano, 0xFF aplicación). */
  label?: number
  /** Bloque de metadata ('text' | 'xmp') o null si no es metadata. */
  block: string | null
  /** Región de sub-bloques (datos) de la extensión. */
  dataStart?: number
  dataEnd?: number
}

/**
 * Recorre un GIF (cabecera + LSD + tablas de color + extensiones + imágenes +
 * trailer) y devuelve sus segmentos contiguos. Devuelve null si no parece un
 * GIF válido (cabecera "GIF87a"/"GIF89a"). Nunca lanza.
 */
function walkGif(bytes: Uint8Array): GifSegment[] | null {
  if (bytes.length < 13 || asciiAt(bytes, 0) !== 'GIF8') return null
  const version = String.fromCharCode(bytes[4], bytes[5])
  if (version !== '7a' && version !== '9a') return null
  const packed = bytes[10]
  const gctBytes = packed & 0x80 ? 3 * (1 << ((packed & 0x07) + 1)) : 0
  const segments: GifSegment[] = []
  let i = 13 + gctBytes
  while (i < bytes.length) {
    const b = bytes[i]
    if (b === 0x3b) {
      // Trailer: fin de data stream.
      segments.push({ start: i, end: i + 1, block: null })
      return segments
    }
    if (b === 0x21) {
      // Extensión: 0x21 + etiqueta + sub-bloques terminados en 0x00.
      if (i + 2 > bytes.length) break
      const label = bytes[i + 1]
      let j = i + 2
      const dataStart = j
      while (j < bytes.length && bytes[j] !== 0) {
        const size = bytes[j]
        if (size === 0 || j + 1 + size > bytes.length) break
        j += 1 + size
      }
      const end = j < bytes.length ? j + 1 : bytes.length
      segments.push({ start: i, end, label, block: gifBlockOf(label, bytes, dataStart), dataStart, dataEnd: j })
      i = end
    } else if (b === 0x2c) {
      // Descriptor de imagen: 0x2C + 9 bytes + tabla local + código LZW + data.
      if (i + 10 > bytes.length) break
      const p = bytes[i + 9]
      const lctBytes = p & 0x80 ? 3 * (1 << ((p & 0x07) + 1)) : 0
      let j = i + 10 + lctBytes
      if (j >= bytes.length) break
      j += 1 // tamaño mínimo de código LZW
      while (j < bytes.length && bytes[j] !== 0) {
        const size = bytes[j]
        if (size === 0 || j + 1 + size > bytes.length) break
        j += 1 + size
      }
      const end = j < bytes.length ? j + 1 : bytes.length
      segments.push({ start: i, end, block: null })
      i = end
    } else {
      // Byte inesperado: el resto se conserva como segmento bruto.
      segments.push({ start: i, end: bytes.length, block: null })
      break
    }
  }
  return segments
}

/** Clasifica una extensión GIF en bloque de metadata (o null). */
function gifBlockOf(label: number, bytes: Uint8Array, dataStart: number): string | null {
  if (label === GIF_COMMENT_LABEL || label === GIF_PLAIN_TEXT_LABEL) return BLOCK_TEXT
  if (label === GIF_APP_LABEL && asciiEquals(bytes, dataStart + 1, XMP_APP_ID)) return BLOCK_XMP
  return null
}

/** Texto de los sub-bloques de una extensión (comentario / texto plano). */
function decodeGifText(bytes: Uint8Array, dataStart: number, dataEnd: number): string {
  let out = ''
  let i = dataStart
  while (i < dataEnd && i < bytes.length) {
    const size = bytes[i]
    if (size === 0) break
    if (i + 1 + size > bytes.length) break
    out += new TextDecoder().decode(bytes.slice(i + 1, i + 1 + size))
    i += 1 + size
  }
  return out.trim()
}

/**
 * Campos técnicos del GIF (nunca se borran): dimensiones del Logical Screen
 * Descriptor (LE16 en offsets 6/8), resolución de color (bits 4-6 del byte
 * packed), presencia de paleta global y nº de descriptores de imagen (0x2C).
 */
function scanGifFormat(bytes: Uint8Array, segments: GifSegment[]): MetadataField[] {
  if (bytes.length < 11) return []
  const packed = bytes[10]
  const images = segments.filter((s) => s.start < bytes.length && bytes[s.start] === 0x2c).length
  return [
    { name: 'Ancho (px)', value: String(readU16LE(bytes, 6)), sensitivity: 'low', removableIn: 'never' },
    { name: 'Alto (px)', value: String(readU16LE(bytes, 8)), sensitivity: 'low', removableIn: 'never' },
    {
      name: 'Resolución de color',
      value: `${((packed >> 4) & 0x07) + 1} bits por color`,
      sensitivity: 'low',
      removableIn: 'never',
    },
    { name: 'Paleta global', value: packed & 0x80 ? 'Sí' : 'No', sensitivity: 'low', removableIn: 'never' },
    { name: 'Imágenes', value: String(images), sensitivity: 'low', removableIn: 'never' },
  ]
}

/** Escaneo GIF: comentarios/texto plano, presencia de XMP y bloque técnico. Nunca lanza. */
function scanGif(bytes: Uint8Array): MetadataReport {
  const segments = walkGif(bytes)
  if (!segments) return EMPTY_REPORT
  const blocks: MetadataBlock[] = []
  const entries: MetaEntry[] = []
  const textFields: MetadataField[] = []
  const xmpFields: MetadataField[] = []
  let sawXmp = false
  for (const seg of segments) {
    if (seg.block === BLOCK_TEXT && seg.dataStart !== undefined && seg.dataEnd !== undefined) {
      const isPlain = seg.label === GIF_PLAIN_TEXT_LABEL
      const label = isPlain ? 'Texto plano' : 'Comentario'
      const text = decodeGifText(bytes, seg.dataStart, seg.dataEnd)
      if (text) {
        textFields.push({ name: label, value: cleanText(text, 200), sensitivity: 'low' })
        // Inventario exhaustivo: TODO comentario/texto, sin tope y con su ruta real.
        entries.push({
          where: isPlain ? 'GIF > Texto plano' : 'GIF > Comentario',
          key: isPlain ? 'PLAIN_TEXT' : 'COMMENT',
          label,
          value: cleanText(text, 200),
          size: seg.dataEnd - seg.dataStart,
          sensitivity: 'low',
          removal: 'with-container',
        })
      }
    } else if (seg.block === BLOCK_XMP) {
      xmpFields.push({ name: 'Metadatos XMP', value: 'Presentes', sensitivity: 'medium' })
      if (!sawXmp) {
        sawXmp = true
        entries.push({
          where: 'XMP',
          key: 'XMP',
          label: 'Metadatos XMP',
          value: 'Presentes',
          sensitivity: 'medium',
          removal: 'with-container',
        })
      }
    }
  }
  if (textFields.length) blocks.push({ id: BLOCK_TEXT, label: 'Comentarios', removableIn: 'light', fields: textFields })
  if (xmpFields.length) blocks.push({ id: BLOCK_XMP, label: 'Metadatos XMP', removableIn: 'light', fields: xmpFields })
  const formatFields = scanGifFormat(bytes, segments)
  if (formatFields.length) {
    blocks.push({ id: BLOCK_FORMAT, label: 'Formato de la imagen', removableIn: 'never', fields: formatFields })
    for (const field of formatFields) {
      entries.push({
        where: 'LSD',
        key: field.name,
        label: field.name,
        value: field.value,
        sensitivity: field.sensitivity,
        removal: 'never',
      })
    }
  }
  const flat = blocks.flatMap((block) => block.fields)
  return { fields: flat, count: flat.length, blocks, entries }
}

/** Elimina los bloques seleccionados de un GIF (lossless; deep = text+xmp). */
function stripGif(bytes: Uint8Array, config: StripConfig, report: Reporter): Uint8Array {
  // Light sin bloques: passthrough de los mismos bytes (nada que limpiar).
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  report('Identificando bloques del GIF', 40)
  const segments = walkGif(bytes)
  if (!segments) {
    report('Este GIF no se puede limpiar de forma lossless: limpieza fina en fase próxima. Se conservan los bytes originales.', 100)
    return bytes.slice()
  }
  const parts: Uint8Array[] = []
  let cursor = 0
  for (const seg of segments) {
    if (seg.start > cursor) parts.push(bytes.slice(cursor, seg.start))
    const drop = seg.block !== null && (config.mode === 'deep' || config.blocks.includes(seg.block))
    if (!drop) parts.push(bytes.slice(seg.start, seg.end))
    cursor = seg.end
  }
  if (cursor < bytes.length) parts.push(bytes.slice(cursor))
  report('Eliminando bloques de metadata', 90)
  return concat(parts)
}

/* ── TIFF ── */

/** Tags de metadata a detectar/eliminar (bloque 'exif'). */
const TIFF_META_TAGS: ReadonlySet<number> = new Set([
  0x010e, // ImageDescription
  0x010f, // Make
  0x0110, // Model
  0x0131, // Software
  0x0132, // DateTime
  0x013b, // Artist
  0x8298, // Copyright
  0x8769, // EXIF IFD pointer
  0x8825, // GPS IFD pointer
  0x9286, // UserComment
  0xa430, // CameraOwnerName
  0xa431, // BodySerialNumber
  0xa433, // LensMake
  0xa434, // LensModel
])

/** Traducción de tags a español para el visor. */
const TIFF_LABELS: Record<number, { label: string; sensitivity: MetadataField['sensitivity'] }> = {
  0x010e: { label: 'Descripción', sensitivity: 'low' },
  0x010f: { label: 'Fabricante', sensitivity: 'medium' },
  0x0110: { label: 'Modelo', sensitivity: 'medium' },
  0x0131: { label: 'Software', sensitivity: 'medium' },
  0x0132: { label: 'Fecha y hora', sensitivity: 'medium' },
  0x013b: { label: 'Artista', sensitivity: 'medium' },
  0x8298: { label: 'Copyright', sensitivity: 'medium' },
  0x9286: { label: 'Comentario del usuario', sensitivity: 'high' },
  0xa430: { label: 'Propietario de la cámara', sensitivity: 'medium' },
  0xa431: { label: 'Número de serie (cuerpo)', sensitivity: 'high' },
  0xa433: { label: 'Fabricante del objetivo', sensitivity: 'low' },
  0xa434: { label: 'Modelo del objetivo', sensitivity: 'low' },
}

/**
 * Tags ESTRUCTURALES del IFD0 (bloque 'format', nunca se borran). Make/Model/
 * Software/DateTime NO están aquí: son metadata del bloque 'exif'.
 */
const TIFF_FORMAT_LABELS: Record<number, string> = {
  0x0100: 'Ancho',
  0x0101: 'Alto',
  0x0102: 'Bits por muestra',
  0x0103: 'Compresión',
  0x0106: 'Interpretación fotométrica',
  0x0111: 'Offset de las tiras',
  0x0115: 'Muestras por píxel',
  0x0116: 'Filas por tira',
  0x0117: 'Bytes por tira',
  0x011a: 'Resolución X',
  0x011b: 'Resolución Y',
  0x011c: 'Configuración planar',
  0x0128: 'Unidad de resolución',
}

/** Campos técnicos del TIFF: tags estructurales del IFD0 (nunca se borran). */
function scanTiffFormat(bytes: Uint8Array, le: boolean, ifd: TiffIfd): MetadataField[] {
  const fields: MetadataField[] = []
  for (const entry of ifd.entries) {
    const label = TIFF_FORMAT_LABELS[entry.tag]
    if (label) {
      fields.push({ name: label, value: decodeTiffValue(bytes, le, entry), sensitivity: 'low', removableIn: 'never' })
    }
  }
  return fields
}

/** Entrada cruda de un IFD TIFF (los 12 bytes + campos ya leídos). */
interface TiffEntry {
  tag: number
  type: number
  count: number
  /** Campo value/offset de 4 bytes. */
  value: number
  /** Los 12 bytes originales de la entrada. */
  raw: Uint8Array
}

/** IFD TIFF: región física + entradas + offset al siguiente IFD. */
interface TiffIfd {
  start: number
  end: number
  entries: TiffEntry[]
  nextOffset: number
}

/** Detecta el endianness de la cabecera TIFF ("II*\0" / "MM\0*"). */
function tiffEndian(bytes: Uint8Array): 'le' | 'be' | null {
  if (bytes.length < 8) return null
  if (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0) return 'le'
  if (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0 && bytes[3] === 42) return 'be'
  return null
}

/** ¿El value de 4 bytes contiene el dato (inline) o es un offset a otros datos? */
function valueIsInline(type: number, count: number): boolean {
  switch (type) {
    case 1: // BYTE
    case 2: // ASCII
    case 7: // UNDEFINED
      return count <= 4
    case 3: // SHORT
      return count <= 2
    case 5: // RATIONAL (8 bytes cada uno)
    case 10: // SRATIONAL
      return count <= 0
    default:
      return count <= 2
  }
}

/**
 * Recorre la cadena de IFD de un TIFF. Devuelve { endian, ifds } o null si la
 * estructura no es abordable de forma lossless (cabecera inválida, offsets
 * fuera de rango, ciclos…). Nunca lanza.
 */
function parseTiff(bytes: Uint8Array): { endian: 'le' | 'be'; ifds: TiffIfd[] } | null {
  const endian = tiffEndian(bytes)
  if (!endian) return null
  const le = endian === 'le'
  const ifds: TiffIfd[] = []
  const seen = new Set<number>()
  let off = readU32(bytes, 4, le)
  let guard = 0
  while (off !== 0) {
    if (seen.has(off) || off < 8 || off + 2 > bytes.length) return null
    guard += 1
    if (guard > 256) return null
    seen.add(off)
    const count = readU16(bytes, off, le)
    const entriesStart = off + 2
    if (entriesStart + count * 12 + 4 > bytes.length) return null
    const entries: TiffEntry[] = []
    for (let e = 0; e < count; e++) {
      const base = entriesStart + e * 12
      entries.push({
        tag: readU16(bytes, base, le),
        type: readU16(bytes, base + 2, le),
        count: readU32(bytes, base + 4, le),
        value: readU32(bytes, base + 8, le),
        raw: bytes.slice(base, base + 12),
      })
    }
    const nextOffset = readU32(bytes, entriesStart + count * 12, le)
    ifds.push({ start: off, end: entriesStart + count * 12 + 4, entries, nextOffset })
    off = nextOffset
  }
  return { endian, ifds }
}

/** Valor de una entrada TIFF como texto legible (para el visor). */
function decodeTiffValue(bytes: Uint8Array, le: boolean, e: TiffEntry): string {
  try {
    const inline = valueIsInline(e.type, e.count)
    switch (e.type) {
      case 2: {
        // ASCII (inline en los 4 bytes del campo value, o en su offset).
        const count = Math.min(e.count, inline ? 4 : 512)
        const src = inline ? e.raw.slice(8, 8 + count) : bytes.slice(e.value, e.value + count)
        const s = new TextDecoder().decode(src)
        const nul = s.indexOf('\0')
        return (nul >= 0 ? s.slice(0, nul) : s).trim() || '—'
      }
      case 3: {
        // SHORT
        const n = Math.min(e.count, 32)
        const vals: number[] = []
        for (let i = 0; i < n; i++) {
          const base = inline ? 8 + i * 2 : e.value + i * 2
          vals.push(inline ? (le ? readU16LE(e.raw, base) : readU16BE(e.raw, base)) : readU16(bytes, base, le))
        }
        return vals.join(', ')
      }
      case 5: {
        // RATIONAL (nunca inline)
        const n = Math.min(e.count, 8)
        const vals: number[] = []
        for (let i = 0; i < n; i++) {
          const base = e.value + i * 8
          const num = readU32(bytes, base, le)
          const den = readU32(bytes, base + 4, le)
          vals.push(den !== 0 ? Number((num / den).toFixed(6)) : num)
        }
        return vals.join(', ')
      }
      case 7: {
        // UNDEFINED (UserComment…)
        const count = Math.min(e.count, 256)
        const src = inline ? e.raw.slice(8, 8 + count) : bytes.slice(e.value, e.value + count)
        const s = new TextDecoder().decode(src)
        const nul = s.indexOf('\0')
        return (nul >= 0 ? s.slice(0, nul) : s).trim() || '—'
      }
      default: {
        if (inline) return String(e.value)
        return `@${e.value}`
      }
    }
  } catch {
    return '—'
  }
}

/** Formatea un valor RATIONAL de GPS (grados, minutos, segundos). */
function formatGpsDms(bytes: Uint8Array, le: boolean, count: number, value: number): string {
  try {
    if (count !== 3) return String(value)
    const parts: number[] = []
    for (let i = 0; i < 3; i++) {
      const base = value + i * 8
      const num = readU32(bytes, base, le)
      const den = readU32(bytes, base + 4, le)
      parts.push(den !== 0 ? num / den : num)
    }
    const [d, m, s] = parts
    if (!d && !m && !s) return '0°'
    return `${d}° ${m}′ ${s.toFixed(2)}″`
  } catch {
    return '—'
  }
}

/** Lee latitud/longitud del sub-IFD GPS (0x8825, tags 0x0002/0x0004). */
function readGpsFields(bytes: Uint8Array, le: boolean, ifdOffset: number): MetadataField[] {
  const out: MetadataField[] = []
  try {
    if (ifdOffset + 2 > bytes.length) return out
    const count = readU16(bytes, ifdOffset, le)
    if (ifdOffset + 2 + count * 12 + 4 > bytes.length) return out
    for (let i = 0; i < count; i++) {
      const base = ifdOffset + 2 + i * 12
      const tag = readU16(bytes, base, le)
      if (tag === 0x0002 || tag === 0x0004) {
        out.push({
          name: tag === 0x0002 ? 'Latitud GPS' : 'Longitud GPS',
          value: formatGpsDms(bytes, le, readU32(bytes, base + 4, le), readU32(bytes, base + 8, le)),
          sensitivity: 'high',
        })
      }
    }
    return out
  } catch {
    return out
  }
}

/** Escaneo TIFF: solo lee el primer IFD (no decodifica píxeles). Nunca lanza. */
function scanTiff(bytes: Uint8Array): MetadataReport {
  const parsed = parseTiff(bytes)
  if (!parsed || parsed.ifds.length === 0) return EMPTY_REPORT
  const le = parsed.endian === 'le'
  const fields: MetadataField[] = []
  for (const entry of parsed.ifds[0]!.entries) {
    const mapped = TIFF_LABELS[entry.tag]
    if (mapped) {
      fields.push({ name: mapped.label, value: decodeTiffValue(bytes, le, entry), sensitivity: mapped.sensitivity })
    } else if (entry.tag === 0x8825) {
      fields.push(...readGpsFields(bytes, le, entry.value))
    } else if (entry.tag === 0x8769) {
      fields.push({ name: 'Metadatos EXIF', value: 'Presentes', sensitivity: 'medium' })
    }
  }
  const blocks: MetadataBlock[] = fields.length
    ? [{ id: BLOCK_EXIF, label: 'Datos de cámara (EXIF/GPS)', fields, removableIn: 'light' }]
    : []
  const formatFields = scanTiffFormat(bytes, le, parsed.ifds[0]!)
  if (formatFields.length) blocks.push({ id: BLOCK_FORMAT, label: 'Formato de la imagen', removableIn: 'never', fields: formatFields })
  const entries = tiffEntries(bytes, le, parsed.ifds)
  const flat = blocks.flatMap((block) => block.fields)
  return { fields: flat, count: flat.length, blocks, entries }
}

/* ── Inventario TIFF (entries) ── */

/** Nombre legible de un tag TIFF (metadata o estructural), si se conoce. */
function tiffTagLabel(tag: number): string | undefined {
  return TIFF_LABELS[tag]?.label ?? TIFF_FORMAT_LABELS[tag]
}

/** Clave cruda de un tag TIFF: su id en hexadecimal (p. ej. `0xA431`). */
function tiffTagKey(tag: number): string {
  return `0x${tag.toString(16).toUpperCase().padStart(4, '0')}`
}

/** Entrada de inventario de un tag TIFF con su ruta IFD real. */
function tiffEntry(tag: number, value: string, removal: MetaEntry['removal'], ifdPath: string): MetaEntry {
  const key = tiffTagKey(tag)
  return {
    where: `${ifdPath} > Tag ${key}`,
    key,
    label: tiffTagLabel(tag),
    value,
    sensitivity: TIFF_LABELS[tag]?.sensitivity ?? 'low',
    removal,
  }
}

/** Empuja la entrada de un tag TIFF de la cadena principal (ruta `IFDn > Tag 0x…`). */
function pushTiffEntry(entries: MetaEntry[], bytes: Uint8Array, le: boolean, entry: TiffEntry, ifdPath: string): void {
  const removal = TIFF_META_TAGS.has(entry.tag) ? 'with-container' : 'never'
  entries.push(tiffEntry(entry.tag, decodeTiffValue(bytes, le, entry), removal, ifdPath))
}

/** Lee las entradas de UN IFD en `offset` (sin seguir el encadenado). Null si no es abordable. */
function readTiffIfdAt(bytes: Uint8Array, le: boolean, offset: number): TiffEntry[] | null {
  if (offset < 8 || offset + 2 > bytes.length) return null
  const count = readU16(bytes, offset, le)
  const entriesStart = offset + 2
  if (entriesStart + count * 12 + 4 > bytes.length) return null
  const entries: TiffEntry[] = []
  for (let e = 0; e < count; e++) {
    const base = entriesStart + e * 12
    entries.push({
      tag: readU16(bytes, base, le),
      type: readU16(bytes, base + 2, le),
      count: readU32(bytes, base + 4, le),
      value: readU32(bytes, base + 8, le),
      raw: bytes.slice(base, base + 12),
    })
  }
  return entries
}

/**
 * Enumera un sub-IFD referenciado por un puntero (EXIF 0x8769, GPS 0x8825,
 * Interop 0xA005). Borrar el puntero desengancha el sub-IFD entero, así que sus
 * entradas se marcan `with-container`.
 */
function pushTiffSubIfd(entries: MetaEntry[], bytes: Uint8Array, le: boolean, offset: number, ifdPath: string): void {
  const sub = readTiffIfdAt(bytes, le, offset)
  if (!sub) return
  for (const entry of sub) {
    if (ifdPath === 'EXIF GPS' && (entry.tag === 0x0002 || entry.tag === 0x0004)) {
      const key = tiffTagKey(entry.tag)
      entries.push({
        where: `${ifdPath} > Tag ${key}`,
        key,
        label: entry.tag === 0x0002 ? 'Latitud GPS' : 'Longitud GPS',
        value: formatGpsDms(bytes, le, entry.count, entry.value),
        sensitivity: 'high',
        removal: 'with-container',
      })
      continue
    }
    entries.push(tiffEntry(entry.tag, decodeTiffValue(bytes, le, entry), 'with-container', ifdPath))
    if (entry.tag === 0xa005) pushTiffSubIfd(entries, bytes, le, entry.value, 'EXIF Interop')
  }
}

/** Inventario exhaustivo de la cadena de IFD y sus sub-IFD (incl. tags desconocidos). */
function tiffEntries(bytes: Uint8Array, le: boolean, ifds: TiffIfd[]): MetaEntry[] {
  const entries: MetaEntry[] = []
  ifds.forEach((ifd, index) => {
    const ifdPath = `IFD${index}`
    for (const entry of ifd.entries) pushTiffEntry(entries, bytes, le, entry, ifdPath)
    const exifPtr = ifd.entries.find((e) => e.tag === 0x8769)
    if (exifPtr) pushTiffSubIfd(entries, bytes, le, exifPtr.value, 'EXIF SubIFD')
    const gpsPtr = ifd.entries.find((e) => e.tag === 0x8825)
    if (gpsPtr) pushTiffSubIfd(entries, bytes, le, gpsPtr.value, 'EXIF GPS')
  })
  return entries
}

/** Tags cuyo campo value es SIEMPRE un offset (datos de imagen). */
function isImageOffsetTag(tag: number): boolean {
  return tag === 0x0111 || tag === 0x0144 // StripOffsets / TileOffsets
}

/**
 * Elimina las entradas de metadata de los IFD y reescribe la cadena, recalcando
 * los offsets desplazados. Los datos de imagen se copian tal cual (lossless).
 */
function stripTiff(bytes: Uint8Array, config: StripConfig, report: Reporter): Uint8Array {
  // Light sin bloques: passthrough de los mismos bytes (nada que limpiar).
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  report('Identificando IFD del TIFF', 40)
  const parsed = parseTiff(bytes)
  if (!parsed) {
    report('Este TIFF no se puede limpiar de forma lossless: limpieza fina en fase próxima. Se conservan los bytes originales.', 100)
    return bytes.slice()
  }
  const { endian, ifds } = parsed
  if (ifds.length === 0) return bytes.slice()
  const le = endian === 'le'

  // ¿Se elimina una entrada de metadata con la política de bloques?
  const dropEntry = (entry: TiffEntry): boolean =>
    TIFF_META_TAGS.has(entry.tag) && (config.mode === 'deep' || config.blocks.includes(BLOCK_EXIF))

  const kept = ifds.map((ifd) => ({ ifd, entries: ifd.entries.filter((e) => !dropEntry(e)) }))
  const newSizes = kept.map(({ entries }) => 2 + entries.length * 12 + 4)

  // Delta acumulado por posición: todo lo que venga después de una región IFD
  // reescrita se desplaza en (nuevo tamaño − original).
  const order = ifds.map((_, idx) => idx).sort((a, b) => ifds[a]!.start - ifds[b]!.start)
  const landmarks: Array<{ at: number; delta: number }> = []
  let acc = 0
  for (const idx of order) {
    acc += newSizes[idx]! - (ifds[idx]!.end - ifds[idx]!.start)
    landmarks.push({ at: ifds[idx]!.end, delta: acc })
  }
  const translate = (x: number): number => {
    let delta = 0
    for (const land of landmarks) if (land.at <= x) delta = land.delta
    return x + delta
  }

  /** Reconstruye un IFD (12 bytes por entrada) con los offsets ya corregidos. */
  const build = (idx: number): Uint8Array => {
    const { ifd, entries } = kept[idx]!
    const out = new Uint8Array(2 + entries.length * 12 + 4)
    writeU16(out, 0, entries.length, le)
    entries.forEach((entry, e) => {
      const base = 2 + e * 12
      writeU16(out, base, entry.tag, le)
      writeU16(out, base + 2, entry.type, le)
      writeU32(out, base + 4, entry.count, le)
      let value = entry.value
      if (isImageOffsetTag(entry.tag) || !valueIsInline(entry.type, entry.count)) {
        value = translate(entry.value)
      }
      writeU32(out, base + 8, value, le)
    })
    const next = ifd.nextOffset === 0 ? 0 : translate(ifd.nextOffset)
    writeU32(out, 2 + entries.length * 12, next, le)
    return out
  }

  const parts: Uint8Array[] = []
  let cursor = 0
  for (const idx of order) {
    const ifd = ifds[idx]!
    if (ifd.start > cursor) parts.push(bytes.slice(cursor, ifd.start))
    parts.push(build(idx))
    cursor = ifd.end
  }
  if (cursor < bytes.length) parts.push(bytes.slice(cursor))
  report('Eliminando metadatos del IFD', 90)
  return concat(parts)
}

/* ── HEIC (contenedor ISO-BMFF) ── */

/** Caja ISO-BMFF de nivel superior. */
interface IsoBox {
  type: string
  start: number
  end: number
}

/** Cajas de nivel superior que suelen cargar EXIF (bloque 'exif'). */
const HEIC_EXIF_TYPES: ReadonlySet<string> = new Set(['uuid', 'free', 'skip'])
/** Cajas de relleno/junk/marca (bloque 'junk'). */
const HEIC_JUNK_TYPES: ReadonlySet<string> = new Set(['free', 'skip', 'wide', 'pict'])

/** Recorre las cajas ISO-BMFF (size 4BE + type 4). Nunca lanza. */
function walkIsoBoxes(bytes: Uint8Array): IsoBox[] {
  const out: IsoBox[] = []
  let i = 0
  while (i + 8 <= bytes.length) {
    const size = readU32BE(bytes, i)
    const type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7])
    let headerSize = 8
    let total = size
    if (size === 1) {
      // largesize de 64 bits.
      if (i + 16 > bytes.length) break
      const hi = readU32BE(bytes, i + 8)
      const lo = readU32BE(bytes, i + 12)
      total = hi * 0x100000000 + lo
      headerSize = 16
      if (total > 0xffffffff || i + total > bytes.length) break
    } else if (size === 0) {
      // Tamaño 0: la caja llega hasta el final del archivo.
      total = bytes.length - i
    }
    if (total < headerSize || i + total > bytes.length) break
    out.push({ type, start: i, end: i + total })
    i += total
  }
  return out
}

/** Traducción de claves EXIF (exifr) a español para el visor. */
const HEIC_EXIF_LABELS: Record<string, { label: string; sensitivity: MetadataField['sensitivity'] }> = {
  Make: { label: 'Fabricante', sensitivity: 'medium' },
  Model: { label: 'Modelo', sensitivity: 'medium' },
  Software: { label: 'Software', sensitivity: 'medium' },
  DateTimeOriginal: { label: 'Fecha original', sensitivity: 'medium' },
  CreateDate: { label: 'Fecha de creación', sensitivity: 'medium' },
  ModifyDate: { label: 'Fecha de modificación', sensitivity: 'medium' },
  Artist: { label: 'Artista', sensitivity: 'medium' },
  Copyright: { label: 'Copyright', sensitivity: 'medium' },
  ImageDescription: { label: 'Descripción', sensitivity: 'low' },
  UserComment: { label: 'Comentario', sensitivity: 'high' },
  LensMake: { label: 'Fabricante del objetivo', sensitivity: 'low' },
  LensModel: { label: 'Modelo del objetivo', sensitivity: 'low' },
  BodySerialNumber: { label: 'Número de serie (cuerpo)', sensitivity: 'high' },
  GPSLatitude: { label: 'Latitud GPS', sensitivity: 'high' },
  GPSLongitude: { label: 'Longitud GPS', sensitivity: 'high' },
  GPSAltitude: { label: 'Altitud GPS', sensitivity: 'high' },
  GPSDateStamp: { label: 'Fecha GPS', sensitivity: 'high' },
}

/** Valor EXIF → texto legible (fechas, arrays DMS de GPS, números…). */
function heicValue(key: string, value: unknown): string {
  if (value instanceof Date) return value.toISOString().replace('T', ' ').slice(0, 19) + ' (UTC)'
  if (Array.isArray(value)) {
    if ((key.startsWith('GPSLatitude') || key.startsWith('GPSLongitude')) && value.length === 3) {
      const [d, m, s] = value.map(Number)
      return `${d}° ${m}′ ${s.toFixed(2)}″`
    }
    return value.map((v) => heicValue(key, v)).join(', ')
  }
  if (value !== null && typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toLocaleString()
  return String(value)
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
 * SubIFD, GPS, Interop, IFD1) y cada propiedad XMP (incluido el namespace por
 * defecto `xmp`), con su ruta real. Los desconocidos se listan con su clave
 * cruda. Devuelve true si enumeró XMP.
 *
 * `removal: 'never'` en TODAS las entradas: `stripHeic` solo sustituye cajas de
 * nivel superior (`uuid`/`free`/`skip`/`wide`/`pict`) y NUNCA elimina el EXIF
 * que vive dentro de `meta` (limitación documentada arriba). La etiqueta debe
 * reflejar lo que el limpiador realmente hace.
 */
function pushStructuredExifEntries(meta: Record<string, unknown>, entries: MetaEntry[]): boolean {
  let sawXmp = false
  for (const [blockKey, blockValue] of Object.entries(meta)) {
    if (blockKey === 'errors' || blockKey === 'thumbnail' || blockKey === 'icc') continue
    if (!isPlainObject(blockValue)) continue
    const where = EXIF_BLOCK_PATHS[blockKey]
    if (!where) {
      // Namespace XMP (dc, photoshop, xmp…): una entrada por propiedad.
      sawXmp = true
      for (const [prop, value] of Object.entries(blockValue)) {
        if (value === undefined || value === null) continue
        entries.push({
          where: 'XMP',
          key: `${blockKey}:${prop}`,
          value: cleanText(heicValue(prop, value)),
          sensitivity: 'medium',
          removal: 'never',
        })
      }
      continue
    }
    for (const [key, value] of Object.entries(blockValue)) {
      if (value === undefined || value === null) continue
      const mapped = HEIC_EXIF_LABELS[key]
      entries.push({
        where,
        key,
        label: mapped?.label,
        value: cleanText(heicValue(key, value)),
        sensitivity: mapped?.sensitivity ?? (key.startsWith('GPS') ? 'high' : 'medium'),
        removal: 'never',
      })
    }
  }
  return sawXmp
}

/** Entradas técnicas del `ftyp` (marca principal y marcas compatibles; nunca se borran). */
function pushHeicFtypEntries(bytes: Uint8Array, entries: MetaEntry[]): void {
  const ftyp = walkIsoBoxes(bytes).find((b) => b.type === 'ftyp')
  if (!ftyp || ftyp.end - ftyp.start < 12) return
  entries.push({
    where: 'ftyp',
    key: 'major_brand',
    label: 'Marca principal',
    value: asciiAt(bytes, ftyp.start + 8),
    sensitivity: 'low',
    removal: 'never',
  })
  for (let i = ftyp.start + 16; i + 4 <= ftyp.end; i += 4) {
    entries.push({
      where: 'ftyp',
      key: 'compatible_brand',
      value: asciiAt(bytes, i),
      sensitivity: 'low',
      removal: 'never',
    })
  }
}

/**
 * Campos técnicos del contenedor HEIC (bloque 'format', nunca se borran):
 * la marca principal (major_brand, 4 bytes tras la cabecera ftyp) y las
 * marcas compatibles del ftyp.
 */
function scanHeicFormat(bytes: Uint8Array): MetadataField[] {
  const fields: MetadataField[] = []
  const push = (name: string, value: string): void => {
    fields.push({ name, value, sensitivity: 'low', removableIn: 'never' })
  }
  const ftyp = walkIsoBoxes(bytes).find((b) => b.type === 'ftyp')
  if (ftyp && ftyp.end - ftyp.start >= 12) {
    push('Marca principal', asciiAt(bytes, ftyp.start + 8))
    const brands: string[] = []
    for (let i = ftyp.start + 16; i + 4 <= ftyp.end; i += 4) {
      brands.push(asciiAt(bytes, i))
    }
    if (brands.length) push('Marcas compatibles', brands.join(', '))
  }
  return fields
}

/** Escaneo HEIC: marcas del ftyp + exifr (import dinámico) en español. Nunca lanza. */
async function scanHeic(bytes: Uint8Array): Promise<MetadataReport> {
  const formatFields: MetadataField[] = []
  const pushDim = (name: string, value: string): void => {
    formatFields.push({ name, value, sensitivity: 'low', removableIn: 'never' })
  }
  let exifFields: MetadataField[] = []
  const entries: MetaEntry[] = []
  try {
    const exifr = await import('exifr')
    const meta = (await exifr.parse(bytes)) as Record<string, unknown> | undefined
    if (meta) {
      const fields: MetadataField[] = []
      for (const [key, value] of Object.entries(meta)) {
        if (['errors', 'xmp', 'xmlns', 'thumbnail'].includes(key)) continue
        if (value === undefined || value === null) continue
        // Ancho/alto son datos técnicos (nunca se borran) → al bloque 'format'.
        if (key === 'ImageWidth' || key === 'ImageHeight') {
          pushDim(key === 'ImageWidth' ? 'Ancho (px)' : 'Alto (px)', cleanText(heicValue(key, value)))
          continue
        }
        const mapped = HEIC_EXIF_LABELS[key]
        fields.push({
          name: mapped?.label ?? key,
          value: cleanText(heicValue(key, value)),
          sensitivity: mapped?.sensitivity ?? (key.startsWith('GPS') ? 'high' : 'medium'),
        })
      }
      exifFields = fields
    }
    // Inventario exhaustivo: TODO ítem EXIF (también los no mapeados) con su ruta.
    const structured = (await exifr.parse(bytes, STRUCTURED_EXIFR_OPTIONS)) as Record<string, unknown> | undefined
    if (structured) pushStructuredExifEntries(structured, entries)
  } catch {
    /* sin EXIF legible: solo se reporta el formato */
  }
  const blocks: MetadataBlock[] = []
  if (exifFields.length) blocks.push({ id: BLOCK_EXIF, label: 'Datos de cámara (EXIF/GPS)', fields: exifFields, removableIn: 'light' })
  formatFields.push(...scanHeicFormat(bytes))
  if (formatFields.length) blocks.push({ id: BLOCK_FORMAT, label: 'Formato de la imagen', removableIn: 'never', fields: formatFields })
  pushHeicFtypEntries(bytes, entries)
  if (blocks.length === 0 && entries.length === 0) return EMPTY_REPORT
  const flat = blocks.flatMap((block) => block.fields)
  return { fields: flat, count: flat.length, blocks, entries }
}

/** Caja `free` de EXACTAMENTE `total` bytes (size 4BE + 'free' + ceros). */
function freeBox(total: number): Uint8Array {
  const out = new Uint8Array(total)
  out[0] = (total >>> 24) & 0xff
  out[1] = (total >>> 16) & 0xff
  out[2] = (total >>> 8) & 0xff
  out[3] = total & 0xff
  out[4] = 0x66 // 'f'
  out[5] = 0x72 // 'r'
  out[6] = 0x65 // 'e'
  out[7] = 0x65 // 'e'
  return out
}

/**
 * Elimina las cajas junk/marca de nivel superior (nunca 'meta'). Nunca rompe
 * el layout: HEIC ubica sus items por offsets absolutos (`iloc`), así que
 * cada caja eliminada se sustituye por un `free` del MISMO tamaño. Es el
 * mismo criterio que mat2: HEIC no admite limpieza "a fondo" (deep se degrada
 * a esta limpieza segura).
 */
function stripHeic(bytes: Uint8Array, config: StripConfig, report: Reporter): Uint8Array {
  // Light sin bloques: passthrough de los mismos bytes (nada que limpiar).
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  const boxes = walkIsoBoxes(bytes)
  if (boxes.length === 0) return bytes.slice()
  const wantExif = config.blocks.includes(BLOCK_EXIF)
  const wantJunk = config.blocks.includes(BLOCK_JUNK)
  const drop = (type: string): boolean => {
    if (config.mode === 'deep') return HEIC_EXIF_TYPES.has(type) || HEIC_JUNK_TYPES.has(type)
    return (wantExif && HEIC_EXIF_TYPES.has(type)) || (wantJunk && HEIC_JUNK_TYPES.has(type))
  }
  report('Identificando cajas ISO-BMFF', 40)
  let replaced = 0
  const parts: Uint8Array[] = []
  let cursor = 0
  for (const box of boxes) {
    if (box.start > cursor) parts.push(bytes.slice(cursor, box.start))
    if (drop(box.type)) {
      replaced += 1
      parts.push(freeBox(box.end - box.start))
      cursor = box.end
      continue
    }
    parts.push(bytes.slice(box.start, box.end))
    cursor = box.end
  }
  if (cursor < bytes.length) parts.push(bytes.slice(cursor))
  // Nada que quitar (o solo fase futura: item EXIF dentro de meta) → passthrough.
  if (replaced === 0) return bytes.slice()
  report('Eliminando cajas de metadata', 90)
  return concat(parts)
}

/* ── Dominio ── */

/** ¿Empieza como un GIF válido ("GIF87a"/"GIF89a")? */
function looksLikeGif(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    asciiAt(bytes, 0) === 'GIF8' &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  )
}

/** ¿Tiene cabecera TIFF válida? */
function looksLikeTiff(bytes: Uint8Array): boolean {
  return tiffEndian(bytes) !== null
}

/** Escaneo del dominio: detecta el formato por magic bytes y delega. */
async function scan(bytes: Uint8Array): Promise<MetadataReport> {
  if (looksLikeGif(bytes)) return scanGif(bytes)
  if (looksLikeTiff(bytes)) return scanTiff(bytes)
  return scanHeic(bytes)
}

/** Strip del dominio: cirugía por kind (el engine solo orquesta). */
async function strip(
  bytes: Uint8Array,
  kind: FileKind,
  config: StripConfig,
  report: Reporter,
): Promise<Uint8Array> {
  switch (kind) {
    case 'gif':
      return stripGif(bytes, config, report)
    case 'tiff':
      return stripTiff(bytes, config, report)
    case 'heic':
      return stripHeic(bytes, config, report)
    default:
      throw new Error('Limpiar este formato de imagen llega en una fase próxima')
  }
}

export const imagePlusDomain: MetaDomain = {
  kinds: ['gif', 'tiff', 'heic'] as const,
  scan,
  strip,
}