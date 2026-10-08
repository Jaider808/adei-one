/**
 * ADEI-ONE — Dominio AUDIO de "Eliminar metadata" (mp3, flac, m4a, wav).
 *
 * Contrato en `domain.ts`: cirugía binaria pura (Node-testable), sin DOM ni
 * canvas. El escaneo identifica el formato por firma (magic bytes) y el strip
 * reconstruye el contenedor descartando solo lo necesario, sin tocar el audio.
 *
 * Bloques por formato:
 * - mp3:
 *   - 'id3v2'  → etiqueta ID3v2 inicial (cabecera + cuerpo + footer opcional)
 *   - 'id3v1'  → etiqueta ID3v1 en los últimos 128 bytes
 *   - 'ape'    → etiqueta APEv2 junto al final (normalmente antes de ID3v1)
 *   - 'lyrics' → Lyrics3v2 incrustada junto al final (antes de ID3v1/APE)
 * - flac:
 *   - 'vorbis'   → bloque VORBIS_COMMENT (tipo 4)
 *   - 'pictures' → bloque PICTURE (tipo 6)
 *   - (deep: además PADDING 1/127 y cualquier ID3v1/ID3v2 residual)
 * - m4a:
 *   - 'tags' → caja `udta` completa (incluye `meta`/`ilst`)
 *   - (deep: además `free`/`skip`/`wide`/`uuid` y basura final)
 * - wav:
 *   - 'info' → chunk LIST/INFO (INAM, IART, ICMT, ICRD, IENG, ISFT, ICOP, IKEY)
 *   - 'tech' → bext/iXML/'cue '/acid/smpl (metadatos técnicos)
 *   - (deep: además JUNK/PAD y basura final tras el último chunk)
 *
 * Ambos modos son lossless para el contenido de audio; 'deep' elimina además
 * padding, cajas vacías y restos. Los bytes devueltos son SIEMPRE un array
 * nuevo (la entrada nunca se muta).
 */
import { asciiAt, concat, patchMp4Stco, readU32BE, readU32LE, writeU32LE } from './chunks'
import { EMPTY_REPORT, shortHex } from './domain'
import type { MetaDomain, Reporter, StripConfig } from './domain'
import type { FileKind, MetadataBlock, MetadataField, MetadataReport, MetaEntry } from '@/core/types'

/** Limpia un valor de texto para mostrarlo en el visor (sin saltos largos ni binario). */
function cleanValue(value: string, max = 200): string {
  const out = value.replace(/\s+/g, ' ').trim()
  return out.length > max ? `${out.slice(0, max)}…` : out
}

/** Decodifica texto UTF-8 quitando caracteres nulos y espacios colgantes. */
function decodeUtf8Trim(bytes: Uint8Array): string {
  const decoded = new TextDecoder().decode(bytes)
  return decoded.split('\u0000').join('').trim()
}

/** Compara `bytes[offset..offset+sig.length)` con una cadena ASCII conocida. */
function sigAt(bytes: Uint8Array, offset: number, sig: string): boolean {
  if (offset < 0 || offset + sig.length > bytes.length) return false
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig.charCodeAt(i)) return false
  }
  return true
}

/** Busca la ÚLTIMA aparición de `needle` ASCII dentro de [from, to) (índices de BYTES). */
function lastIndexOfAscii(bytes: Uint8Array, from: number, to: number, needle: string): number {
  if (to - from < needle.length) return -1
  const code = [...needle].map((c) => c.charCodeAt(0))
  const first = code[0] ?? 0
  let i = to - needle.length
  while (i >= from) {
    if (bytes[i] !== first) {
      i -= 1
      continue
    }
    let j = 1
    while (j < needle.length && bytes[i + j] === code[j]) j += 1
    if (j === needle.length) return i
    i -= 1
  }
  return -1
}

/** Entero de 4 bytes big-endian SYNC-SAFE (bit alto de cada byte a 0), formato ID3v2. */
function readSynchsafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  )
}

/** Entero de 4 bytes big-endian a partir de 3 bytes (longitud de bloque FLAC). */
function readU24BE(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]) >>> 0)
}

/** Entero de 2 bytes little-endian sin signo (chunk `fmt ` del WAV). */
function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

/** Convierte un conjunto de bloques en el report de la tool (con `count` correcto). */
function toReport(blocks: MetadataBlock[], entries: MetaEntry[] = []): MetadataReport {
  if (!blocks.length && !entries.length) return EMPTY_REPORT
  const fields = blocks.flatMap((b) => b.fields)
  return { fields, count: fields.length, blocks, entries }
}

/** Vuelca los campos técnicos de formato como entradas `never` (se conservan). */
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

/** Recorta las regiones [start, end) indicadas y devuelve un Uint8Array nuevo. */
function removeRegions(bytes: Uint8Array, regions: Array<[number, number]>): Uint8Array {
  if (!regions.length) return bytes.slice()
  regions.sort((a, b) => a[0] - b[0])
  const parts: Uint8Array[] = []
  let cursor = 0
  for (const [start, end] of regions) {
    if (end <= cursor) continue
    if (start > cursor) parts.push(bytes.slice(cursor, start))
    if (end > cursor) cursor = end
  }
  if (cursor < bytes.length) parts.push(bytes.slice(cursor))
  return concat(parts)
}

/* ── Detección de formato ── */

type AudioKind = 'mp3' | 'flac' | 'm4a' | 'wav'

/** Primeras cajas típicas de un contenedor ISO-BMFF (m4a/mp4/mov). */
const M4A_LEAD_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'udta', 'uuid'])

/** Detecta el formato de audio por firma binaria (magic bytes). Nunca lanza. */
function detectAudio(bytes: Uint8Array): AudioKind | null {
  try {
    if (sigAt(bytes, 0, 'fLaC')) return 'flac'
    if (sigAt(bytes, 0, 'RIFF') && sigAt(bytes, 8, 'WAVE')) return 'wav'
    if (bytes.length >= 8 && M4A_LEAD_BOXES.has(asciiAt(bytes, 4))) return 'm4a'
    if (sigAt(bytes, 0, 'ID3')) return 'mp3'
    // Sync MPEG (0xFF + 3 bits de versión a 1) en los primeros bytes, sin ID3.
    const probeEnd = Math.min(bytes.length, 4096)
    for (let i = 0; i + 1 < probeEnd; i++) {
      const b0 = bytes[i]
      const b1 = bytes[i + 1]
      if (b0 === 0xff && (b1 & 0xe0) === 0xe0) return 'mp3'
    }
    return null
  } catch {
    return null
  }
}

/* ── ID3v2 (mp3) ── */

interface Id3v2Frame {
  id: string
  data: Uint8Array
}

interface Id3v2Info {
  /** Longitud TOTAL de la etiqueta en el archivo (cabecera + cuerpo + footer). */
  totalLength: number
  frames: Id3v2Frame[]
}

/** Tamaño de frame ID3v2 con tolerancia entre escritores synchsafe y BE planos. */
function frameSizeAt(bytes: Uint8Array, offset: number, major: number, bodyEnd: number): number {
  const preferred = major >= 4 ? readU32BE(bytes, offset) : readSynchsafe(bytes, offset)
  const alternate = major >= 4 ? readSynchsafe(bytes, offset) : readU32BE(bytes, offset)
  if (preferred > 0 && offset + 10 + preferred <= bodyEnd) return preferred
  if (alternate > 0 && offset + 10 + alternate <= bodyEnd) return alternate
  return preferred
}

/** Parsea la etiqueta ID3v2 inicial (si existe). Devuelve null si no hay. */
function parseId3v2(bytes: Uint8Array): Id3v2Info | null {
  if (bytes.length < 10 || !sigAt(bytes, 0, 'ID3')) return null
  const major = bytes[3]
  const flags = bytes[5]
  const tagSize = readSynchsafe(bytes, 6)
  const hasFooter = (flags & 0x10) !== 0
  const bodyEnd = 10 + tagSize
  const totalLength = bodyEnd + (hasFooter ? 10 : 0)
  if (totalLength > bytes.length) {
    // Escritores antiguos usan BE plano para el tamaño de la etiqueta.
    const altSize = readU32BE(bytes, 6)
    if (10 + altSize <= bytes.length) {
      return { totalLength: 10 + altSize, frames: parseId3v2Body(bytes, 10, 10 + altSize, major) }
    }
    return null
  }
  return { totalLength, frames: parseId3v2Body(bytes, 10, bodyEnd, major) }
}

/** Recorre los frames del cuerpo de una ID3v2. */
function parseId3v2Body(bytes: Uint8Array, start: number, bodyEnd: number, major: number): Id3v2Frame[] {
  const frames: Id3v2Frame[] = []
  if (major < 3) return frames // v2.2 usa IDs de 3 bytes: no lo soportamos
  let off = start
  while (off + 10 <= bodyEnd) {
    const rawId = String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3])
    const nulPos = rawId.indexOf('\u0000')
    const id = (nulPos < 0 ? rawId : rawId.slice(0, nulPos)).trim()
    if (!id) break
    const size = frameSizeAt(bytes, off + 4, major, bodyEnd)
    const frameEnd = off + 10 + size
    if (size <= 0 || frameEnd > bodyEnd) break
    frames.push({ id, data: bytes.slice(off + 10, frameEnd) })
    off = frameEnd
  }
  return frames
}

/** Decodifica una cadena UTF-16BE sin BOM (v2.4) intercambiando los bytes. */
function decodeUtf16BE(value: Uint8Array): string {
  const even = value.length % 2 === 0 ? value : value.slice(0, -1)
  const swapped = new Uint8Array(even.length)
  for (let i = 0; i + 1 < even.length; i += 2) {
    swapped[i] = even[i + 1]
    swapped[i + 1] = even[i]
  }
  return new TextDecoder('utf-16le').decode(swapped)
}

/** Texto de un frame ID3v2 según su byte de encoding. */
function decodeFrameBytes(enc: number, body: Uint8Array): string {
  if (enc === 0) return new TextDecoder('iso-8859-1').decode(body)
  if (enc === 1) {
    if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) {
      return new TextDecoder('utf-16le').decode(body.slice(2))
    }
    if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) {
      return decodeUtf16BE(body.slice(2))
    }
    return new TextDecoder('utf-16le').decode(body)
  }
  if (enc === 2) return decodeUtf16BE(body)
  return new TextDecoder('utf-8').decode(body)
}

/** Valor legible (sin nulos ni BOM) de un frame de texto ID3v2. */
function frameText(data: Uint8Array): string {
  if (!data.length) return ''
  const enc = data[0]
  const out = decodeFrameBytes(enc, data.slice(1))
  return out.replace(/^\uFEFF/, '').split('\u0000').join('').trim()
}

/** Extrae el comentario real de un frame COMM (enc + idioma + descripción + texto). */
function commText(data: Uint8Array): string {
  if (data.length < 4) return ''
  const enc = data[0]
  const rest = data.slice(4) // saltamos el idioma (3 bytes)
  let textStart = rest.length
  if (enc === 1 || enc === 2) {
    // descripción UTF-16 terminada en doble cero alineado
    for (let i = 0; i + 2 <= rest.length; i += 2) {
      if (rest[i] === 0 && rest[i + 1] === 0) {
        textStart = i + 2
        break
      }
    }
  } else {
    const nul = rest.indexOf(0)
    if (nul >= 0) textStart = nul + 1
  }
  if (textStart >= rest.length) return ''
  return frameText(concat([Uint8Array.of(enc), rest.slice(textStart)]))
}

/** ¿La etiqueta ID3v1 ocupa los últimos 128 bytes? */
function hasId3v1(bytes: Uint8Array): boolean {
  return bytes.length >= 128 && sigAt(bytes, bytes.length - 128, 'TAG')
}

/** Campo fijo de la ID3v1 (30 bytes, terminado en nulo). */
function fixedField(bytes: Uint8Array): string {
  const value = new TextDecoder('iso-8859-1').decode(bytes)
  const nul = value.indexOf('\u0000')
  return cleanValue(nul < 0 ? value : value.slice(0, nul))
}

/** Región [start, end) de la etiqueta APEv2, o null. */
function apeRegion(bytes: Uint8Array): [number, number] | null {
  const end = bytes.length - (hasId3v1(bytes) ? 128 : 0)
  const windowSize = Math.min(end, 262144)
  if (windowSize <= 0) return null
  const index = lastIndexOfAscii(bytes, end - windowSize, end, 'APETAGEX')
  if (index < 0) return null
  // footer: "APETAGEX" + versión(4) + tamaño items(4) + count(4) + flags(4) + reservado(8)
  if (index + 24 > bytes.length) return null
  const itemsSize = readU32LE(bytes, index + 12)
  const flags = readU32LE(bytes, index + 20)
  const hasHeader = (flags & 0x80000000) !== 0
  const start = index - itemsSize - (hasHeader ? 32 : 0)
  if (start < 0) return null
  return [start, index + 32]
}

/** Región [start, end) de la letra Lyrics3v2, o null. */
function lyricsRegion(bytes: Uint8Array): [number, number] | null {
  const end = bytes.length - (hasId3v1(bytes) ? 128 : 0)
  const windowSize = Math.min(end, 65536)
  if (windowSize <= 0) return null
  // "LYRICS200"(9) + campo(6) + tamaño decimal(6) = 21 bytes de cabecera al final.
  const index = lastIndexOfAscii(bytes, end - windowSize, end, 'LYRICS200')
  if (index < 0) return null
  const sizeDigitsStart = index + 9 + 6
  if (sizeDigitsStart + 6 > end) return null
  const digits = new TextDecoder().decode(bytes.slice(sizeDigitsStart, sizeDigitsStart + 6))
  if (!/^\d{6}$/.test(digits)) return null
  const start = index - Number(digits)
  if (start < 0) return null
  return [start, sizeDigitsStart + 6]
}

/* ── Strip mp3 ── */

function stripMp3(bytes: Uint8Array, config: StripConfig): Uint8Array {
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  const want = new Set(config.blocks)
  const regions: Array<[number, number]> = []
  const add = (region: [number, number] | null): void => {
    if (region && region[0] >= 0 && region[1] <= bytes.length && region[1] > region[0]) {
      regions.push(region)
    }
  }
  if (config.mode === 'deep' || want.has('id3v2')) {
    const t = parseId3v2(bytes)
    add(t ? [0, t.totalLength] : null)
  }
  if ((config.mode === 'deep' || want.has('id3v1')) && hasId3v1(bytes)) {
    add([bytes.length - 128, bytes.length])
  }
  if (config.mode === 'deep' || want.has('ape')) add(apeRegion(bytes))
  if (config.mode === 'deep' || want.has('lyrics')) add(lyricsRegion(bytes))
  return removeRegions(bytes, regions)
}

/* ── Cabecera MPEG (datos técnicos del mp3) ── */

/** Información de una cabecera de trama MPEG válida (para el bloque 'format'). */
interface MpegFrameInfo {
  version: 'MPEG1' | 'MPEG2' | 'MPEG2.5'
  layer: 1 | 2 | 3
  /** Bitrate en kbps. */
  bitrate: number
  /** Frecuencia de muestreo en Hz. */
  sampleRate: number
  channels: 'Stereo' | 'Mono'
}

/** Bitrate (kbps) por índice (1..14; 0 y 15 inválidos) según versión y capa. */
const MPEG_BITRATE_TABLES: Record<string, number[]> = {
  'MPEG1:L1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  'MPEG1:L2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  'MPEG1:L3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  'MPEG2:L1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  'MPEG2:L23': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
}

/** Frecuencias de muestreo (Hz) por índice (0..2; 3 = reservado) según versión. */
const MPEG_SAMPLE_RATES: Record<string, number[]> = {
  MPEG1: [44100, 48000, 32000],
  MPEG2: [22050, 24000, 16000],
  'MPEG2.5': [11025, 12000, 8000],
}

/** Parsea la cabecera MPEG de 4 bytes en `offset` (sync 0xFFE). null si no es válida. */
function parseMpegFrame(bytes: Uint8Array, offset: number): MpegFrameInfo | null {
  if (offset < 0 || offset + 4 > bytes.length) return null
  const b0 = bytes[offset]
  const b1 = bytes[offset + 1]
  const b2 = bytes[offset + 2]
  const b3 = bytes[offset + 3]
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null
  const versionBits = (b1 >> 3) & 0x03
  const layerBits = (b1 >> 1) & 0x03
  if (versionBits === 0b01 || layerBits === 0b00) return null // reservados
  const version: MpegFrameInfo['version'] = versionBits === 0b00 ? 'MPEG2.5' : versionBits === 0b10 ? 'MPEG2' : 'MPEG1'
  const layer: MpegFrameInfo['layer'] = layerBits === 0b01 ? 3 : layerBits === 0b10 ? 2 : 1
  const bitrateIndex = (b2 >> 4) & 0x0f
  const sampleIndex = (b2 >> 2) & 0x03
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleIndex === 3) return null
  const tableKey = version === 'MPEG1' ? `MPEG1:L${layer}` : layer === 1 ? 'MPEG2:L1' : 'MPEG2:L23'
  const bitrate = MPEG_BITRATE_TABLES[tableKey]?.[bitrateIndex]
  const sampleRate = MPEG_SAMPLE_RATES[version]?.[sampleIndex]
  if (!bitrate || !sampleRate) return null
  const mode = (b3 >> 6) & 0x03
  return { version, layer, bitrate, sampleRate, channels: mode === 0b11 ? 'Mono' : 'Stereo' }
}

/** Primera cabecera MPEG válida a partir de `start` (ventana acotada). Nunca lanza. */
function findMpegFrame(bytes: Uint8Array, start: number): MpegFrameInfo | null {
  const limit = Math.min(bytes.length - 4, Math.max(0, start) + 65536)
  for (let i = Math.max(0, start); i <= limit; i++) {
    const frame = parseMpegFrame(bytes, i)
    if (frame) return frame
  }
  return null
}

/** Duración legible en español («0:07», «1:02:03», «12,5 s»). */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 s'
  if (seconds < 60) return `${seconds.toFixed(1).replace('.', ',')} s`
  const total = Math.round(seconds)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Bloque 'format' (técnico, nunca se borra) desde la primera cabecera MPEG. */
function scanMp3Tech(bytes: Uint8Array, audioStart: number, blocks: MetadataBlock[], entries: MetaEntry[]): void {
  const frame = findMpegFrame(bytes, audioStart)
  if (!frame) return
  let audioSize = bytes.length - Math.max(0, audioStart)
  if (hasId3v1(bytes)) audioSize -= 128
  const ape = apeRegion(bytes)
  if (ape) audioSize -= ape[1] - ape[0]
  const lyrics = lyricsRegion(bytes)
  if (lyrics) audioSize -= lyrics[1] - lyrics[0]
  const duration = audioSize > 0 ? (audioSize * 8) / (frame.bitrate * 1000) : 0
  const fields: MetadataField[] = [
    { name: 'Formato', value: 'MP3', sensitivity: 'low' },
    { name: 'Versión', value: frame.version, sensitivity: 'low' },
    { name: 'Capa', value: `Layer ${'I'.repeat(frame.layer)}`, sensitivity: 'low' },
    { name: 'Bitrate', value: `${frame.bitrate} kbps`, sensitivity: 'low' },
    { name: 'Frecuencia de muestreo', value: `${frame.sampleRate} Hz`, sensitivity: 'low' },
    { name: 'Canales', value: frame.channels, sensitivity: 'low' },
    { name: 'Duración', value: formatDuration(duration), sensitivity: 'low' },
  ]
  blocks.push({ id: 'format', label: 'Información técnica', removableIn: 'never', fields })
  pushFormatEntries(entries, 'MPEG', fields)
}

/* ── Scan mp3 ── */

const ID3_FRAME_MAP: Record<string, { name: string; sensitivity: MetadataField['sensitivity'] }> = {
  TIT2: { name: 'Título', sensitivity: 'low' },
  TPE1: { name: 'Artista', sensitivity: 'medium' },
  TPE2: { name: 'Álbum artista', sensitivity: 'medium' },
  TALB: { name: 'Álbum', sensitivity: 'low' },
  TDRC: { name: 'Año', sensitivity: 'low' },
  TYER: { name: 'Año', sensitivity: 'low' },
  TCON: { name: 'Género', sensitivity: 'low' },
  TCOM: { name: 'Compositor', sensitivity: 'medium' },
  TPUB: { name: 'Editor', sensitivity: 'low' },
  TRCK: { name: 'Pista', sensitivity: 'low' },
  TPOS: { name: 'Disco', sensitivity: 'low' },
  TCOP: { name: 'Copyright', sensitivity: 'medium' },
  TENC: { name: 'Codificado por', sensitivity: 'medium' },
  TSSE: { name: 'Software', sensitivity: 'medium' },
  TSRC: { name: 'ISRC', sensitivity: 'medium' },
  USLT: { name: 'Letra', sensitivity: 'medium' },
  TXXX: { name: 'Texto personalizado', sensitivity: 'medium' },
  WXXX: { name: 'URL', sensitivity: 'low' },
}

/** Etiqueta legible y valor de un frame ID3v2 (texto o binario); nunca descarta nada. */
function id3Entry(frame: Id3v2Frame): {
  label?: string
  value: string
  hex?: string
  sensitivity: MetadataField['sensitivity']
} {
  const mapped = ID3_FRAME_MAP[frame.id]
  if (frame.id === 'COMM') return { label: 'Comentario', value: cleanValue(commText(frame.data)), sensitivity: 'medium' }
  if (frame.id === 'USLT') return { label: 'Letra', value: cleanValue(commText(frame.data)), sensitivity: 'medium' }
  if (frame.id === 'APIC' || frame.id === 'PIC') {
    return { label: 'Carátula', value: '', hex: shortHex(frame.data), sensitivity: 'high' }
  }
  if (frame.id.startsWith('T') || frame.id.startsWith('W')) {
    const text = cleanValue(frameText(frame.data))
    if (text) return { label: mapped?.name, value: text, sensitivity: mapped?.sensitivity ?? 'medium' }
  }
  return { label: mapped?.name, value: '', hex: shortHex(frame.data), sensitivity: mapped?.sensitivity ?? 'medium' }
}

/** Ítems de una etiqueta APEv2 (clave + valor + tamaño). Nunca lanza. */
function apeEntries(bytes: Uint8Array, region: [number, number]): MetaEntry[] {
  const out: MetaEntry[] = []
  const [start, end] = region
  if (end - start < 32) return out
  const footer = end - 32
  const flags = readU32LE(bytes, footer + 20)
  const hasHeader = (flags & 0x80000000) !== 0
  const itemsEnd = footer
  let offset = start + (hasHeader ? 32 : 0)
  while (offset + 8 <= itemsEnd) {
    const valueSize = readU32LE(bytes, offset)
    let cursor = offset + 8
    while (cursor < itemsEnd && bytes[cursor] !== 0) cursor += 1
    const key = new TextDecoder('iso-8859-1').decode(bytes.slice(offset + 8, cursor)).trim()
    const valueStart = cursor + 1
    const valueEnd = valueStart + valueSize
    if (!key || valueEnd > itemsEnd) break
    const raw = bytes.slice(valueStart, valueEnd)
    const text = cleanValue(decodeUtf8Trim(raw))
    out.push({
      where: `APE > ${key}`,
      key,
      value: text,
      ...(text ? {} : { hex: shortHex(raw) }),
      size: valueSize,
      sensitivity: 'medium',
      removal: 'with-container',
    })
    offset = valueEnd
  }
  return out
}

function scanMp3(bytes: Uint8Array): MetadataReport {
  const blocks: MetadataBlock[] = []
  const entries: MetaEntry[] = []

  const id3v2 = parseId3v2(bytes)
  if (id3v2) {
    const fields: MetadataField[] = []
    for (const frame of id3v2.frames) {
      const mapped = ID3_FRAME_MAP[frame.id]
      if (mapped) {
        const value = cleanValue(frameText(frame.data))
        if (value) fields.push({ name: mapped.name, value, sensitivity: mapped.sensitivity })
      } else if (frame.id === 'COMM') {
        const value = cleanValue(commText(frame.data))
        if (value) fields.push({ name: 'Comentario', value, sensitivity: 'medium' })
      }
      // Inventario exhaustivo: TODO frame, también los desconocidos.
      const info = id3Entry(frame)
      entries.push({
        where: `ID3v2 > ${frame.id}`,
        key: frame.id,
        label: info.label,
        value: info.value,
        size: frame.data.length,
        hex: info.hex,
        sensitivity: info.sensitivity,
        removal: 'with-container',
      })
    }
    if (id3v2.frames.some((f) => f.id === 'APIC')) {
      fields.push({ name: 'Carátula', value: 'Presente', sensitivity: 'high' })
    }
    if (fields.length) blocks.push({ id: 'id3v2', label: 'Etiqueta ID3v2', removableIn: 'light', fields })
  }

  if (hasId3v1(bytes)) {
    const t = bytes.length - 128
    const candidates: MetadataField[] = [
      { name: 'Título', value: fixedField(bytes.slice(t + 3, t + 33)), sensitivity: 'low' },
      { name: 'Artista', value: fixedField(bytes.slice(t + 33, t + 63)), sensitivity: 'medium' },
      { name: 'Álbum', value: fixedField(bytes.slice(t + 63, t + 93)), sensitivity: 'low' },
    ]
    const fields = candidates.filter((f) => f.value !== '')
    if (fields.length) blocks.push({ id: 'id3v1', label: 'Etiqueta ID3v1', removableIn: 'light', fields })
    const fixed: Array<[string, string, number, number, MetadataField['sensitivity']]> = [
      ['TITLE', 'Título', t + 3, t + 33, 'low'],
      ['ARTIST', 'Artista', t + 33, t + 63, 'medium'],
      ['ALBUM', 'Álbum', t + 63, t + 93, 'low'],
      ['YEAR', 'Año', t + 93, t + 97, 'low'],
      ['COMMENT', 'Comentario', t + 97, t + 127, 'medium'],
    ]
    for (const [key, label, from, to, sensitivity] of fixed) {
      const value = fixedField(bytes.slice(from, to))
      if (value) entries.push({ where: `ID3v1 > ${key}`, key, label, value, sensitivity, removal: 'with-container' })
    }
    const genre = bytes[t + 127]
    if (genre) {
      entries.push({ where: 'ID3v1 > GENRE', key: 'GENRE', label: 'Género', value: String(genre), sensitivity: 'low', removal: 'with-container' })
    }
  }

  const ape = apeRegion(bytes)
  if (ape) {
    blocks.push({
      id: 'ape',
      label: 'Etiqueta APE',
      removableIn: 'light',
      fields: [{ name: 'Etiqueta APE', value: 'Presente', sensitivity: 'low' }],
    })
    entries.push(...apeEntries(bytes, ape))
  }

  const lyrics = lyricsRegion(bytes)
  if (lyrics) {
    blocks.push({
      id: 'lyrics',
      label: 'Letra incrustada (Lyrics3)',
      removableIn: 'light',
      fields: [{ name: 'Letra', value: 'Presente', sensitivity: 'low' }],
    })
    const [start, end] = lyrics
    const marker = lastIndexOfAscii(bytes, start, end, 'LYRICS200')
    const textEnd = marker >= 0 ? marker : end
    entries.push({
      where: 'Lyrics3',
      key: 'LYRICS200',
      label: 'Letra',
      value: cleanValue(new TextDecoder('iso-8859-1').decode(bytes.slice(start, textEnd))),
      size: textEnd - start,
      sensitivity: 'low',
      removal: 'with-container',
    })
  }

  scanMp3Tech(bytes, id3v2?.totalLength ?? 0, blocks, entries)
  return toReport(blocks, entries)
}

/* ── FLAC ── */

/** Offset tras un ID3v2 residual que precede al fLaC (0 si no lo hay). */
function endOfLeadingId3v2(bytes: Uint8Array): number {
  const t = parseId3v2(bytes)
  return t ? t.totalLength : 0
}

/** Lee las parejas CLAVE=valor de un VORBIS_COMMENT (longitudes en little-endian). */
function scanVorbisComment(
  bytes: Uint8Array,
  start: number,
  end: number,
  fields: MetadataField[],
  entries: MetaEntry[],
): void {
  const MAP: Record<string, { name: string; sensitivity: MetadataField['sensitivity'] }> = {
    TITLE: { name: 'Título', sensitivity: 'low' },
    ARTIST: { name: 'Artista', sensitivity: 'medium' },
    ALBUM: { name: 'Álbum', sensitivity: 'low' },
    DATE: { name: 'Fecha', sensitivity: 'low' },
    GENRE: { name: 'Género', sensitivity: 'low' },
    COMMENT: { name: 'Comentario', sensitivity: 'medium' },
  }
  let offset = start
  if (offset + 8 > end) return
  const vendorLen = readU32LE(bytes, offset)
  offset += 4
  if (offset + vendorLen > end) return
  const vendor = decodeUtf8Trim(bytes.slice(offset, offset + vendorLen))
  if (vendor) {
    entries.push({
      where: 'Vorbis comment > VENDOR',
      key: 'VENDOR',
      label: 'Codificador',
      value: cleanValue(vendor),
      size: vendorLen,
      sensitivity: 'low',
      removal: 'with-container',
    })
  }
  offset += vendorLen
  if (offset + 4 > end) return
  const count = readU32LE(bytes, offset)
  offset += 4
  for (let k = 0; k < count && offset + 4 <= end; k++) {
    const len = readU32LE(bytes, offset)
    offset += 4
    if (offset + len > end) break
    const pair = decodeUtf8Trim(bytes.slice(offset, offset + len))
    offset += len
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const key = pair.slice(0, eq)
    const value = cleanValue(pair.slice(eq + 1))
    const mapped = MAP[key.toUpperCase()]
    if (mapped && value) fields.push({ name: mapped.name, value, sensitivity: mapped.sensitivity })
    // Inventario exhaustivo: TODA pareja, también las no mapeadas.
    entries.push({
      where: `Vorbis comment > ${key}`,
      key,
      label: mapped?.name,
      value,
      size: len,
      sensitivity: mapped?.sensitivity ?? 'medium',
      removal: 'with-container',
    })
  }
}

/** Campos técnicos del bloque STREAMINFO (datos 10..17); vacío si no es interpretable. */
function flacStreamInfoFields(data: Uint8Array): MetadataField[] {
  const fields: MetadataField[] = []
  if (data.length < 18) return fields
  const sampleRate = ((data[10] << 12) | (data[11] << 4) | (data[12] >> 4)) & 0xfffff
  if (!sampleRate) return fields
  const channels = ((data[12] >> 1) & 0x07) + 1
  const bitsPerSample = (((data[12] & 0x01) << 4) | (data[13] >> 4)) + 1
  const totalSamples =
    (data[13] & 0x0f) * 0x100000000 + (data[14] << 24) + (data[15] << 16) + (data[16] << 8) + data[17]
  fields.push({ name: 'Formato', value: 'FLAC', sensitivity: 'low' })
  fields.push({ name: 'Frecuencia de muestreo', value: `${sampleRate} Hz`, sensitivity: 'low' })
  fields.push({ name: 'Canales', value: String(channels), sensitivity: 'low' })
  fields.push({ name: 'Bits por muestra', value: String(bitsPerSample), sensitivity: 'low' })
  fields.push({ name: 'Duración', value: formatDuration(totalSamples / sampleRate), sensitivity: 'low' })
  return fields
}

function scanFlac(bytes: Uint8Array): MetadataReport {
  const base = endOfLeadingId3v2(bytes)
  if (bytes.length < base + 4 || !sigAt(bytes, base, 'fLaC')) return EMPTY_REPORT
  const blocks: MetadataBlock[] = []
  const entries: MetaEntry[] = []
  const commentFields: MetadataField[] = []
  let hasPicture = false
  let streamInfoData: Uint8Array | null = null
  let i = base + 4
  while (i + 4 <= bytes.length) {
    const header = bytes[i]
    const type = header & 0x7f
    const last = (header & 0x80) !== 0
    const len = readU24BE(bytes, i + 1)
    const next = i + 4 + len
    if (next > bytes.length) break
    if (type === 0) {
      streamInfoData = bytes.slice(i + 4, next)
    } else if (type === 4) {
      scanVorbisComment(bytes, i + 4, next, commentFields, entries)
    } else if (type === 6) {
      hasPicture = true
      entries.push({
        where: 'FLAC > PICTURE',
        key: 'PICTURE',
        label: 'Carátula',
        value: '',
        hex: shortHex(bytes.slice(i + 4, next)),
        size: len,
        sensitivity: 'high',
        removal: 'individual',
      })
    } else if (type === 1) {
      // El relleno (PADDING) es estructural: el modo ligero NO lo elimina (solo
      // el profundo). Marcarlo `individual` prometía un borrado seleccionable que
      // el limpiador no hace en ligero → se declara `never` (relleno, no metadata).
      entries.push({ where: 'FLAC > PADDING', key: 'PADDING', label: 'Relleno', value: '', size: len, sensitivity: 'low', removal: 'never' })
    } else {
      // Cualquier otro bloque (APPLICATION, SEEKTABLE, CUESHEET…): no se oculta.
      entries.push({ where: `FLAC > bloque ${type}`, key: `BLOCK_${type}`, value: '', size: len, sensitivity: 'low', removal: 'never' })
    }
    i = next
    if (last) break
  }
  if (commentFields.length) {
    blocks.push({ id: 'vorbis', label: 'Comentarios Vorbis', removableIn: 'light', fields: commentFields })
  }
  if (hasPicture) {
    blocks.push({
      id: 'pictures',
      label: 'Carátulas (PICTURE)',
      removableIn: 'light',
      fields: [{ name: 'Carátula', value: 'Presente', sensitivity: 'high' }],
    })
  }
  const techFields = flacStreamInfoFields(streamInfoData ?? new Uint8Array())
  if (techFields.length) {
    blocks.push({ id: 'format', label: 'Información técnica', removableIn: 'never', fields: techFields })
    pushFormatEntries(entries, 'STREAMINFO', techFields)
  }
  return toReport(blocks, entries)
}

function stripFlac(bytes: Uint8Array, config: StripConfig): Uint8Array {
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  const want = new Set(config.blocks)
  const parseBase = endOfLeadingId3v2(bytes)
  if (bytes.length < parseBase + 4 || !sigAt(bytes, parseBase, 'fLaC')) return bytes.slice()
  const parts: Uint8Array[] = []
  // En light se conserva un ID3v2 residual que preceda al fLaC; en deep se descarta.
  if (parseBase > 0 && config.mode !== 'deep') parts.push(bytes.slice(0, parseBase))
  parts.push(bytes.slice(parseBase, parseBase + 4))
  let i = parseBase + 4
  let audioStart = i
  while (i + 4 <= bytes.length) {
    const header = bytes[i]
    const type = header & 0x7f
    const last = (header & 0x80) !== 0
    const len = readU24BE(bytes, i + 1)
    const next = i + 4 + len
    if (next > bytes.length) break
    const drop =
      config.mode === 'deep'
        ? type === 4 || type === 6 || type === 1 || type === 127
        : (want.has('vorbis') && type === 4) || (want.has('pictures') && type === 6)
    if (!drop) parts.push(bytes.slice(i, next))
    i = next
    audioStart = next
    if (last) break
  }
  parts.push(bytes.slice(audioStart))
  let out = concat(parts)
  if (config.mode === 'deep' && hasId3v1(out)) out = out.slice(0, out.length - 128)
  return out
}

/* ── ISO-BMFF / m4a ── */

interface Box {
  type: string
  start: number
  contentStart: number
  end: number
}

/** Parsea una caja ISO-BMFF (size 4BE + type 4). Soporta largesize (1) y hasta EOF (0). */
function parseBox(bytes: Uint8Array, offset: number, limit: number): Box | null {
  if (offset + 8 > limit) return null
  let size = readU32BE(bytes, offset)
  const type = asciiAt(bytes, offset + 4)
  let contentStart = offset + 8
  if (size === 1) {
    if (offset + 16 > limit) return null
    const hi = readU32BE(bytes, offset + 8)
    const lo = readU32BE(bytes, offset + 12)
    if (hi > 0xffffffff) return null // fuera del rango manejable
    size = hi * 0x100000000 + lo
    contentStart = offset + 16
  } else if (size === 0) {
    size = limit - offset
  }
  if (size < contentStart - offset || offset + size > limit) return null
  return { type, start: offset, contentStart, end: offset + size }
}

/** Liba las cajas directas dentro de [start, end). Nunca lanza. */
function listBoxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = []
  let offset = start
  while (offset + 8 <= end) {
    const box = parseBox(bytes, offset, end)
    if (!box) break
    out.push(box)
    offset = box.end
  }
  return out
}

/** Caja cabecera reconstruida (size 4BE + type 4 ASCII + cuerpo). */
function boxHeader(type: string, body: Uint8Array): Uint8Array {
  const size = 8 + body.length
  const typeBytes = Uint8Array.from([...type].map((c) => c.charCodeAt(0)))
  return concat([Uint8Array.of((size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff), typeBytes, body])
}

/** Reconstruye `moov` recalculando su tamaño tras descartar cajas internas. */
function rebuildMoov(bytes: Uint8Array, box: Box, config: StripConfig, want: Set<string>): Uint8Array {
  const junk = new Set(['free', 'skip', 'wide', 'uuid'])
  const parts: Uint8Array[] = []
  for (const child of listBoxes(bytes, box.contentStart, box.end)) {
    if (config.mode === 'deep' && junk.has(child.type)) continue
    if ((config.mode === 'deep' || want.has('tags')) && child.type === 'udta') continue
    parts.push(bytes.slice(child.start, child.end))
  }
  return boxHeader('moov', concat(parts))
}

function stripM4a(bytes: Uint8Array, config: StripConfig): Uint8Array {
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  const want = new Set(config.blocks)
  const root = listBoxes(bytes, 0, bytes.length)
  const first = root[0]
  const last = root[root.length - 1]
  if (!first || first.start !== 0 || !last) return bytes.slice()
  const junk = new Set(['free', 'skip', 'wide', 'uuid'])
  const mdat = root.find((b) => b.type === 'mdat') ?? null
  const oldMdatStart = mdat ? mdat.start : null

  const parts: Uint8Array[] = []
  let moovBytes: Uint8Array | null = null
  let running = 0
  let newMdatStart: number | null = null
  for (const box of root) {
    if (config.mode === 'deep' && junk.has(box.type)) continue
    if (box.type === 'moov') {
      const piece = rebuildMoov(bytes, box, config, want)
      moovBytes = piece
      parts.push(piece)
    } else {
      parts.push(bytes.slice(box.start, box.end))
    }
    if (box.type === 'mdat') newMdatStart = running
    running += parts[parts.length - 1]!.length
  }
  // En light se conserva la basura final; en deep se recorta.
  if (config.mode !== 'deep' && last.end < bytes.length) parts.push(bytes.slice(last.end))

  // Remux lossless: si mdat se desplazó por el encogido de moov, se ajustan
  // los offsets absolutos stco/co64 (igual que hace ffmpeg al remuxear).
  const delta = oldMdatStart !== null && newMdatStart !== null ? newMdatStart - oldMdatStart : 0
  if (moovBytes && delta !== 0) patchMp4Stco(moovBytes, delta)
  return concat(parts)
}

const M4A_FRAME_MAP: Record<string, { name: string; sensitivity: MetadataField['sensitivity'] }> = {
  '©nam': { name: 'Título', sensitivity: 'low' },
  '©ART': { name: 'Artista', sensitivity: 'medium' },
  '©alb': { name: 'Álbum', sensitivity: 'low' },
  '©day': { name: 'Año', sensitivity: 'low' },
  '©cmt': { name: 'Comentario', sensitivity: 'medium' },
  '©gen': { name: 'Género', sensitivity: 'low' },
}

/** Valor de texto de un frame `ilst` (caja 'data' interna). */
function ilstValue(bytes: Uint8Array, item: Box): string | null {
  const dataBox = listBoxes(bytes, item.contentStart, item.end).find((b) => b.type === 'data')
  if (!dataBox) return null
  // versión/flags (4 bytes) tras la cabecera de la caja 'data'.
  const value = decodeUtf8Trim(bytes.slice(dataBox.contentStart + 4, dataBox.end))
  return value || null
}

/** Campos técnicos desde `moov` (mvhd: duración/escala; stsd: códec). Vacío si no hay datos. */
function m4aTechFields(bytes: Uint8Array, moov: Box): MetadataField[] {
  const fields: MetadataField[] = []
  const children = listBoxes(bytes, moov.contentStart, moov.end)

  const mvhd = children.find((b) => b.type === 'mvhd')
  if (mvhd && mvhd.contentStart + 20 <= mvhd.end) {
    const version = bytes[mvhd.contentStart]
    let timescale = 0
    let duration = 0
    if (version === 0) {
      timescale = readU32BE(bytes, mvhd.contentStart + 12)
      duration = readU32BE(bytes, mvhd.contentStart + 16)
    } else if (version === 1 && mvhd.contentStart + 32 <= mvhd.end) {
      timescale = readU32BE(bytes, mvhd.contentStart + 20)
      duration = readU32BE(bytes, mvhd.contentStart + 28)
    }
    if (timescale > 0) {
      fields.push({ name: 'Duración', value: formatDuration(duration / timescale), sensitivity: 'low' })
      fields.push({ name: 'Escala de tiempo', value: String(timescale), sensitivity: 'low' })
    }
  }

  // Códec del primer sample entry de moov>trak>mdia>minf>stbl>stsd.
  const trak = children.find((b) => b.type === 'trak')
  const mdia = trak ? listBoxes(bytes, trak.contentStart, trak.end).find((b) => b.type === 'mdia') : null
  const minf = mdia ? listBoxes(bytes, mdia.contentStart, mdia.end).find((b) => b.type === 'minf') : null
  const stbl = minf ? listBoxes(bytes, minf.contentStart, minf.end).find((b) => b.type === 'stbl') : null
  const stsd = stbl ? listBoxes(bytes, stbl.contentStart, stbl.end).find((b) => b.type === 'stsd') : null
  if (stsd && stsd.contentStart + 16 <= stsd.end) {
    const codec = asciiAt(bytes, stsd.contentStart + 12)
    if (/^[\x20-\x7e]{4}$/.test(codec)) {
      fields.push({ name: 'Códec', value: codec, sensitivity: 'low' })
    }
  }
  return fields
}

/** Entrada de inventario de un item de `ilst` (texto legible o hex si es binario). */
function m4aItemEntry(bytes: Uint8Array, item: Box, where: string): MetaEntry {
  const mapped = M4A_FRAME_MAP[item.type]
  const dataBox = listBoxes(bytes, item.contentStart, item.end).find((b) => b.type === 'data')
  let text = ''
  let hex: string | undefined
  if (dataBox && dataBox.contentStart + 8 <= dataBox.end) {
    const payload = bytes.slice(dataBox.contentStart + 8, dataBox.end)
    if (item.type === 'covr') hex = shortHex(payload)
    else {
      text = cleanValue(decodeUtf8Trim(payload))
      if (!text) hex = shortHex(payload)
    }
  }
  return {
    where: `${where} > ${item.type}`,
    key: item.type,
    label: item.type === 'covr' ? 'Carátula' : mapped?.name,
    value: text,
    size: item.end - item.start,
    hex,
    sensitivity: item.type === 'covr' ? 'high' : mapped?.sensitivity ?? 'medium',
    removal: 'with-container',
  }
}

function scanM4a(bytes: Uint8Array): MetadataReport {
  const root = listBoxes(bytes, 0, bytes.length)
  const moov = root.find((b) => b.type === 'moov')
  if (!moov) return EMPTY_REPORT
  const blocks: MetadataBlock[] = []
  const entries: MetaEntry[] = []
  const moovChildren = listBoxes(bytes, moov.contentStart, moov.end)
  const udta = moovChildren.find((b) => b.type === 'udta')
  // `meta` suele estar bajo `udta`; algunos ficheros la llevan directamente en `moov`.
  const container = udta ?? moov
  const meta = listBoxes(bytes, container.contentStart, container.end).find((b) => b.type === 'meta')
  if (meta) {
    // `meta` es full-box: versión/flags (4 bytes) antes de sus hijos.
    const ilst = listBoxes(bytes, meta.contentStart + 4, meta.end).find((b) => b.type === 'ilst')
    if (ilst) {
      const where = udta ? 'moov > udta > meta > ilst' : 'moov > meta > ilst'
      const fields: MetadataField[] = []
      for (const item of listBoxes(bytes, ilst.contentStart, ilst.end)) {
        const mapped = M4A_FRAME_MAP[item.type]
        if (mapped) {
          const value = ilstValue(bytes, item)
          if (value) fields.push({ name: mapped.name, value: cleanValue(value), sensitivity: mapped.sensitivity })
        }
        if (item.type === 'covr') fields.push({ name: 'Carátula', value: 'Presente', sensitivity: 'high' })
        // Inventario exhaustivo: TODO item, también los desconocidos.
        entries.push(m4aItemEntry(bytes, item, where))
      }
      if (fields.length) {
        blocks.push({ id: 'tags', label: 'Etiquetas (ilst)', removableIn: 'light', fields })
      }
    }
  }
  const techFields = m4aTechFields(bytes, moov)
  if (techFields.length) {
    blocks.push({ id: 'format', label: 'Información técnica', removableIn: 'never', fields: techFields })
    pushFormatEntries(entries, 'moov', techFields)
  }
  return toReport(blocks, entries)
}

/* ── WAV (RIFF) ── */

const WAV_INFO_MAP: Record<string, { name: string; sensitivity: MetadataField['sensitivity'] }> = {
  INAM: { name: 'Título', sensitivity: 'low' },
  IART: { name: 'Artista', sensitivity: 'medium' },
  ICMT: { name: 'Comentario', sensitivity: 'medium' },
  ICRD: { name: 'Fecha', sensitivity: 'low' },
  IENG: { name: 'Ingeniero', sensitivity: 'medium' },
  ISFT: { name: 'Software', sensitivity: 'low' },
  ICOP: { name: 'Copyright', sensitivity: 'medium' },
  IKEY: { name: 'Palabras clave', sensitivity: 'low' },
}

/** IDs de chunk técnico del WAV (se agrupan en el bloque 'tech'). */
const WAV_TECH_IDS = new Set(['bext', 'iXML', 'cue ', 'acid', 'smpl'])

/** ¿El chunk de `offset` es un LIST cuyo tipo interior es INFO? */
function isListInfo(bytes: Uint8Array, offset: number): boolean {
  return sigAt(bytes, offset, 'LIST') && sigAt(bytes, offset + 8, 'INFO')
}

/** Parsea los sub-chunks de un LIST/INFO y los vuelca a `fields` + `entries`. */
function scanListInfo(bytes: Uint8Array, start: number, end: number, fields: MetadataField[], entries: MetaEntry[]): void {
  if (end - start < 12 || !sigAt(bytes, start + 8, 'INFO')) return
  let i = start + 12
  while (i + 8 <= end) {
    const id = asciiAt(bytes, i)
    const size = readU32LE(bytes, i + 4)
    const chunkEnd = i + 8 + size
    if (chunkEnd > end) break
    const value = cleanValue(new TextDecoder('iso-8859-1').decode(bytes.slice(i + 8, chunkEnd)))
    const mapped = WAV_INFO_MAP[id]
    if (mapped && value) fields.push({ name: mapped.name, value, sensitivity: mapped.sensitivity })
    // Inventario exhaustivo: TODO sub-chunk, también los no mapeados.
    entries.push({
      where: `LIST > INFO > ${id}`,
      key: id,
      label: mapped?.name,
      value,
      size,
      sensitivity: mapped?.sensitivity ?? 'medium',
      removal: 'with-container',
    })
    i = chunkEnd + (size & 1)
  }
}

/** Campos técnicos del chunk `fmt ` + duración desde el chunk 'data'. Vacío si no se interpreta. */
function wavFormatFields(fmtData: Uint8Array | null, dataSize: number): MetadataField[] {
  const fields: MetadataField[] = []
  if (!fmtData || fmtData.length < 16) return fields
  const formatTag = readU16LE(fmtData, 0)
  const channels = readU16LE(fmtData, 2)
  const sampleRate = readU32LE(fmtData, 4)
  const byteRate = readU32LE(fmtData, 8)
  const bitsPerSample = readU16LE(fmtData, 14)
  if (!sampleRate && !byteRate) return fields
  fields.push({
    name: 'Formato',
    value: formatTag === 0x0001 ? 'PCM' : `0x${formatTag.toString(16).padStart(4, '0').toUpperCase()}`,
    sensitivity: 'low',
  })
  if (channels) fields.push({ name: 'Canales', value: String(channels), sensitivity: 'low' })
  if (sampleRate) fields.push({ name: 'Frecuencia de muestreo', value: `${sampleRate} Hz`, sensitivity: 'low' })
  if (byteRate) fields.push({ name: 'Tasa de bytes', value: `${byteRate} B/s`, sensitivity: 'low' })
  if (bitsPerSample) fields.push({ name: 'Bits por muestra', value: String(bitsPerSample), sensitivity: 'low' })
  fields.push({ name: 'Duración', value: formatDuration(byteRate > 0 ? dataSize / byteRate : 0), sensitivity: 'low' })
  return fields
}

function scanWav(bytes: Uint8Array): MetadataReport {
  if (bytes.length < 12 || !sigAt(bytes, 0, 'RIFF') || !sigAt(bytes, 8, 'WAVE')) return EMPTY_REPORT
  const blocks: MetadataBlock[] = []
  const entries: MetaEntry[] = []
  const infoFields: MetadataField[] = []
  const techIds: string[] = []
  let fmtData: Uint8Array | null = null
  let dataSize = 0
  let i = 12
  while (i + 8 <= bytes.length) {
    const id = asciiAt(bytes, i)
    const size = readU32LE(bytes, i + 4)
    const chunkEnd = i + 8 + size
    if (chunkEnd > bytes.length) break
    if (id === 'fmt ') fmtData = bytes.slice(i + 8, chunkEnd)
    else if (id === 'data') dataSize = size
    if (id === 'LIST') {
      scanListInfo(bytes, i, chunkEnd, infoFields, entries)
    } else if (WAV_TECH_IDS.has(id)) {
      techIds.push(id.trim())
      entries.push({
        where: `RIFF > ${id.trim()}`,
        key: id.trim(),
        label: 'Bloque técnico',
        value: '',
        hex: shortHex(bytes.slice(i + 8, chunkEnd)),
        size,
        sensitivity: 'low',
        removal: 'individual',
      })
    } else if (id === 'JUNK' || id === 'PAD ') {
      // Relleno estructural: el modo ligero NO lo elimina (solo el profundo) y no
      // hay bloque seleccionable para él → se declara `never`, no `individual`.
      entries.push({ where: `RIFF > ${id.trim()}`, key: id.trim(), label: 'Relleno', value: '', size, sensitivity: 'low', removal: 'never' })
    }
    i = chunkEnd + (size & 1)
  }
  if (infoFields.length) {
    blocks.push({ id: 'info', label: 'Información del archivo (LIST/INFO)', removableIn: 'light', fields: infoFields })
  }
  if (techIds.length) {
    blocks.push({
      id: 'tech',
      label: 'Metadatos técnicos',
      removableIn: 'light',
      fields: techIds.slice(0, 8).map((id2): MetadataField => ({ name: 'Bloque técnico', value: id2, sensitivity: 'low' })),
    })
  }
  const techFields = wavFormatFields(fmtData, dataSize)
  if (techFields.length) {
    blocks.push({ id: 'format', label: 'Información técnica', removableIn: 'never', fields: techFields })
    pushFormatEntries(entries, 'fmt ', techFields)
  }
  return toReport(blocks, entries)
}

function stripWav(bytes: Uint8Array, config: StripConfig): Uint8Array {
  if (config.mode === 'light' && config.blocks.length === 0) return bytes.slice()
  const want = new Set(config.blocks)
  if (bytes.length < 12 || !sigAt(bytes, 0, 'RIFF') || !sigAt(bytes, 8, 'WAVE')) return bytes.slice()
  // 'RIFF' + [size a reescribir] + 'WAVE' + chunks conservados.
  const parts: Uint8Array[] = [bytes.slice(0, 4), new Uint8Array(4), bytes.slice(8, 12)]
  let i = 12
  while (i + 8 <= bytes.length) {
    const id = asciiAt(bytes, i)
    const size = readU32LE(bytes, i + 4)
    const chunkEnd = i + 8 + size
    if (chunkEnd > bytes.length) break
    const padEnd = chunkEnd + (size & 1)
    const drop =
      config.mode === 'deep'
        ? isListInfo(bytes, i) || WAV_TECH_IDS.has(id) || id === 'JUNK' || id === 'PAD '
        : (want.has('info') && isListInfo(bytes, i)) || (want.has('tech') && WAV_TECH_IDS.has(id))
    if (!drop) parts.push(bytes.slice(i, chunkEnd))
    i = padEnd > bytes.length ? bytes.length : padEnd
  }
  // Basura final: en light se conserva; en deep se recorta tras el último chunk conocido.
  if (config.mode !== 'deep' && i < bytes.length) parts.push(bytes.slice(i))
  const out = concat(parts)
  writeU32LE(out, 4, out.length - 8)
  return out
}

/* ── Dominio ── */

/** Dominio AUDIO de "Eliminar metadata": escaneo y strip de mp3/flac/m4a/wav. */
export const audioDomain: MetaDomain = {
  kinds: ['mp3', 'flac', 'm4a', 'wav'],
  scan: async (bytes: Uint8Array): Promise<MetadataReport> => {
    try {
      switch (detectAudio(bytes)) {
        case 'flac':
          return scanFlac(bytes)
        case 'wav':
          return scanWav(bytes)
        case 'm4a':
          return scanM4a(bytes)
        case 'mp3':
          return scanMp3(bytes)
        default:
          return EMPTY_REPORT
      }
    } catch {
      // Ante parseo inválido, nunca lanzamos: report vacío.
      return EMPTY_REPORT
    }
  },
  strip: async (bytes: Uint8Array, kind: FileKind, config: StripConfig, report: Reporter): Promise<Uint8Array> => {
    report('Limpiando metadata', 50)
    switch (kind) {
      case 'mp3':
        return stripMp3(bytes, config)
      case 'flac':
        return stripFlac(bytes, config)
      case 'm4a':
        return stripM4a(bytes, config)
      case 'wav':
        return stripWav(bytes, config)
      default:
        // Formato de audio no soportado todavía: claro y con la subcadena esperada.
        throw new Error(`La limpieza de metadata de audio para este formato llega en una fase próxima`)
    }
  },
}