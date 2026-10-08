/**
 * ADEI-ONE — Dominio VIDEO de "Eliminar metadata" (mp4, mov, mkv, avi, webm).
 *
 * Contrato en `domain.ts`: cirugía binaria pura → lossless (Node-testable, sin
 * DOM/canvas/exifr). Los vídeos NO se re-codifican: se recorren las estructuras
 * del contenedor (cajas/elementos/chunks) y se descartan SOLO las que cargan
 * metadata, recalculando los tamaños de los padres.
 *
 * Formatos y bloques:
 * - mp4/mov (ISO-BMFF): cajas `size(4BE)+type(4)+data`, recursivas.
 *   - 'tags'  → elimina la caja `moov/udta` completa (título ©nam, artista
 *     ©ART, álbum ©alb, año ©day, comentario ©cmt, género ©gen, trkn…).
 *   - 'gps'   → dentro de `moov/udta/meta/ilst` quita SOLO los frames ©xyz y
 *     ©loci (coordenadas); conserva el resto de udta/ilst.
 *   - 'junk'  → cajas basura free/skip/wide/uuid (top-level y en moov).
 *   - deep    → 'tags'+'gps'+'junk' (+ basura final no parseable).
 *   - 'format' (técnico, nunca se borra) → duración/escala de tiempo de `mvhd`,
 *     resolución de `tkhd` y códecs (avc1/hvc1/vp09/mp4a…) del primer `stsd`.
 *   Se conservan SIEMPRE ftyp, mdat (contenido intacto) y moov/trak completos.
 * - mkv/webm (EBML/Matroska): elementos `ID(vint)+size(vint)+datos`.
 *   - 'tags'   → elimina el elemento Tags y el Title dentro de Info.
 *   - 'attach' → elimina el elemento Attachments (archivos adjuntos).
 *   - 'junk'   → elimina los elementos Void del Segment.
 *   - deep     → todos los anteriores.
 *   - 'format' (técnico, nunca se borra) → duración (Duration×TimecodeScale)
 *     y pistas del elemento Tracks (tipo, códec, resolución, frecuencia).
 * - avi (RIFF): `"RIFF"+size(4LE)+"AVI "` + chunks `id(4)+size(4LE)+datos+pad`.
 *   - 'info' → quita el LIST interior de tipo "INFO" (INAM/IART/ISFT/ICMT…).
 *   - 'junk' → quita los chunks JUNK y 'PAD '.
 *   - deep   → ambos.
 *   - 'format' (técnico, nunca se borra) → FPS/resolución/duración de `avih` y
 *     código de `strh` (fccHandler).
 */
import { EMPTY_REPORT, shortHex } from './domain'
import { asciiAt, concat, patchMp4Stco, readU32BE, readU32LE, writeU32LE } from './chunks'
import type { MetaDomain, Reporter, StripConfig } from './domain'
import type { FileKind, MetadataBlock, MetadataField, MetadataReport, MetaEntry, MetaRemoval } from '@/core/types'

/* ── Constantes de bloques ── */

const BLOCK_TAGS = 'tags'
const BLOCK_GPS = 'gps'
const BLOCK_JUNK = 'junk'
const BLOCK_INFO = 'info'
const BLOCK_ATTACH = 'attach'
/** Bloque técnico de formato (estructura del contenedor): NUNCA se borra. */
const BLOCK_FORMAT = 'format'

/** Cajas ISO-BMFF consideradas basura (bloque 'junk' y modo 'deep'). */
const MP4_JUNK_TYPES: ReadonlySet<string> = new Set(['free', 'skip', 'wide', 'uuid'])

/** IDs EBML/Matroska que interesan al dominio. */
const EBML_HEADER_ID = 0x1a45dfa3
const MKV_SEGMENT = 0x18538067
const MKV_INFO = 0x1549a966
const MKV_TITLE = 0x7ba9
const MKV_TAGS = 0x1254c367
const MKV_ATTACHMENTS = 0x1941a469
const MKV_ATTACHMENT = 0x61a7 // AttachedFile (2 bytes: 0x61 0xa7)
const MKV_VOID = 0xec
const MKV_DURATION = 0x4489 // Duration (float, nanosegundos)
const MKV_TIMECODE_SCALE = 0x2ad7b1 // TimestampScale (uint, ns por tick)
const MKV_TRACKS = 0x1654ae6b // Tracks
const MKV_TRACK_ENTRY = 0xae // TrackEntry
const MKV_TRACK_TYPE = 0x83 // 1=vídeo, 2=audio, 17=subtítulos
const MKV_CODEC_ID = 0x86 // CodecID ('V_VP9', 'A_OPUS'…)
const MKV_PIXEL_WIDTH = 0xb0 // PixelWidth
const MKV_PIXEL_HEIGHT = 0xba // PixelHeight
const MKV_SAMPLING_FREQ = 0xb5 // SamplingFrequency (float)
const MKV_CHANNELS = 0x9f // Channels
const MKV_DATE_UTC = 0x4461 // DateUTC
const MKV_MUXING_APP = 0x4d80 // MuxingApp
const MKV_WRITING_APP = 0x5741 // WritingApp
const MKV_SEGMENT_UID = 0x73a4 // SegmentUID (binario)
const MKV_TAG = 0x7373 // Tag
const MKV_SIMPLE_TAG = 0x67c8 // SimpleTag
const MKV_TAG_NAME = 0x45a3 // TagName
const MKV_TAG_STRING = 0x4487 // TagString
const MKV_TAG_BINARY = 0x4485 // TagBinary
const MKV_FILE_NAME = 0x466e // FileName (AttachedFile)
const MKV_TRACK_NAME = 0x536e // TrackEntry Name
const MKV_TRACK_LANGUAGE = 0x22b59c // TrackEntry Language

/** Decodificador UTF-8 compartido (Node ≥ 20 lo expone como global). */
const DECODER = new TextDecoder()

/** Recorta y aplana un valor de metadata para el report (como el engine). */
function cap(value: string, max = 400): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/* ── Campos técnicos del bloque 'format' (compartidos por los 3 contenedores) ── */

/** Empuja un campo técnico: sensibilidad baja y `removableIn: never` (se conserva). */
function pushFormat(fields: MetadataField[], name: string, value: string): void {
  if (!value) return
  fields.push({ name, value: cap(value), sensitivity: 'low', removableIn: 'never' })
}

/** Vuelca los campos técnicos como entradas `never` (se conservan). */
function pushFormatEntries(entries: MetaEntry[], where: string, fields: MetadataField[]): void {
  for (const field of fields) {
    entries.push({
      where,
      key: field.name,
      label: field.name,
      value: field.value,
      sensitivity: field.sensitivity,
      removal: 'never',
    })
  }
}

/** `number` legible sin ceros colgantes (25, 29.97, 48000…). */
function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return ''
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(2).replace(/\.?0+$/, '')
}

/** Duración legible: "mm:ss", "h:mm:ss" o segundos con decimales. */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}`
  return `${seconds.toFixed(2).replace(/\.?0+$/, '')} s`
}

/** Entero de 8 bytes big-endian (duraciones mvhd v1, co64…). */
function readU64BE(bytes: Uint8Array, offset: number): number {
  return readU32BE(bytes, offset) * 0x100000000 + readU32BE(bytes, offset + 4)
}

/** IEEE-754 de 4/8 bytes, endianness explícito (flotantes de Matroska, tasas). */
function readFloat64LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset).getFloat64(0, true)
}
function readFloat64BE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset).getFloat64(0, false)
}
function readFloat32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset).getFloat32(0, true)
}

/* ══════════════════════════ ISO-BMFF (mp4 / mov) ══════════════════════════ */

interface Mp4Box {
  type: string
  /** Offset del campo `size` (inicio de la caja). */
  start: number
  /** Longitud de la cabecera (8, o 16 con largesize). */
  header: number
  /** Fin (exclusivo) de la caja. */
  end: number
  /** Inicio de los datos (tras la cabecera). */
  dataStart: number
}

/** Escribe un entero big-endian de 4 bytes. */
function be32(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

/** Ensambla una caja ISO-BMFF con su tamaño recalculado. */
function makeMp4Box(type: string, payload: Uint8Array): Uint8Array {
  return concat([be32(8 + payload.length), asciiAtBytes(type), payload])
}

/** `ascii(...)` local: convierte cada code unit ≤ 0xFF en un byte. */
function asciiAtBytes(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0) & 0xff))
}

/** Lee una caja ISO-BMFF en `offset`; null si es inválida o se sale del rango. */
function readMp4Box(bytes: Uint8Array, offset: number, limit: number): Mp4Box | null {
  if (offset + 8 > limit) return null
  const sizeWord = readU32BE(bytes, offset)
  let header = 8
  let total = sizeWord
  if (sizeWord === 1) {
    // size=1 → "largesize" de 64 bits tras la cabecera de 8 bytes.
    if (offset + 16 > limit) return null
    header = 16
    if (readU32BE(bytes, offset + 8) !== 0) return null // > 4 GiB: fuera de alcance
    total = readU32BE(bytes, offset + 12)
  } else if (sizeWord === 0) {
    total = limit - offset // size=0 → "hasta el final" (típico de mdat)
  }
  if (total < header || offset + total > limit) return null
  return { type: asciiAt(bytes, offset + 4), start: offset, header, end: offset + total, dataStart: offset + header }
}

/** Recorre las cajas de un rango y llama a `visit` por cada una. */
function walkMp4(bytes: Uint8Array, start: number, end: number, visit: (box: Mp4Box) => void): void {
  let offset = start
  while (offset + 8 <= end) {
    const box = readMp4Box(bytes, offset, end)
    if (!box) break
    visit(box)
    offset = box.end
  }
}

/** Primera caja con `wanted` en el rango (loop directo: evita capturas en callback). */
function findMp4Box(bytes: Uint8Array, start: number, end: number, wanted: string): Mp4Box | null {
  let offset = start
  while (offset + 8 <= end) {
    const box = readMp4Box(bytes, offset, end)
    if (!box) break
    if (box.type === wanted) return box
    offset = box.end
  }
  return null
}

/** ¿Hay cajas basura (free/skip/wide/uuid) en el rango? */
function hasMp4Junk(bytes: Uint8Array, start: number, end: number): boolean {
  let offset = start
  while (offset + 8 <= end) {
    const box = readMp4Box(bytes, offset, end)
    if (!box) break
    if (MP4_JUNK_TYPES.has(box.type)) return true
    offset = box.end
  }
  return false
}

/** ¿Se elimina esta caja por el bloque 'junk' (o en modo 'deep')? */
function dropsJunk(boxType: string, config: StripConfig): boolean {
  return MP4_JUNK_TYPES.has(boxType) && (config.mode === 'deep' || config.blocks.includes(BLOCK_JUNK))
}

/** Etiquetas de los items de `ilst` (títulos/artista…). */
const ILST_LABELS: Record<string, { label: string; sensitivity: MetadataField['sensitivity'] }> = {
  '©nam': { label: 'Título', sensitivity: 'low' },
  '©ART': { label: 'Artista', sensitivity: 'medium' },
  '©alb': { label: 'Álbum', sensitivity: 'low' },
  '©day': { label: 'Año', sensitivity: 'low' },
  '©cmt': { label: 'Comentario', sensitivity: 'medium' },
  '©gen': { label: 'Género', sensitivity: 'low' },
}

/** Etiquetas de las cajas de usuario QuickTime directas en `udta`. */
const QT_LABELS: Record<string, { label: string; sensitivity: MetadataField['sensitivity'] }> = {
  ...ILST_LABELS,
  '©too': { label: 'Software', sensitivity: 'medium' },
  '©swr': { label: 'Software', sensitivity: 'medium' },
}

/** Lee el valor de un item de ilst/udta (primer hijo `data`, sin versión/locale). */
function readAtomValue(bytes: Uint8Array, item: Mp4Box): string | null {
  let out: string | null = null
  walkMp4(bytes, item.dataStart, item.end, (data) => {
    if (data.type !== 'data' || out !== null) return
    // El atom `data` guarda: versión/flags (4) + locale (4) + valor.
    const text = DECODER.decode(bytes.slice(data.dataStart + 8, data.end)).replaceAll('\u0000', '').trim()
    if (text.length > 0 && !text.includes('\uFFFD')) out = cap(text)
  })
  return out
}

/** Reconstruye `moov` sin las cajas de metadata seleccionadas. */
function rebuildMoov(bytes: Uint8Array, moov: Mp4Box, config: StripConfig): Uint8Array {
  const children: Uint8Array[] = []
  walkMp4(bytes, moov.dataStart, moov.end, (box) => {
    if (box.type === 'udta') {
      if (config.mode === 'deep' || config.blocks.includes(BLOCK_TAGS)) return // udta completa fuera
      if (config.blocks.includes(BLOCK_GPS)) {
        children.push(rebuildUdtaWithoutGps(bytes, box))
        return
      }
    }
    // `moov>meta` directa (metadata de móvil: com.android.*, iTunes…): con
    // 'tags' (o deep) se elimina entera; `moov>meta` NO tiene offsets de
    // chunks propios, así que el remux stco/co64 se encarga del resto.
    if (box.type === 'meta' && (config.mode === 'deep' || config.blocks.includes(BLOCK_TAGS))) return
    if (dropsJunk(box.type, config)) return
    children.push(bytes.slice(box.start, box.end))
  })
  return makeMp4Box('moov', concat(children))
}

/** Reconstruye `udta` conservando meta/ilst salvo los frames GPS (©xyz, ©loci). */
function rebuildUdtaWithoutGps(bytes: Uint8Array, udta: Mp4Box): Uint8Array {
  const children: Uint8Array[] = []
  walkMp4(bytes, udta.dataStart, udta.end, (child) => {
    if (child.type === 'meta') {
      // `meta` es una FullBox: 4 bytes de versión/flags + cajas hijas (ilst).
      const flags = bytes.slice(child.dataStart, child.dataStart + 4)
      const inner: Uint8Array[] = []
      walkMp4(bytes, child.dataStart + 4, child.end, (sub) => {
        if (sub.type === 'ilst') inner.push(rebuildIlst(bytes, sub))
        else inner.push(bytes.slice(sub.start, sub.end))
      })
      children.push(makeMp4Box('meta', concat([flags, concat(inner)])))
      return
    }
    children.push(bytes.slice(child.start, child.end))
  })
  return makeMp4Box('udta', concat(children))
}

/** Reconstruye `ilst` sin los frames de GPS (©xyz / ©loci); conserva el resto. */
function rebuildIlst(bytes: Uint8Array, ilst: Mp4Box): Uint8Array {
  const items: Uint8Array[] = []
  walkMp4(bytes, ilst.dataStart, ilst.end, (item) => {
    if (item.type === '©xyz' || item.type === '©loci') return
    items.push(bytes.slice(item.start, item.end))
  })
  return makeMp4Box('ilst', concat(items))
}

/**
 * Elimina metadata de un contenedor ISO-BMFF (mp4/mov) por bloque/modo.
 * Remux lossless: se reconstruye `moov` (sin udta/junk) y se re-escriben los
 * offsets absolutos `stco`/`co64` para compensar el desplazamiento de `mdat`
 * (el mismo principio que el remux de ffmpeg). `mdat` y `trak` intactos.
 */
function stripMp4(bytes: Uint8Array, config: StripConfig): Uint8Array {
  // 1) Cajas de nivel superior (hasta la primera región no parseable).
  const boxes: Mp4Box[] = []
  let offset = 0
  while (offset + 8 <= bytes.length) {
    const box = readMp4Box(bytes, offset, bytes.length)
    if (!box) break
    boxes.push(box)
    offset = box.end
  }
  if (boxes.length === 0) return bytes.slice() // no es un contenedor reconocible

  const mdat = boxes.find((b) => b.type === 'mdat') ?? null
  const oldMdatStart = mdat ? mdat.start : null

  // 2) Ensambla la salida calculando la posición nueva de mdat en el camino.
  const pieces: Uint8Array[] = []
  let moovBytes: Uint8Array | null = null
  let running = 0
  let newMdatStart: number | null = null
  for (const box of boxes) {
    if (box.type === 'mdat') {
      newMdatStart = running
      pieces.push(bytes.slice(box.start, box.end))
      running += box.end - box.start
      continue
    }
    if (box.type === 'moov') {
      moovBytes = rebuildMoov(bytes, box, config)
      pieces.push(moovBytes)
      running += moovBytes.length
      continue
    }
    if (dropsJunk(box.type, config)) continue
    pieces.push(bytes.slice(box.start, box.end))
    running += box.end - box.start
  }
  // Basura final: en deep se recorta (tras mdat no hay offsets más allá).
  const last = boxes[boxes.length - 1]
  if (last && last.end < bytes.length && config.mode !== 'deep') {
    pieces.push(bytes.slice(last.end))
  }

  // 3) Si mdat se desplazó (moov encogido antes de mdat), stco/co64 se
  // re-escriben para que los offsets absolutos sigan apuntando al contenido.
  const delta = oldMdatStart !== null && newMdatStart !== null ? newMdatStart - oldMdatStart : 0
  if (moovBytes && delta !== 0) patchMp4Stco(moovBytes, delta)

  return concat(pieces)
}

/** `moov>mvhd` (FullBox v0/v1): timescale y duración → segundos. */
function readMvhd(bytes: Uint8Array, mvhd: Mp4Box): { timescale: number; durationSec: number } | null {
  const d = mvhd.dataStart
  const tail = mvhd.end - d
  const version = bytes[d]
  if (version === 0 && tail >= 20) {
    const timescale = readU32BE(bytes, d + 12)
    if (timescale <= 0) return null
    return { timescale, durationSec: readU32BE(bytes, d + 16) / timescale }
  }
  if (version === 1 && tail >= 32) {
    const timescale = readU32BE(bytes, d + 20)
    if (timescale <= 0) return null
    return { timescale, durationSec: readU64BE(bytes, d + 24) / timescale }
  }
  return null
}

/** `trak>tkhd` (FullBox v0/v1): resolución 16.16 al final del payload (84/96 B). */
function readTrackResolution(bytes: Uint8Array, tkhd: Mp4Box): { w: number; h: number } | null {
  const d = tkhd.dataStart
  const tail = tkhd.end - d
  const version = bytes[d]
  const fixed = (raw: number): number => Math.trunc(raw / 65536)
  if (version === 0 && tail >= 84) {
    const w = fixed(readU32BE(bytes, d + 76))
    const h = fixed(readU32BE(bytes, d + 80))
    return w > 0 && h > 0 ? { w, h } : null
  }
  if (version === 1 && tail >= 96) {
    const w = fixed(readU32BE(bytes, d + 88))
    const h = fixed(readU32BE(bytes, d + 92))
    return w > 0 && h > 0 ? { w, h } : null
  }
  return null
}

/** Tipo de pista ISO-BMFF (`trak>mdia>hdlr`): 'vide', 'soun', 'sbtl'… */
function trackHandler(bytes: Uint8Array, trak: Mp4Box): string | null {
  const mdia = findMp4Box(bytes, trak.dataStart, trak.end, 'mdia')
  if (!mdia) return null
  const hdlr = findMp4Box(bytes, mdia.dataStart, mdia.end, 'hdlr')
  if (!hdlr || hdlr.dataStart + 12 > hdlr.end) return null
  return asciiAt(bytes, hdlr.dataStart + 8)
}

/** FourCC del primer sample entry de `stsd` (códec de la pista). */
function trackCodec(bytes: Uint8Array, trak: Mp4Box): string | null {
  const mdia = findMp4Box(bytes, trak.dataStart, trak.end, 'mdia')
  if (!mdia) return null
  const minf = findMp4Box(bytes, mdia.dataStart, mdia.end, 'minf')
  if (!minf) return null
  const stbl = findMp4Box(bytes, minf.dataStart, minf.end, 'stbl')
  if (!stbl) return null
  const stsd = findMp4Box(bytes, stbl.dataStart, stbl.end, 'stsd')
  if (!stsd) return null
  // stsd FullBox: versión/flags(4) + entry_count(4) → primer sample entry.
  const first = readMp4Box(bytes, stsd.dataStart + 8, stsd.end)
  return first ? first.type : null
}

/** Campos técnicos de ISO-BMFF (mvhd + traks) → bloque 'format'; nunca se borra. */
function formatFieldsMp4(bytes: Uint8Array, moov: Mp4Box): MetadataField[] {
  const fields: MetadataField[] = []
  const push = (name: string, value: string): void => pushFormat(fields, name, value)

  const mvhd = findMp4Box(bytes, moov.dataStart, moov.end, 'mvhd')
  if (mvhd) {
    const info = readMvhd(bytes, mvhd)
    if (info) {
      push('Duración', formatDuration(info.durationSec))
      push('Escala de tiempo', String(info.timescale))
    }
  }

  let videoSeen = false
  let audioCodec: string | null = null
  walkMp4(bytes, moov.dataStart, moov.end, (box) => {
    if (box.type !== 'trak') return
    const tkhd = findMp4Box(bytes, box.dataStart, box.end, 'tkhd')
    const res = tkhd ? readTrackResolution(bytes, tkhd) : null
    const handler = trackHandler(bytes, box)
    const codec = trackCodec(bytes, box)
    const isVideo = handler === 'vide' || res !== null
    if (isVideo && !videoSeen) {
      videoSeen = true
      if (res) push('Resolución', `${res.w}x${res.h}`)
      if (codec) push('Códec de video', codec)
    } else if (handler === 'soun' && audioCodec === null && codec) {
      audioCodec = codec
    }
  })
  if (audioCodec) push('Códec de audio', audioCodec)
  return fields
}

/** Escanea metadata de un contenedor ISO-BMFF (mp4/mov). Nunca lanza. */
function scanMp4(bytes: Uint8Array): MetadataReport {
  try {
    const moov = findMp4Box(bytes, 0, bytes.length, 'moov')
    if (!moov) return EMPTY_REPORT
    const junkFound = hasMp4Junk(bytes, 0, bytes.length) || hasMp4Junk(bytes, moov.dataStart, moov.end)
    const udta = findMp4Box(bytes, moov.dataStart, moov.end, 'udta')
    // Los móviles (Android/Samsung/iOS) guardan casi toda su metadata en
    // `moov>meta` DIRECTA (claves com.android.*, com.apple.*…), no solo en udta.
    const moovMetaBoxes: Mp4Box[] = []
    walkMp4(bytes, moov.dataStart, moov.end, (b) => {
      if (b.type === 'meta') moovMetaBoxes.push(b)
    })
    const tagsFields: MetadataField[] = []
    const gpsFields: MetadataField[] = []
    const pushTag = (name: string, value: string, sensitivity: MetadataField['sensitivity']): void => {
      if (tagsFields.some((f) => f.name === name && f.value === value)) return
      tagsFields.push({ name, value, sensitivity })
    }
    // Itera los items de `ilst` de un `meta` (FullBox: +4 bytes de flags).
    const scanIlst = (meta: Mp4Box): void => {
      walkMp4(bytes, meta.dataStart + 4, meta.end, (sub) => {
        if (sub.type !== 'ilst') return
        walkMp4(bytes, sub.dataStart, sub.end, (item) => {
          const value = readAtomValue(bytes, item)
          if (value === null) return
          if (/xyz|loci|location/i.test(item.type)) {
            gpsFields.push({ name: 'GPS', value, sensitivity: 'high' })
            return
          }
          const mapped = ILST_LABELS[item.type] ?? QT_LABELS[item.type]
          if (mapped) pushTag(mapped.label, value, mapped.sensitivity)
          else pushTag(normalizeKey(item.type), value, 'medium')
        })
      })
    }
    if (udta) {
      const meta = findMp4Box(bytes, udta.dataStart, udta.end, 'meta')
      walkMp4(bytes, udta.dataStart, udta.end, (box) => {
        if (box.type === 'meta') return // ya tratada en scanIlst
        // udta sin ilst: cajas tipo QuickTime (©too → Software, ©swr…).
        const mapped = QT_LABELS[box.type]
        if (mapped) {
          const value = readAtomValue(bytes, box)
          if (value !== null) pushTag(mapped.label, value, mapped.sensitivity)
        }
      })
      if (meta) scanIlst(meta)
    }
    for (const meta of moovMetaBoxes) scanIlst(meta)

    const blocks: MetadataBlock[] = []
    // El GPS vive en la MISMA caja que título/artista: no se puede borrar uno
    // sin el otro, así que se muestra TODO dentro del bloque 'tags' (evita
    // marcar una casilla que "arrastra" datos no señalados).
    tagsFields.push(...gpsFields)
    if (tagsFields.length > 0) {
      blocks.push({ id: BLOCK_TAGS, label: 'Etiquetas (título/artista/ubicación)', fields: tagsFields, removableIn: 'light' })
    }
    if (junkFound) {
      blocks.push({
        id: BLOCK_JUNK,
        label: 'Cajas basura (free/skip/wide)',
        fields: [{ name: 'Cajas basura', value: 'Presentes', sensitivity: 'low' }],
        removableIn: 'light',
      })
    }
    const formatFields = formatFieldsMp4(bytes, moov)
    if (formatFields.length > 0) {
      blocks.push({ id: BLOCK_FORMAT, label: 'Formato (técnico)', removableIn: 'never', fields: formatFields })
    }
    const entries = mp4Entries(bytes, moov)
    pushFormatEntries(entries, 'moov', formatFields)
    if (blocks.length === 0 && entries.length === 0) return EMPTY_REPORT
    const flat = blocks.flatMap((b) => b.fields)
    return { fields: flat, count: flat.length, blocks, entries }
  } catch {
    return EMPTY_REPORT
  }
}

/** Convierte una clave cruda de `ilst` (p. ej. com.android.model) en texto legible. */
function normalizeKey(type: string): string {
  const clean = [...type]
    .map((c) => (c.charCodeAt(0) < 0x20 || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f) ? '' : c))
    .join('')
    .trim()
  return clean || 'Etiqueta'
}

/* ── Inventario ISO-BMFF (entries) ── */

/** UUID conocidos que aparecen en cajas `uuid` de ISO-BMFF (hex de 16 bytes). */
const UUID_XMP = 'be7acfcb97a942e89c71999491e3afac'
const UUID_C2PA = 'd8fec3d61b0e483c92975828877c0c85'

/** Formatea un tiempo ISO-BMFF (segundos desde 1904-01-01) para el visor. */
function mp4TimeText(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'No definido'
  const date = new Date(Date.UTC(1904, 0, 1) + seconds * 1000)
  if (Number.isNaN(date.getTime())) return 'No definido'
  return `${date.toISOString().replace('T', ' ').slice(0, 19)} (UTC)`
}

/** Entradas creation/modification_time de una cabecera FullBox (mvhd/tkhd/mdhd). */
function pushMp4Times(bytes: Uint8Array, box: Mp4Box, path: string, entries: MetaEntry[]): void {
  const d = box.dataStart
  const tail = box.end - d
  const version = bytes[d]
  let creation = 0
  let modification = 0
  if (version === 0 && tail >= 12) {
    creation = readU32BE(bytes, d + 4)
    modification = readU32BE(bytes, d + 8)
  } else if (version === 1 && tail >= 20) {
    creation = readU64BE(bytes, d + 4)
    modification = readU64BE(bytes, d + 12)
  } else {
    return
  }
  entries.push({ where: path, key: 'creation_time', label: 'Fecha de creación', value: mp4TimeText(creation), sensitivity: 'medium', removal: 'never' })
  entries.push({ where: path, key: 'modification_time', label: 'Fecha de modificación', value: mp4TimeText(modification), sensitivity: 'medium', removal: 'never' })
}

/** Payload del atom `data` de un item de `ilst`/`udta` (tras versión/locale). */
function atomPayload(bytes: Uint8Array, item: Mp4Box): Uint8Array | null {
  let payload: Uint8Array | null = null
  walkMp4(bytes, item.dataStart, item.end, (data) => {
    if (data.type !== 'data' || payload !== null) return
    payload = bytes.slice(data.dataStart + 8, data.end)
  })
  return payload
}

/** Entradas de TODOS los items de `ilst` de un `meta` (también los desconocidos). */
function pushIlstEntries(bytes: Uint8Array, meta: Mp4Box, path: string, entries: MetaEntry[]): void {
  walkMp4(bytes, meta.dataStart + 4, meta.end, (sub) => {
    if (sub.type !== 'ilst') return
    walkMp4(bytes, sub.dataStart, sub.end, (item) => {
      const mapped = ILST_LABELS[item.type] ?? QT_LABELS[item.type]
      const isGps = /xyz|loci|location/i.test(item.type)
      const text = readAtomValue(bytes, item) ?? ''
      const payload = atomPayload(bytes, item)
      entries.push({
        where: `${path} > ilst > ${item.type}`,
        key: item.type,
        label: isGps ? 'GPS' : mapped?.label,
        value: text,
        size: item.end - item.start,
        hex: !text && payload ? shortHex(payload) : undefined,
        sensitivity: isGps ? 'high' : mapped?.sensitivity ?? 'medium',
        // El GPS no tiene bloque propio: se pliega dentro del bloque 'tags'
        // (misma caja física que título/artista), así que solo se puede borrar
        // junto con su contenedor. Marcarlo 'individual' prometería un borrado
        // suelto que el strip no hace.
        removal: 'with-container',
      })
    })
  })
}

/** Entrada de una caja `uuid`, clasificada por su identificador (C2PA/XMP/otro). */
function pushUuidEntry(bytes: Uint8Array, box: Mp4Box, where: string, entries: MetaEntry[]): void {
  const uuid = bytes.slice(box.dataStart, Math.min(box.dataStart + 16, box.end))
  const hexId = [...uuid].map((b) => b.toString(16).padStart(2, '0')).join('')
  const label = hexId === UUID_C2PA ? 'C2PA' : hexId === UUID_XMP ? 'XMP' : 'UUID desconocido'
  entries.push({
    where,
    key: 'uuid',
    label,
    value: label,
    size: box.end - box.start,
    hex: shortHex(uuid),
    sensitivity: 'medium',
    removal: 'individual',
  })
}

/** Inventario exhaustivo de un contenedor ISO-BMFF (mp4/mov). Nunca lanza. */
function mp4Entries(bytes: Uint8Array, moov: Mp4Box): MetaEntry[] {
  const entries: MetaEntry[] = []
  // `uuid` de nivel superior: el strip lo borra con el bloque 'junk'/deep.
  walkMp4(bytes, 0, bytes.length, (box) => {
    if (box.type === 'uuid') pushUuidEntry(bytes, box, 'uuid', entries)
  })
  // `uuid` hijo DIRECTO de `moov`: el strip también lo borra ('junk'/deep,
  // rebuildMoov), así que debe verse en el inventario como `moov > uuid`.
  walkMp4(bytes, moov.dataStart, moov.end, (box) => {
    if (box.type === 'uuid') pushUuidEntry(bytes, box, 'moov > uuid', entries)
  })
  const mvhd = findMp4Box(bytes, moov.dataStart, moov.end, 'mvhd')
  if (mvhd) pushMp4Times(bytes, mvhd, 'moov > mvhd', entries)
  const moovMeta = findMp4Box(bytes, moov.dataStart, moov.end, 'meta')
  if (moovMeta) pushIlstEntries(bytes, moovMeta, 'moov > meta', entries)
  const udta = findMp4Box(bytes, moov.dataStart, moov.end, 'udta')
  if (udta) {
    const udtaMeta = findMp4Box(bytes, udta.dataStart, udta.end, 'meta')
    if (udtaMeta) pushIlstEntries(bytes, udtaMeta, 'moov > udta > meta', entries)
    else {
      walkMp4(bytes, udta.dataStart, udta.end, (atom) => {
        if (atom.type === 'meta') return
        const mapped = QT_LABELS[atom.type]
        if (!mapped) return
        const value = readAtomValue(bytes, atom)
        if (value === null) return
        entries.push({
          where: `moov > udta > ${atom.type}`,
          key: atom.type,
          label: mapped.label,
          value,
          size: atom.end - atom.start,
          sensitivity: mapped.sensitivity,
          removal: 'with-container',
        })
      })
    }
  }
  let trackIndex = 0
  walkMp4(bytes, moov.dataStart, moov.end, (box) => {
    if (box.type !== 'trak') return
    trackIndex += 1
    const tkhd = findMp4Box(bytes, box.dataStart, box.end, 'tkhd')
    if (tkhd) pushMp4Times(bytes, tkhd, `moov > trak ${trackIndex} > tkhd`, entries)
    const mdia = findMp4Box(bytes, box.dataStart, box.end, 'mdia')
    if (mdia) {
      const mdhd = findMp4Box(bytes, mdia.dataStart, mdia.end, 'mdhd')
      if (mdhd) pushMp4Times(bytes, mdhd, `moov > trak ${trackIndex} > mdia > mdhd`, entries)
    }
    const trakUdta = findMp4Box(bytes, box.dataStart, box.end, 'udta')
    if (trakUdta) {
      const tmeta = findMp4Box(bytes, trakUdta.dataStart, trakUdta.end, 'meta')
      if (tmeta) pushIlstEntries(bytes, tmeta, `moov > trak ${trackIndex} > udta > meta`, entries)
    }
  })
  return entries
}

/* ═══════════════════════════ EBML/Matroska (mkv / webm) ═══════════════════════════ */

/** Número máximo de bytes de un vint EBML (tamaños). */
export const VINT_MAX_BYTES = 8

/**
 * Longitud de un vint según su primer byte: el bit marcador indica cuántos
 * bytes ocupa (0x80→1, 0x40→2, 0x20→3, 0x10→4 … 0x01→8).
 */
export function vintLengthOf(first: number): number {
  if (first === 0) return 0
  let length = 0
  for (let bit = 0x80; bit !== 0; bit = bit >> 1) {
    length += 1
    if ((first & bit) !== 0) return length
  }
  return 0
}

export interface VintInfo {
  /** Longitud en bytes del vint. */
  length: number
  /** Valor big-endian crudo del vint (sin enmascarar; sirve para IDs EBML). */
  value: number
}

/** Lee un vint EBML: devuelve longitud y valor crudo big-endian (IDs ≤ 4 bytes). */
export function readVint(bytes: Uint8Array, offset: number): VintInfo | null {
  if (offset >= bytes.length) return null
  const length = vintLengthOf(bytes[offset])
  if (length === 0 || length > VINT_MAX_BYTES || offset + length > bytes.length) return null
  let value = 0
  for (let i = 0; i < length; i++) value = value * 256 + bytes[offset + i]
  return { length, value }
}

export interface EbmlSize {
  /** Longitud en bytes del vint. */
  length: number
  /** Tamaño decodificado (con el bit marcador enmascarado). */
  value: number
  /** true si es un tamaño "desconocido" (todos los bits de valor a 1). */
  unknown: boolean
}

/** Lee un vint de TAMAÑO EBML (≤ 8 bytes) quitando el bit marcador. */
export function readVintSize(bytes: Uint8Array, offset: number): EbmlSize | null {
  if (offset >= bytes.length) return null
  const length = vintLengthOf(bytes[offset])
  if (length === 0 || length > VINT_MAX_BYTES || offset + length > bytes.length) return null
  // El marcador ocupa el bit (8-length) del primer byte; el resto son valor.
  const firstMask = (1 << (8 - length)) - 1
  let value = bytes[offset] & firstMask
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i]
  const unknown = value === 2 ** (7 * length) - 1
  return { length, value, unknown }
}

/** Escribe un vint de tamaño con la longitud mínima (bit marcador incluido). */
export function writeVintSize(n: number): Uint8Array {
  let length = 1
  let capacity = 0x80 // 2^7, 2^14, 2^21… por cada longitud
  while (length < VINT_MAX_BYTES && n >= capacity) {
    capacity = capacity * 0x80
    length += 1
  }
  const out = new Uint8Array(length)
  let value = capacity + n
  for (let i = length - 1; i >= 0; i--) {
    out[i] = value & 0xff
    value = Math.floor(value / 256)
  }
  return out
}

interface EbmlElement {
  /** ID (valor crudo big-endian del vint). */
  id: number
  /** Offset de inicio del elemento. */
  start: number
  /** Longitud del vint de ID. */
  idLength: number
  /** Inicio de los datos. */
  dataStart: number
  /** Fin (exclusivo) del elemento. */
  end: number
}

/** Lee un elemento EBML en `offset`; null si es inválido o se sale del rango. */
function readEbml(bytes: Uint8Array, offset: number, limit: number): EbmlElement | null {
  const idInfo = readVint(bytes, offset)
  if (!idInfo) return null
  const sizeInfo = readVintSize(bytes, offset + idInfo.length)
  if (!sizeInfo) return null
  const dataStart = offset + idInfo.length + sizeInfo.length
  const end = sizeInfo.unknown ? limit : dataStart + sizeInfo.value
  if (end > limit) return null
  return { id: idInfo.value, start: offset, idLength: idInfo.length, dataStart, end }
}

/** Recorre los elementos EBML de un rango invocando `visit` por cada uno. */
function walkEbml(bytes: Uint8Array, start: number, end: number, visit: (el: EbmlElement) => void): void {
  let offset = start
  while (offset < end) {
    const el = readEbml(bytes, offset, end)
    if (!el) break
    visit(el)
    offset = el.end
  }
}

/** Primer elemento con `wanted` en el rango (loop directo, sin capturas). */
function findEbml(bytes: Uint8Array, start: number, end: number, wanted: number): EbmlElement | null {
  let offset = start
  while (offset < end) {
    const el = readEbml(bytes, offset, end)
    if (!el) break
    if (el.id === wanted) return el
    offset = el.end
  }
  return null
}

/**
 * Relleno `Void` de EXACTAMENTE `total` bytes (id 0xEC + size vint + datos).
 * Sustituye un elemento eliminado por otro del MISMO tamaño para que ninguna
 * posición relativa del Segment cambie (SeekHead/Cues siguen siendo válidos).
 */
function voidFiller(total: number): Uint8Array {
  const out = new Uint8Array(total)
  out[0] = MKV_VOID
  for (let len = 1; len <= 8; len++) {
    const dataLen = total - 1 - len
    if (dataLen < 0) continue
    const capacity = 2 ** (7 * len) - 1
    if (dataLen > capacity) continue
    // size vint de EXACTAMENTE `len` bytes: bit marcador en (8-len) + valor.
    let value = (1 << (7 * len)) + dataLen
    for (let i = len - 1; i >= 0; i--) {
      out[1 + i] = value & 0xff
      value = Math.floor(value / 256)
    }
    return out
  }
  return out
}

/** Reconstruye `Info` sustituyendo el `Title` por un Void del mismo tamaño. */
function rebuildMkvInfo(bytes: Uint8Array, info: EbmlElement, config: StripConfig): Uint8Array {
  const dropTitle = config.mode === 'deep' || config.blocks.includes(BLOCK_TAGS)
  const children: Uint8Array[] = []
  walkEbml(bytes, info.dataStart, info.end, (el) => {
    if (el.id === MKV_TITLE && dropTitle) {
      children.push(voidFiller(el.end - el.start))
      return
    }
    children.push(bytes.slice(el.start, el.end))
  })
  // Cabecera original (id + size vint) + payload del MISMO largo → layout intacto.
  return concat([bytes.slice(info.start, info.dataStart), concat(children)])
}

/**
 * Reconstruye el `Segment` sustituyendo Tags/Attachments/Void por Void del
 * mismo tamaño y re-escribiendo Info sin `Title` (mismo largo). El resultado
 * conserva byte a byte las posiciones de todo lo que no es metadata, así que
 * `SeekHead` y `Cues` (offsets relativos al Segment) siguen siendo válidos.
 */
function rebuildMkvSegment(bytes: Uint8Array, seg: EbmlElement, config: StripConfig): Uint8Array {
  const wants = (block: string): boolean => config.mode === 'deep' || config.blocks.includes(block)
  const children: Uint8Array[] = []
  walkEbml(bytes, seg.dataStart, seg.end, (el) => {
    if (el.id === MKV_TAGS && wants(BLOCK_TAGS)) {
      children.push(voidFiller(el.end - el.start))
      return
    }
    if (el.id === MKV_ATTACHMENTS && wants(BLOCK_ATTACH)) {
      children.push(voidFiller(el.end - el.start))
      return
    }
    if (el.id === MKV_VOID && wants(BLOCK_JUNK)) {
      children.push(voidFiller(el.end - el.start))
      return
    }
    if (el.id === MKV_INFO) {
      children.push(rebuildMkvInfo(bytes, el, config))
      return
    }
    children.push(bytes.slice(el.start, el.end))
  })
  return concat([bytes.slice(seg.start, seg.dataStart), concat(children)])
}

/** Elimina metadata de un contenedor EBML/Matroska (mkv/webm). */
function stripMkv(bytes: Uint8Array, config: StripConfig): Uint8Array {
  const parts: Uint8Array[] = []
  let offset = 0
  while (offset < bytes.length) {
    const el = readEbml(bytes, offset, bytes.length)
    if (!el) {
      if (config.mode === 'deep') break // basura final: se descarta en deep
      parts.push(bytes.slice(offset))
      break
    }
    if (el.id === MKV_SEGMENT) parts.push(rebuildMkvSegment(bytes, el, config))
    else parts.push(bytes.slice(el.start, el.end))
    offset = el.end
  }
  return concat(parts)
}

/** Entero sin signo del payload de un elemento EBML (big-endian). */
function readEbmlUint(bytes: Uint8Array, el: EbmlElement): number {
  let value = 0
  for (let i = el.dataStart; i < el.end; i++) value = value * 256 + bytes[i]
  return value
}

/**
 * Flotante de un elemento EBML (4/8 bytes). El contrato de este dominio lee
 * los dobles de Matroska en little-endian; si el valor LE cae fuera del rango
 * plausible se acepta el big-endian (robustez ante muxers BE sin romper nada).
 */
function readEbmlFloat(bytes: Uint8Array, el: EbmlElement, min: number, max: number): number | null {
  const size = el.end - el.dataStart
  let le: number | null = null
  if (size === 8) le = readFloat64LE(bytes, el.dataStart)
  else if (size === 4) le = readFloat32LE(bytes, el.dataStart)
  if (le !== null && Number.isFinite(le) && le >= min && le <= max) return le
  if (size === 8) {
    const be = readFloat64BE(bytes, el.dataStart)
    if (Number.isFinite(be) && be >= min && be <= max) return be
  }
  return null
}

/** Campos técnicos de un Segment Matroska (Info + Tracks) → bloque 'format'. */
function formatFieldsMkv(bytes: Uint8Array, segment: EbmlElement): MetadataField[] {
  const fields: MetadataField[] = []
  const push = (name: string, value: string): void => pushFormat(fields, name, value)

  let timescale = 1000000 // TimestampScale por defecto (1 ms)
  let durationSec: number | null = null

  walkEbml(bytes, segment.dataStart, segment.end, (el) => {
    if (el.id === MKV_INFO) {
      walkEbml(bytes, el.dataStart, el.end, (kid) => {
        if (kid.id === MKV_TIMECODE_SCALE) {
          const v = readEbmlUint(bytes, kid)
          if (v > 0) timescale = v
        } else if (kid.id === MKV_DURATION) {
          const dur = readEbmlFloat(bytes, kid, 0, 1e21)
          if (dur !== null) durationSec = (dur * timescale) / 1e9
        }
      })
    } else if (el.id === MKV_TRACKS) {
      let index = 0
      walkEbml(bytes, el.dataStart, el.end, (entry) => {
        if (entry.id !== MKV_TRACK_ENTRY || index >= 8) return
        index += 1
        let type = 0
        let codecId = ''
        let width = 0
        let height = 0
        let sampleRate = 0
        let channels = 0
        walkEbml(bytes, entry.dataStart, entry.end, (kid) => {
          switch (kid.id) {
            case MKV_TRACK_TYPE:
              type = readEbmlUint(bytes, kid)
              break
            case MKV_CODEC_ID:
              codecId = DECODER.decode(bytes.slice(kid.dataStart, kid.end)).trim()
              break
            case MKV_PIXEL_WIDTH:
              width = readEbmlUint(bytes, kid)
              break
            case MKV_PIXEL_HEIGHT:
              height = readEbmlUint(bytes, kid)
              break
            case MKV_SAMPLING_FREQ:
              sampleRate = readEbmlFloat(bytes, kid, 1, 1e7) ?? 0
              break
            case MKV_CHANNELS:
              channels = readEbmlUint(bytes, kid)
              break
          }
        })
        const kindLabel = type === 1 ? 'vídeo' : type === 2 ? 'audio' : type === 17 ? 'subtítulos' : 'datos'
        const parts = [kindLabel]
        if (codecId) parts.push(`códec ${codecId}`)
        if (type === 1 && width > 0 && height > 0) parts.push(`${width}x${height}`)
        if (type === 2) {
          if (sampleRate > 0) parts.push(`${formatNumber(sampleRate)} Hz`)
          if (channels > 0) parts.push(`${channels} canales`)
        }
        push(`Pista ${index}`, parts.join(' · '))
      })
    }
  })

  if (durationSec !== null) push('Duración', formatDuration(durationSec))
  push('Escala de tiempo', `${timescale} ns`)
  return fields
}

/** Pareja `TagName` / `TagString` de los `SimpleTag` de un elemento Tags. */
interface MkvTagPair {
  name: string
  value: string
  size: number
  hex?: string
}

/** Lee Tags > Tag > SimpleTag: nombre (TagName) + valor (TagString/TagBinary). */
function mkvSimpleTags(bytes: Uint8Array, tags: EbmlElement): MkvTagPair[] {
  const out: MkvTagPair[] = []
  walkEbml(bytes, tags.dataStart, tags.end, (tag) => {
    if (tag.id !== MKV_TAG) return
    walkEbml(bytes, tag.dataStart, tag.end, (simple) => {
      if (simple.id !== MKV_SIMPLE_TAG) return
      let name = ''
      let value = ''
      let hex: string | undefined
      walkEbml(bytes, simple.dataStart, simple.end, (field) => {
        if (field.id === MKV_TAG_NAME) name = cap(DECODER.decode(bytes.slice(field.dataStart, field.end)))
        else if (field.id === MKV_TAG_STRING) value = cap(DECODER.decode(bytes.slice(field.dataStart, field.end)))
        else if (field.id === MKV_TAG_BINARY) hex = shortHex(bytes.slice(field.dataStart, field.end))
      })
      if (name) out.push({ name, value, size: simple.end - simple.start, hex })
    })
  })
  return out
}

/** Inventario exhaustivo de un contenedor EBML/Matroska (mkv/webm). Nunca lanza. */
function mkvEntries(bytes: Uint8Array, segment: EbmlElement): MetaEntry[] {
  const entries: MetaEntry[] = []
  walkEbml(bytes, segment.dataStart, segment.end, (el) => {
    if (el.id === MKV_INFO) {
      const infoItems: Array<[number, string, string, boolean, MetaRemoval]> = [
        [MKV_TITLE, 'Title', 'Título', false, 'individual'],
        [MKV_DATE_UTC, 'DateUTC', 'Fecha (UTC)', false, 'never'],
        [MKV_MUXING_APP, 'MuxingApp', 'Aplicación de multiplexado', false, 'never'],
        [MKV_WRITING_APP, 'WritingApp', 'Aplicación de escritura', false, 'never'],
        [MKV_SEGMENT_UID, 'SegmentUID', 'Identificador del segmento', true, 'never'],
      ]
      walkEbml(bytes, el.dataStart, el.end, (kid) => {
        const match = infoItems.find(([id]) => id === kid.id)
        if (!match) return
        const [, key, label, isBinary, removal] = match
        const raw = bytes.slice(kid.dataStart, kid.end)
        entries.push({
          where: 'Segment > Info',
          key,
          label,
          value: isBinary ? '' : cap(DECODER.decode(raw)),
          size: kid.end - kid.dataStart,
          hex: isBinary ? shortHex(raw) : undefined,
          sensitivity: 'medium',
          removal,
        })
      })
    } else if (el.id === MKV_TAGS) {
      for (const pair of mkvSimpleTags(bytes, el)) {
        entries.push({
          where: 'Tags > Tag > SimpleTag',
          key: pair.name,
          value: pair.value,
          size: pair.size,
          hex: pair.hex,
          sensitivity: 'medium',
          removal: 'with-container',
        })
      }
    } else if (el.id === MKV_ATTACHMENTS) {
      walkEbml(bytes, el.dataStart, el.end, (file) => {
        if (file.id !== MKV_ATTACHMENT) return
        walkEbml(bytes, file.dataStart, file.end, (field) => {
          if (field.id !== MKV_FILE_NAME) return
          entries.push({
            where: 'Segment > Attachments > AttachedFile',
            key: 'FileName',
            label: 'Archivo adjunto',
            value: cap(DECODER.decode(bytes.slice(field.dataStart, field.end))),
            size: field.end - field.dataStart,
            sensitivity: 'medium',
            removal: 'with-container',
          })
        })
      })
    } else if (el.id === MKV_TRACKS) {
      let track = 0
      walkEbml(bytes, el.dataStart, el.end, (entry) => {
        if (entry.id !== MKV_TRACK_ENTRY) return
        track += 1
        walkEbml(bytes, entry.dataStart, entry.end, (kid) => {
          const meta: [string, string] | null =
            kid.id === MKV_TRACK_NAME
              ? ['Name', 'Nombre']
              : kid.id === MKV_TRACK_LANGUAGE
                ? ['Language', 'Idioma']
                : kid.id === MKV_CODEC_ID
                  ? ['CodecID', 'Códec']
                  : null
          if (!meta) return
          entries.push({
            where: `Segment > Tracks > TrackEntry ${track}`,
            key: meta[0],
            label: meta[1],
            value: cap(DECODER.decode(bytes.slice(kid.dataStart, kid.end))),
            size: kid.end - kid.dataStart,
            sensitivity: 'low',
            removal: 'never',
          })
        })
      })
    }
  })
  return entries
}

/** Escanea metadata de un contenedor EBML/Matroska (mkv/webm). Nunca lanza. */
function scanMkv(bytes: Uint8Array): MetadataReport {
  try {
    const segment = findEbml(bytes, 0, bytes.length, MKV_SEGMENT)
    if (!segment) return EMPTY_REPORT
    const tagsFields: MetadataField[] = []
    let hasTags = false
    let attachments = 0
    let junkFound = false
    walkEbml(bytes, segment.dataStart, segment.end, (el) => {
      if (el.id === MKV_INFO) {
        walkEbml(bytes, el.dataStart, el.end, (kid) => {
          if (kid.id === MKV_TITLE) {
            tagsFields.push({ name: 'Título', value: cap(DECODER.decode(bytes.slice(kid.dataStart, kid.end))), sensitivity: 'low' })
          }
        })
      } else if (el.id === MKV_TAGS) {
        hasTags = true
        // Etiquetas reales: cada SimpleTag (nombre + valor) al bloque 'tags'.
        for (const pair of mkvSimpleTags(bytes, el)) {
          tagsFields.push({ name: pair.name, value: pair.value || (pair.hex ?? ''), sensitivity: 'medium' })
        }
      } else if (el.id === MKV_ATTACHMENTS) {
        walkEbml(bytes, el.dataStart, el.end, (kid) => {
          if (kid.id === MKV_ATTACHMENT) attachments += 1
        })
      } else if (el.id === MKV_VOID) {
        junkFound = true
      }
    })
    const blocks: MetadataBlock[] = []
    if (hasTags || tagsFields.length > 0) {
      const fields = [...tagsFields]
      if (fields.length === 0) fields.push({ name: 'Etiquetas (Tags)', value: 'Presentes', sensitivity: 'medium' })
      blocks.push({ id: BLOCK_TAGS, label: 'Etiquetas (Tags/Title)', fields, removableIn: 'light' })
    }
    if (attachments > 0) {
      blocks.push({
        id: BLOCK_ATTACH,
        label: 'Archivos adjuntos',
        fields: [{ name: 'Adjuntos', value: `${attachments} adjuntos`, sensitivity: 'medium' }],
        removableIn: 'light',
      })
    }
    if (junkFound) {
      blocks.push({
        id: BLOCK_JUNK,
        label: 'Restos (Void)',
        fields: [{ name: 'Void', value: 'Presentes', sensitivity: 'low' }],
        removableIn: 'light',
      })
    }
    const formatFields = formatFieldsMkv(bytes, segment)
    if (formatFields.length > 0) {
      blocks.push({ id: BLOCK_FORMAT, label: 'Formato (técnico)', removableIn: 'never', fields: formatFields })
    }
    const entries = mkvEntries(bytes, segment)
    pushFormatEntries(entries, 'Segment', formatFields)
    if (blocks.length === 0 && entries.length === 0) return EMPTY_REPORT
    const flat = blocks.flatMap((b) => b.fields)
    return { fields: flat, count: flat.length, blocks, entries }
  } catch {
    return EMPTY_REPORT
  }
}

/* ═══════════════════════════════ RIFF / AVI ═══════════════════════════════ */

/** Etiquetas traducidas de los chunks del LIST "INFO" de AVI. */
const AVI_INFO_LABELS: Record<string, { label: string; sensitivity: MetadataField['sensitivity'] }> = {
  INAM: { label: 'Título', sensitivity: 'low' },
  IART: { label: 'Artista', sensitivity: 'medium' },
  ICOP: { label: 'Copyright', sensitivity: 'medium' },
  ICMT: { label: 'Comentario', sensitivity: 'medium' },
  ICRD: { label: 'Fecha', sensitivity: 'medium' },
  IGNR: { label: 'Género', sensitivity: 'low' },
  IPRD: { label: 'Producto', sensitivity: 'low' },
  ISFT: { label: 'Software', sensitivity: 'medium' },
  IENG: { label: 'Codificador', sensitivity: 'medium' },
}

interface AviChunk {
  id: string
  /** Offset del campo `id` (inicio del chunk). */
  start: number
  /** Tamaño declarado (solo datos, sin cabecera ni pad). */
  size: number
  /** Inicio de los datos (tras id+size). */
  dataStart: number
  /** Fin (exclusivo) del chunk, pad a par incluido. */
  end: number
  /** Si es un LIST, tipo del interior ('INFO', 'hdrl', 'movi'…). */
  listType?: string
}

/** Lee un chunk RIFF/AVI en `offset`; null si es inválido o se sale del rango. */
function readAviChunk(bytes: Uint8Array, offset: number, limit: number): AviChunk | null {
  if (offset + 8 > limit) return null
  const id = asciiAt(bytes, offset)
  const size = readU32LE(bytes, offset + 4)
  const dataStart = offset + 8
  const dataEnd = dataStart + size
  if (dataEnd > limit) return null
  const end = Math.min(dataEnd + (size & 1), limit) // pad a par
  const chunk: AviChunk = { id, start: offset, size, dataStart, end }
  if (id === 'LIST' && size >= 4) chunk.listType = asciiAt(bytes, dataStart)
  return chunk
}

/** Recorre los chunks RIFF/AVI de un rango llamando a `visit` por cada uno. */
function walkAvi(bytes: Uint8Array, start: number, end: number, visit: (chunk: AviChunk) => void): void {
  let offset = start
  while (offset + 8 <= end) {
    const chunk = readAviChunk(bytes, offset, end)
    if (!chunk) break
    visit(chunk)
    offset = chunk.end
  }
}

/** Elimina metadata de un contenedor RIFF/AVI: LIST INFO + JUNK/PAD. */
function stripAvi(bytes: Uint8Array, config: StripConfig): Uint8Array {
  if (bytes.length < 12 || asciiAt(bytes, 0) !== 'RIFF' || asciiAt(bytes, 8) !== 'AVI ') return bytes.slice()
  const wants = (block: string): boolean => config.mode === 'deep' || config.blocks.includes(block)
  const parts: Uint8Array[] = []
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const chunk = readAviChunk(bytes, offset, bytes.length)
    if (!chunk) {
      if (config.mode === 'deep') break
      parts.push(bytes.slice(offset))
      break
    }
    const isInfo = chunk.listType === 'INFO'
    const isJunk = chunk.id === 'JUNK' || chunk.id === 'PAD '
    const drop = (isInfo && wants(BLOCK_INFO)) || (isJunk && wants(BLOCK_JUNK))
    if (!drop) parts.push(bytes.slice(chunk.start, chunk.end))
    offset = chunk.end
  }
  const body = concat(parts)
  const header = concat([asciiAtBytes('RIFF'), new Uint8Array(4), asciiAtBytes('AVI ')])
  writeU32LE(header, 4, body.length + 4) // tamaño RIFF = total − 8
  return concat([header, body])
}

/** Campos técnicos de un contenedor AVI (avih + strh) → bloque 'format'. */
function formatFieldsAvi(bytes: Uint8Array): MetadataField[] {
  const fields: MetadataField[] = []
  const push = (name: string, value: string): void => pushFormat(fields, name, value)

  let microSecPerFrame = 0
  let totalFrames = 0
  let width = 0
  let height = 0
  let codec = ''

  walkAvi(bytes, 12, bytes.length, (chunk) => {
    if (chunk.listType !== 'hdrl') return
    walkAvi(bytes, chunk.dataStart + 4, chunk.end, (sub) => {
      if (sub.id === 'avih' && sub.size >= 40) {
        microSecPerFrame = readU32LE(bytes, sub.dataStart)
        totalFrames = readU32LE(bytes, sub.dataStart + 16)
        width = readU32LE(bytes, sub.dataStart + 32)
        height = readU32LE(bytes, sub.dataStart + 36)
      } else if (sub.listType === 'strl') {
        walkAvi(bytes, sub.dataStart + 4, sub.end, (stream) => {
          if (stream.id === 'strh' && stream.size >= 8 && !codec) {
            codec = asciiAt(bytes, stream.dataStart + 4)
          }
        })
      } else if (sub.id === 'strh' && sub.size >= 8 && !codec) {
        codec = asciiAt(bytes, sub.dataStart + 4)
      }
    })
  })

  if (microSecPerFrame > 0) {
    const fps = 1000000 / microSecPerFrame
    push('FPS', formatNumber(fps))
    if (width > 0 && height > 0) push('Resolución', `${width}x${height}`)
    if (totalFrames > 0) push('Duración', formatDuration(totalFrames / fps))
  }
  if (codec) push('Códec', codec)
  return fields
}

/** Inventario exhaustivo de un contenedor RIFF/AVI (INFO + JUNK/PAD/IDIT). */
function aviEntries(bytes: Uint8Array): MetaEntry[] {
  const entries: MetaEntry[] = []
  walkAvi(bytes, 12, bytes.length, (chunk) => {
    if (chunk.id === 'JUNK' || chunk.id === 'PAD ') {
      entries.push({ where: `RIFF > ${chunk.id.trim()}`, key: chunk.id.trim(), label: 'Relleno', value: '', size: chunk.size, sensitivity: 'low', removal: 'individual' })
      return
    }
    if (chunk.id === 'IDIT') {
      entries.push({
        where: 'RIFF > IDIT',
        key: 'IDIT',
        label: 'Fecha de digitalización',
        value: cap(DECODER.decode(bytes.slice(chunk.dataStart, chunk.end))),
        size: chunk.size,
        sensitivity: 'medium',
        removal: 'never',
      })
      return
    }
    if (chunk.listType !== 'INFO') return
    walkAvi(bytes, chunk.dataStart + 4, chunk.end, (sub) => {
      const mapped = AVI_INFO_LABELS[sub.id]
      entries.push({
        where: `LIST > INFO > ${sub.id}`,
        key: sub.id,
        label: mapped?.label,
        value: cap(DECODER.decode(bytes.slice(sub.dataStart, sub.end))),
        size: sub.size,
        sensitivity: mapped?.sensitivity ?? 'medium',
        removal: 'with-container',
      })
    })
  })
  return entries
}

/** Escanea metadata de un contenedor RIFF/AVI (LIST INFO traducido). Nunca lanza. */
function scanAvi(bytes: Uint8Array): MetadataReport {
  try {
    if (bytes.length < 12 || asciiAt(bytes, 0) !== 'RIFF' || asciiAt(bytes, 8) !== 'AVI ') return EMPTY_REPORT
    const fields: MetadataField[] = []
    let junkFound = false
    walkAvi(bytes, 12, bytes.length, (chunk) => {
      if (chunk.id === 'JUNK' || chunk.id === 'PAD ') {
        junkFound = true
        return
      }
      if (chunk.listType !== 'INFO') return
      walkAvi(bytes, chunk.dataStart + 4, chunk.end, (sub) => {
        const mapped = AVI_INFO_LABELS[sub.id]
        if (!mapped) return
        const value = cap(DECODER.decode(bytes.slice(sub.dataStart, sub.end)))
        if (value) fields.push({ name: mapped.label, value, sensitivity: mapped.sensitivity })
      })
    })
    const blocks: MetadataBlock[] = []
    if (fields.length > 0) {
      blocks.push({ id: BLOCK_INFO, label: 'Información (LIST INFO)', fields, removableIn: 'light' })
    }
    if (junkFound) {
      blocks.push({
        id: BLOCK_JUNK,
        label: 'Restos (JUNK/PAD)',
        fields: [{ name: 'JUNK/PAD', value: 'Presentes', sensitivity: 'low' }],
        removableIn: 'light',
      })
    }
    const formatFields = formatFieldsAvi(bytes)
    if (formatFields.length > 0) {
      blocks.push({ id: BLOCK_FORMAT, label: 'Formato (técnico)', removableIn: 'never', fields: formatFields })
    }
    const entries = aviEntries(bytes)
    pushFormatEntries(entries, 'RIFF', formatFields)
    if (blocks.length === 0 && entries.length === 0) return EMPTY_REPORT
    const flat = blocks.flatMap((b) => b.fields)
    return { fields: flat, count: flat.length, blocks, entries }
  } catch {
    return EMPTY_REPORT
  }
}

/* ═══════════════════════════ Despacho del dominio ═══════════════════════════ */

/** Detecta el contenedor por sus primeros bytes (el scan no recibe kind). */
function sniffContainer(bytes: Uint8Array): 'mp4' | 'mkv' | 'avi' | null {
  if (bytes.length >= 12 && asciiAt(bytes, 0) === 'RIFF' && asciiAt(bytes, 8) === 'AVI ') return 'avi'
  const first = readMp4Box(bytes, 0, bytes.length)
  if (first && (first.type === 'ftyp' || first.type === 'moov' || first.type === 'mdat')) return 'mp4'
  const header = readVint(bytes, 0)
  if (header && header.value === EBML_HEADER_ID) return 'mkv'
  return null
}

/** Cirugía por kind (el strip sí recibe el kind del engine). */
function stripVideo(bytes: Uint8Array, kind: FileKind, config: StripConfig): Uint8Array {
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  switch (kind) {
    case 'mp4':
    case 'mov':
      return stripMp4(bytes, config)
    case 'mkv':
    case 'webm':
      return stripMkv(bytes, config)
    case 'avi':
      return stripAvi(bytes, config)
    default:
      throw new Error('Limpiar metadata para este formato llega en una fase próxima')
  }
}

/** Escaneo por kind (never lanza; inválido → EMPTY_REPORT). */
function scanVideo(bytes: Uint8Array, kind: 'mp4' | 'mkv' | 'avi' | null): MetadataReport {
  switch (kind) {
    case 'mp4':
      return scanMp4(bytes)
    case 'mkv':
      return scanMkv(bytes)
    case 'avi':
      return scanAvi(bytes)
    default:
      return EMPTY_REPORT
  }
}

/** Dominio VIDEO: mp4, mov, mkv, avi y webm. */
export const videoDomain: MetaDomain = {
  kinds: ['mp4', 'mov', 'mkv', 'avi', 'webm'],
  scan: async (bytes) => {
    try {
      return scanVideo(bytes, sniffContainer(bytes))
    } catch {
      return EMPTY_REPORT
    }
  },
  strip: async (bytes, kind, config, report: Reporter) => {
    report('Leyendo contenedor', 30)
    const out = stripVideo(bytes, kind, config)
    report('Reconstruyendo contenedor', 90)
    return out
  },
}