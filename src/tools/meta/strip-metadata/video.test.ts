/**
 * ADEI-ONE — Tests del dominio VIDEO de "Eliminar metadata" (`video.ts`):
 * mp4, mov, mkv y avi. Cirugía binaria pura → fixtures byte a byte (patrón de
 * `chunks.test.ts`). Verifica scan, strip ligero por bloques y deep, y que los
 * tamaños de los contenedores queden consistentes (re-parseando el resultado).
 */
import { describe, expect, it } from 'vitest'
import { stripMetadata } from './engine'
import { asciiAt, concat, readU32BE } from './chunks'
import { readVint, readVintSize, videoDomain, writeVintSize } from './video'
import type { FileKind, MetadataReport } from '@/core/types'

/* ── Helpers de construcción de fixtures ── */

function ascii(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0) & 0xff))
}

function u32be(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function u32le(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** UTF-8 real (Matroska usa UTF-8, no Latin-1): necesario para acentos. */
function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/** ¿`bytes` contiene la secuencia `pattern`? */
function containsBytes(bytes: Uint8Array, pattern: Uint8Array): boolean {
  outer: for (let i = 0; i + pattern.length <= bytes.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (bytes[i + j] !== pattern[j]) continue outer
    }
    return true
  }
  return false
}

/** Caja ISO-BMFF con tamaño calculado. */
function mp4Box(type: string, payload: Uint8Array): Uint8Array {
  return concat([u32be(8 + payload.length), ascii(type), payload])
}

/** Atom `data` de un item de ilst: versión/flags(4) + locale(4) + valor. */
function mp4DataAtom(value: string): Uint8Array {
  return mp4Box('data', concat([Uint8Array.of(0, 0, 0, 0), u32be(0), ascii(value)]))
}

/** Item de metadata iTunes (©nam, ©xyz…): una sola caja `data`. */
function ilstItem(key: string, value: string): Uint8Array {
  return mp4Box(key, mp4DataAtom(value))
}

/** Re-parsea las cajas de primer nivel (walker propio del test). */
interface TestBox {
  type: string
  start: number
  end: number
  dataStart: number
}

function topBoxes(bytes: Uint8Array): TestBox[] {
  const out: TestBox[] = []
  let i = 0
  while (i + 8 <= bytes.length) {
    const size = readU32BE(bytes, i)
    if (size < 8 || i + size > bytes.length) break
    out.push({ type: asciiAt(bytes, i + 4), start: i, end: i + size, dataStart: i + 8 })
    i += size
  }
  return out
}

/** Hijos de una caja; `skipFlags` salta los 4 bytes de versión/flags (FullBox). */
function childBoxes(bytes: Uint8Array, parent: TestBox, skipFlags = 0): TestBox[] {
  const out: TestBox[] = []
  let i = parent.dataStart + skipFlags
  while (i + 8 <= parent.end) {
    const size = readU32BE(bytes, i)
    if (size < 8 || i + size > parent.end) break
    out.push({ type: asciiAt(bytes, i + 4), start: i, end: i + size, dataStart: i + 8 })
    i += size
  }
  return out
}

/* ── Elementos EBML/Matroska ── */

/** Bytes crudos de los IDs EBML que usa el fixture (formato vint ya válido). */
const ID_BYTES: Record<number, Uint8Array> = {
  0x1a45dfa3: Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3), // EBML header
  0x18538067: Uint8Array.of(0x18, 0x53, 0x80, 0x67), // Segment
  0x1549a966: Uint8Array.of(0x15, 0x49, 0xa9, 0x66), // Info
  0x73a4: Uint8Array.of(0x73, 0xa4), // SegmentUID
  0x2ad7b1: Uint8Array.of(0x2a, 0xd7, 0xb1), // TimestampScale
  0x4d80: Uint8Array.of(0x4d, 0x80), // MuxingApp
  0x5741: Uint8Array.of(0x57, 0x41), // WritingApp
  0x7ba9: Uint8Array.of(0x7b, 0xa9), // Title
  0x1254c367: Uint8Array.of(0x12, 0x54, 0xc3, 0x67), // Tags
  0x1941a469: Uint8Array.of(0x19, 0x41, 0xa4, 0x69), // Attachments
  0x61a7: Uint8Array.of(0x61, 0xa7), // AttachedFile
  0x1f43b675: Uint8Array.of(0x1f, 0x43, 0xb6, 0x75), // Cluster
  0xec: Uint8Array.of(0xec), // Void
  0x4282: Uint8Array.of(0x42, 0x82), // DocType
  0x4287: Uint8Array.of(0x42, 0x87), // DocTypeVersion
  0x4489: Uint8Array.of(0x44, 0x89), // Duration
  0x1654ae6b: Uint8Array.of(0x16, 0x54, 0xae, 0x6b), // Tracks
  0xae: Uint8Array.of(0xae), // TrackEntry
  0x83: Uint8Array.of(0x83), // TrackType
  0x86: Uint8Array.of(0x86), // CodecID
  0xb0: Uint8Array.of(0xb0), // PixelWidth
  0xba: Uint8Array.of(0xba), // PixelHeight
  0xb5: Uint8Array.of(0xb5), // SamplingFrequency
  0x9f: Uint8Array.of(0x9f), // Channels
  0x7373: Uint8Array.of(0x73, 0x73), // Tag
  0x63c0: Uint8Array.of(0x63, 0xc0), // Targets
  0x67c8: Uint8Array.of(0x67, 0xc8), // SimpleTag
  0x45a3: Uint8Array.of(0x45, 0xa3), // TagName
  0x4487: Uint8Array.of(0x44, 0x87), // TagString
  0x4485: Uint8Array.of(0x44, 0x85), // TagBinary
  0x4461: Uint8Array.of(0x44, 0x61), // DateUTC
  0x466e: Uint8Array.of(0x46, 0x6e), // FileName
  0x536e: Uint8Array.of(0x53, 0x6e), // TrackName
  0x22b59c: Uint8Array.of(0x22, 0xb5, 0x9c), // Language
}

/** Elemento EBML: ID (vint) + size (vint) + datos. */
function ebmlEl(id: number, data: Uint8Array): Uint8Array {
  const idBytes = ID_BYTES[id]
  if (!idBytes) throw new Error(`ID EBML no definido: 0x${id.toString(16)}`)
  return concat([idBytes, writeVintSize(data.length), data])
}

/** Entero sin signo big-endian de `length` bytes. */
function uintBE(n: number, length = 4): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = length - 1; i >= 0; i--) {
    out[i] = n & 0xff
    n = Math.floor(n / 256)
  }
  return out
}

/** Float32 / Float64 little-endian (flotantes de Matroska). */
function f32le(n: number): Uint8Array {
  const buf = new ArrayBuffer(4)
  new DataView(buf).setFloat32(0, n, true)
  return new Uint8Array(buf)
}
function f64le(n: number): Uint8Array {
  const buf = new ArrayBuffer(8)
  new DataView(buf).setFloat64(0, n, true)
  return new Uint8Array(buf)
}

/** `tkhd` v0 real: version/flags + 5×uint32 + reserved(8) + 4×uint16 + matrix + WxH 16.16. */
function tkhd(width: number, height: number): Uint8Array {
  const fixed = (n: number): Uint8Array => uintBE(Math.trunc(n * 65536))
  return mp4Box(
    'tkhd',
    concat([
      Uint8Array.of(0, 0, 0, 0), // version 0 + flags
      u32be(0), // creation_time
      u32be(0), // modification_time
      u32be(1), // track_ID
      u32be(0), // reserved
      u32be(90000), // duration
      new Uint8Array(8), // reserved[2]
      new Uint8Array(2), // layer
      new Uint8Array(2), // alternate_group
      new Uint8Array(2), // volume
      new Uint8Array(2), // reserved
      new Uint8Array(36), // matrix
      fixed(width),
      fixed(height),
    ]),
  )
}

/** `trak` con hdlr + stsd reales para el escaneo de formato (códec/resolución). */
function trackWith(handler: string, codec: string, width: number, height: number): Uint8Array {
  return mp4Box(
    'trak',
    concat([
      tkhd(width, height),
      mp4Box(
        'mdia',
        concat([
          mp4Box('hdlr', concat([Uint8Array.of(0, 0, 0, 0), u32be(0), ascii(handler), ascii('appl')])),
          mp4Box(
            'minf',
            mp4Box(
              'stbl',
              mp4Box('stsd', concat([Uint8Array.of(0, 0, 0, 0), u32be(1), mp4Box(codec, ascii('CODECDATA'))])),
            ),
          ),
        ]),
      ),
    ]),
  )
}

/** `mvhd` v0 real: timescale 1000 y duración 90000 → 90 s → "1:30". */
const MVHD = mp4Box(
  'mvhd',
  concat([Uint8Array.of(0, 0, 0, 0), u32be(0), u32be(0), u32be(1000), u32be(90000), new Uint8Array(80)]),
)

/* ── Fixtures ── */

/** mp4 mínimo: ftyp + moov{mvhd + trak vídeo + trak audio + trak crudo + udta} + free + mdat. */
const MP4 = concat([
  mp4Box('ftyp', concat([ascii('isom'), u32be(0), u32be(0)])),
  mp4Box(
    'moov',
    concat([
      MVHD,
      trackWith('vide', 'avc1', 1920, 1080),
      trackWith('soun', 'mp4a', 0, 0),
      mp4Box('trak', ascii('TRACKDATA')),
      mp4Box(
        'udta',
        mp4Box(
          'meta',
          concat([
            Uint8Array.of(0, 0, 0, 0), // versión/flags de la FullBox meta
            mp4Box('ilst', concat([ilstItem('©nam', 'Mi peli'), ilstItem('©xyz', '+31.2304+121.4737/')])),
          ]),
        ),
      ),
    ]),
  ),
  mp4Box('free', ascii('BASURA')),
  mp4Box('mdat', ascii('PIXELESVIDEO')),
])

/** mov mínimo: ftyp + moov{mvhd + udta{©too}} + mdat (sin ilst: cajas QuickTime). */
const MOV = concat([
  mp4Box('ftyp', ascii('qt  ')),
  mp4Box('moov', concat([MVHD, mp4Box('udta', ilstItem('©too', 'HandBrake 1.0'))])),
  mp4Box('mdat', ascii('VIDEOQUICKTIME')),
])

/** mkv mínimo: EBML + Segment{Info{…, Duration, Title} + Tracks + Tags + Attachments + Cluster + Void}. */
const MKV = concat([
  ebmlEl(0x1a45dfa3, concat([ebmlEl(0x4282, ascii('matroska')), ebmlEl(0x4287, Uint8Array.of(2))])),
  ebmlEl(
    0x18538067,
    concat([
      ebmlEl(
        0x1549a966,
        concat([
          ebmlEl(0x73a4, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)), // SegmentUID
          ebmlEl(0x2ad7b1, uintBE(1000000)), // TimestampScale (1 ms)
          ebmlEl(0x4489, f64le(90000)), // Duration: 90000 × 1e6 / 1e9 = 90 s
          ebmlEl(0x4d80, ascii('ffmpeg')), // MuxingApp
          ebmlEl(0x5741, ascii('Lavf60')), // WritingApp
          ebmlEl(0x7ba9, ascii('Mi video')), // Title
        ]),
      ),
      ebmlEl(
        0x1654ae6b,
        concat([
          ebmlEl(
            0xae,
            concat([
              ebmlEl(0x83, Uint8Array.of(1)), // TrackType: vídeo
              ebmlEl(0x86, ascii('V_VP9')), // CodecID
              ebmlEl(0xb0, uintBE(1920, 2)), // PixelWidth
              ebmlEl(0xba, uintBE(1080, 2)), // PixelHeight
            ]),
          ),
          ebmlEl(
            0xae,
            concat([
              ebmlEl(0x83, Uint8Array.of(2)), // TrackType: audio
              ebmlEl(0x86, ascii('A_OPUS')), // CodecID
              ebmlEl(0xb5, f32le(48000)), // SamplingFrequency
              ebmlEl(0x9f, Uint8Array.of(2)), // Channels
            ]),
          ),
        ]),
      ),
      ebmlEl(0x1254c367, ascii('TAGDATA')), // Tags
      ebmlEl(0x1941a469, ebmlEl(0x61a7, ascii('caratula.jpg'))), // Attachments{AttachedFile}
      ebmlEl(0x1f43b675, ascii('MARCADOR')), // Cluster
      ebmlEl(0xec, ascii('BASURA')), // Void
    ]),
  ),
])

/** Chunk RIFF/AVI (pad a par incluido). */
function aviChunk(id: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 === 1 ? Uint8Array.of(0) : new Uint8Array()
  return concat([ascii(id), u32le(data.length), data, pad])
}

function aviList(listType: string, children: Uint8Array[]): Uint8Array {
  return aviChunk('LIST', concat([ascii(listType), concat(children)]))
}

/** MainAVIHeader (56 B): 25 fps, 2500 frames, 1920×1080. */
function mainAviHeader(): Uint8Array {
  return concat([
    u32le(40000), // dwMicroSecPerFrame → 25 fps
    u32le(0), // dwMaxBytesPerSec
    u32le(0), // dwPaddingGranularity
    u32le(0), // dwFlags
    u32le(2500), // dwTotalFrames → 100 s → "1:40"
    u32le(0), // dwInitialFrames
    u32le(2), // dwStreams
    u32le(0), // dwSuggestedBufferSize
    u32le(1920), // dwWidth
    u32le(1080), // dwHeight
    new Uint8Array(16), // dwReserved[4]
  ])
}

/** Stream de vídeo (LIST strl) con fccHandler 'XVID'. */
function aviVideoStream(): Uint8Array {
  return aviList('strl', [aviChunk('strh', concat([ascii('vids'), ascii('XVID'), new Uint8Array(48)]))])
}

/** avi mínimo: RIFF/AVI con LIST hdrl + LIST INFO (INAM/ISFT) + JUNK + movi. */
const AVI = concat([
  ascii('RIFF'),
  u32le(0),
  ascii('AVI '),
  aviList('hdrl', [aviChunk('avih', mainAviHeader()), aviVideoStream()]),
  aviList('INFO', [aviChunk('INAM', ascii('Mi peli')), aviChunk('ISFT', ascii('VirtualDub'))]),
  aviChunk('JUNK', ascii('BASURA')),
  aviList('movi', [aviChunk('00dc', ascii('FRAME1'))]),
])

/** Callback de progreso ficticio para `strip`. */
const noop = (): void => undefined

async function stripVideo(source: Uint8Array, kind: FileKind, config: Record<string, unknown>): Promise<Uint8Array> {
  const mode = config.mode === 'deep' ? 'deep' : 'light'
  const blocks = Array.isArray(config.blocks) ? (config.blocks as string[]) : []
  return videoDomain.strip(source, kind, { mode, blocks }, noop)
}

function expectConsistentSizes(bytes: Uint8Array): void {
  for (const box of topBoxes(bytes)) {
    expect(readU32BE(bytes, box.start)).toBe(box.end - box.start)
  }
}

/* ═══════════════════════════ vint EBML ═══════════════════════════ */

describe('helpers vint EBML', () => {
  it('readVint lee IDs de 1, 2 y 4 bytes', () => {
    expect(readVint(Uint8Array.of(0xec), 0)?.value).toBe(0xec)
    expect(readVint(Uint8Array.of(0x7b, 0xa9), 0)?.value).toBe(0x7ba9)
    expect(readVint(Uint8Array.of(0x18, 0x53, 0x80, 0x67), 0)).toEqual({ length: 4, value: 0x18538067 })
  })

  it('writeVintSize ↔ readVintSize roundtrip', () => {
    for (const n of [0, 1, 127, 128, 300, 16383, 0x1fffff]) {
      const bytes = writeVintSize(n)
      const read = readVintSize(bytes, 0)
      expect(read?.value).toBe(n)
      expect(read?.length).toBe(bytes.length)
    }
  })
})

/* ═══════════════════════════ mp4 / mov ═══════════════════════════ */

describe('videoDomain — mp4', () => {
  it('scan ve Título y GPS (high) dentro del bloque tags, y localiza junk', async () => {
    const report: MetadataReport = await videoDomain.scan(MP4)
    const names = report.fields.map((f) => f.name)
    expect(names).toContain('Título')
    expect(names).toContain('GPS')
    const tags = report.blocks.find((b) => b.id === 'tags')
    expect(tags?.fields.some((f) => f.name === 'GPS' && f.sensitivity === 'high')).toBe(true)
    expect(report.blocks.some((b) => b.id === 'junk')).toBe(true)
  })

  it('scan expone el bloque format (removableIn never) con datos de mvhd/tkhd/stsd', async () => {
    const report = await videoDomain.scan(MP4)
    const fmt = report.blocks.find((b) => b.id === 'format')
    expect(fmt?.removableIn).toBe('never')
    expect(report.fields.find((f) => f.name === 'Duración')?.value).toBe('1:30')
    expect(report.fields.find((f) => f.name === 'Escala de tiempo')?.value).toBe('1000')
    expect(report.fields.find((f) => f.name === 'Resolución')?.value).toBe('1920x1080')
    expect(report.fields.find((f) => f.name === 'Códec de video')?.value).toBe('avc1')
    expect(report.fields.find((f) => f.name === 'Códec de audio')?.value).toBe('mp4a')
  })

  it('los bloques de etiquetas/borrables del mp4 marcados como light', async () => {
    const report = await videoDomain.scan(MP4)
    for (const id of ['tags', 'junk']) {
      expect(report.blocks.find((b) => b.id === id)?.removableIn).toBe('light')
    }
  })

  it('light ["tags"] quita udta y conserva trak, mdat y free', async () => {
    const out = await stripVideo(MP4, 'mp4', { mode: 'light', blocks: ['tags'] })
    const txt = textOf(out)
    expect(txt).not.toContain('udta')
    expect(txt).not.toContain('Mi peli')
    expect(txt).not.toContain('©nam')
    expect(txt).not.toContain('+31.2304')
    expect(txt).toContain('ftyp')
    expect(txt).toContain('TRACKDATA') // trak intacto
    expect(txt).toContain('PIXELESVIDEO') // mdat intacto
    expect(txt).toContain('BASURA') // free: bloque junk no pedido en light

    const boxes = topBoxes(out)
    expect(boxes.map((b) => b.type)).toEqual(['ftyp', 'moov', 'free', 'mdat'])
    const moov = boxes.find((b) => b.type === 'moov')!
    expect(childBoxes(out, moov).map((b) => b.type)).not.toContain('udta')
    expect(childBoxes(out, moov).map((b) => b.type)).toContain('trak')
    expectConsistentSizes(out)
  })

  it('light ["gps"] quita ©xyz y conserva ©nam y la estructura udta/meta/ilst', async () => {
    const out = await stripVideo(MP4, 'mp4', { mode: 'light', blocks: ['gps'] })
    const txt = textOf(out)
    expect(txt).toContain('udta')
    expect(txt).toContain('Mi peli') // ©nam se conserva
    expect(txt).not.toContain('+31.2304') // ©xyz eliminado

    const moov = topBoxes(out).find((b) => b.type === 'moov')!
    const udta = childBoxes(out, moov).find((b) => b.type === 'udta')!
    const meta = childBoxes(out, udta).find((b) => b.type === 'meta')!
    const ilst = childBoxes(out, meta, 4).find((b) => b.type === 'ilst')!
    expect(childBoxes(out, ilst).map((b) => b.type)).toEqual(['©nam'])
    expectConsistentSizes(out)
  })

  it('deep quita udta y free; ftyp/mdat quedan intactos', async () => {
    const out = await stripVideo(MP4, 'mp4', { mode: 'deep', blocks: [] })
    const txt = textOf(out)
    expect(txt).not.toContain('udta')
    expect(txt).not.toContain('free')
    expect(txt).not.toContain('BASURA')
    expect(txt).toContain('ftyp')
    expect(txt).toContain('PIXELESVIDEO')
    expect(txt).toContain('TRACKDATA')
    expect(topBoxes(out).map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat'])
    const moov = topBoxes(out).find((b) => b.type === 'moov')!
    expect(childBoxes(out, moov).map((b) => b.type)).not.toContain('udta')
    expectConsistentSizes(out)
  })

  it('light sin bloques → passthrough de los mismos bytes', async () => {
    const out = await stripVideo(MP4, 'mp4', { mode: 'light', blocks: [] })
    expect(out).toEqual(MP4)
  })
})

describe('videoDomain — mov', () => {
  it('scan reporta Software (©too) cuando no hay ilst', async () => {
    const report = await videoDomain.scan(MOV)
    const fields = report.fields
    expect(fields.some((f) => f.name === 'Software' && f.value === 'HandBrake 1.0')).toBe(true)
    expect(report.blocks.some((b) => b.id === 'tags')).toBe(true)
  })

  it('scan expone el bloque format (removableIn never) con duración del mvhd', async () => {
    const report = await videoDomain.scan(MOV)
    const fmt = report.blocks.find((b) => b.id === 'format')
    expect(fmt?.removableIn).toBe('never')
    expect(report.fields.find((f) => f.name === 'Duración')?.value).toBe('1:30')
    expect(report.fields.find((f) => f.name === 'Escala de tiempo')?.value).toBe('1000')
  })

  it('light ["tags"] quita la udta con ©too y conserva mdat', async () => {
    const out = await stripVideo(MOV, 'mov', { mode: 'light', blocks: ['tags'] })
    const txt = textOf(out)
    expect(txt).not.toContain('udta')
    expect(txt).not.toContain('HandBrake')
    expect(txt).toContain('VIDEOQUICKTIME')
    expect(topBoxes(out).map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat'])
    expectConsistentSizes(out)
  })
})

/* ═══════════════════════════ mkv / webm ═══════════════════════════ */

describe('videoDomain — mkv', () => {
  it('scan ve Título, "1 adjuntos" y el bloque junk', async () => {
    const report = await videoDomain.scan(MKV)
    expect(report.fields.some((f) => f.name === 'Título' && f.value === 'Mi video')).toBe(true)
    const attach = report.blocks.find((b) => b.id === 'attach')
    expect(attach?.fields[0]?.value).toBe('1 adjuntos')
    expect(report.blocks.some((b) => b.id === 'junk')).toBe(true)
  })

  it('scan expone el bloque format (removableIn never): duración y pistas', async () => {
    const report = await videoDomain.scan(MKV)
    const fmt = report.blocks.find((b) => b.id === 'format')
    expect(fmt?.removableIn).toBe('never')
    expect(report.fields.find((f) => f.name === 'Duración')?.value).toBe('1:30')
    expect(report.fields.find((f) => f.name === 'Escala de tiempo')?.value).toBe('1000000 ns')
    const video = report.fields.find((f) => f.name === 'Pista 1')
    expect(video?.value).toContain('vídeo')
    expect(video?.value).toContain('V_VP9')
    expect(video?.value).toContain('1920x1080')
    const audio = report.fields.find((f) => f.name === 'Pista 2')
    expect(audio?.value).toContain('A_OPUS')
    expect(audio?.value).toContain('48000 Hz')
    expect(audio?.value).toContain('2 canales')
  })

  it('los bloques de etiquetas/borrables del mkv marcados como light', async () => {
    const report = await videoDomain.scan(MKV)
    for (const id of ['tags', 'attach', 'junk']) {
      expect(report.blocks.find((b) => b.id === id)?.removableIn).toBe('light')
    }
  })

  it('light ["tags"] quita Tags y Title; conserva SegmentUID/MuxingApp y Cluster', async () => {
    const out = await stripVideo(MKV, 'mkv', { mode: 'light', blocks: ['tags'] })
    const txt = textOf(out)
    expect(txt).not.toContain('TAGDATA') // Tags eliminado
    expect(txt).not.toContain('Mi video') // Title eliminado
    expect(txt).toContain('ffmpeg') // MuxingApp conservado
    expect(txt).toContain('Lavf60') // WritingApp conservado
    expect(txt).toContain('MARCADOR') // Cluster intacto
    expect(txt).toContain('caratula.jpg') // Attachments no seleccionado
    expect(txt).toContain('BASURA') // Void no seleccionado
    expect(containsBytes(out, Uint8Array.of(0x73, 0xa4))).toBe(true) // SegmentUID
    expect(containsBytes(out, Uint8Array.of(0x2a, 0xd7, 0xb1))).toBe(true) // TimestampScale
  })

  it('light ["attach"] quita Attachments y conserva Tags/Title', async () => {
    const out = await stripVideo(MKV, 'webm', { mode: 'light', blocks: ['attach'] })
    const txt = textOf(out)
    expect(txt).not.toContain('caratula.jpg')
    expect(txt).toContain('TAGDATA') // Tags conservado
    expect(txt).toContain('Mi video') // Title conservado
  })

  it('deep quita Tags, Title, Attachments, Void y timestamps; conserva Info y Cluster', async () => {
    const out = await stripVideo(MKV, 'mkv', { mode: 'deep', blocks: [] })
    const txt = textOf(out)
    expect(txt).not.toContain('TAGDATA')
    expect(txt).not.toContain('Mi video')
    expect(txt).not.toContain('caratula.jpg')
    expect(txt).not.toContain('BASURA') // Void eliminado
    expect(txt).not.toContain('ffmpeg') // MuxingApp sustituido por Void en deep
    expect(txt).not.toContain('Lavf60') // WritingApp sustituido por Void en deep
    expect(txt).toContain('MARCADOR') // Cluster intacto
    expect(containsBytes(out, Uint8Array.of(0x73, 0xa4))).toBe(true) // SegmentUID conservado
    expect(containsBytes(out, Uint8Array.of(0x12, 0x54, 0xc3, 0x67))).toBe(false) // Tags fuera
  })
})

/* ═══════════════════════════ avi ═══════════════════════════ */

describe('videoDomain — avi', () => {
  it('scan ve Título y Software del LIST INFO', async () => {
    const report = await videoDomain.scan(AVI)
    const names = report.fields.map((f) => f.name)
    expect(names).toContain('Título')
    expect(names).toContain('Software')
    expect(report.blocks.some((b) => b.id === 'info')).toBe(true)
    expect(report.blocks.some((b) => b.id === 'junk')).toBe(true)
  })

  it('scan expone el bloque format (removableIn never): FPS, resolución, duración y códec', async () => {
    const report = await videoDomain.scan(AVI)
    const fmt = report.blocks.find((b) => b.id === 'format')
    expect(fmt?.removableIn).toBe('never')
    expect(report.fields.find((f) => f.name === 'FPS')?.value).toBe('25')
    expect(report.fields.find((f) => f.name === 'Resolución')?.value).toBe('1920x1080')
    expect(report.fields.find((f) => f.name === 'Duración')?.value).toBe('1:40')
    expect(report.fields.find((f) => f.name === 'Códec')?.value).toBe('XVID')
    expect(report.blocks.find((b) => b.id === 'info')?.removableIn).toBe('light')
    expect(report.blocks.find((b) => b.id === 'junk')?.removableIn).toBe('light')
  })

  it('light ["info"] quita LIST INFO y conserva hdrl/movi (y JUNK)', async () => {
    const out = await stripVideo(AVI, 'avi', { mode: 'light', blocks: ['info'] })
    const txt = textOf(out)
    expect(txt).not.toContain('INAM')
    expect(txt).not.toContain('Mi peli')
    expect(txt).not.toContain('VirtualDub')
    expect(txt).toContain('hdrl')
    expect(txt).toContain('avih')
    expect(txt).toContain('movi')
    expect(txt).toContain('FRAME1')
    expect(txt).toContain('BASURA') // JUNK no seleccionado en light
    // tamaño RIFF re-escrito y consistente
    expect(textOf(out.slice(0, 4))).toBe('RIFF')
    expect(textOf(out.slice(8, 12))).toBe('AVI ')
    expect(out.length - 8).toBe(readLE(out, 4))
  })

  it('deep quita LIST INFO y JUNK; hdrl/movi intactos', async () => {
    const out = await stripVideo(AVI, 'avi', { mode: 'deep', blocks: [] })
    const txt = textOf(out)
    expect(txt).not.toContain('Mi peli')
    expect(txt).not.toContain('BASURA')
    expect(txt).toContain('hdrl')
    expect(txt).toContain('avih')
    expect(txt).toContain('FRAME1')
    expect(out.length - 8).toBe(readLE(out, 4))
  })
})

function readLE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  )
}

/* ═══════════════════════════ guardas y engine ═══════════════════════════ */

describe('guardas defensivas', () => {
  it('scan de bytes basura → EMPTY_REPORT (no lanza)', async () => {
    const report = await videoDomain.scan(Uint8Array.of(1, 2, 3, 4, 5))
    expect(report).toEqual({ fields: [], count: 0, blocks: [], entries: [] })
  })

  it('strip light vacío → passthrough exacto', async () => {
    const source = MP4
    const out = await stripVideo(source, 'mp4', { mode: 'light', blocks: [] })
    expect(out).toEqual(source)
  })
})

describe('integración con el engine', () => {
  it('stripMetadata mp4 light ["tags"] → kind mp4, "-limpio.mp4" y sin udta', async () => {
    const result = await stripMetadata({
      bytes: MP4,
      name: 'eli.mp4',
      kind: 'mp4',
      config: { mode: 'light', blocks: ['tags'] },
    })
    expect(result.kind).toBe('mp4')
    expect(result.name).toBe('eli-limpio.mp4')
    const out = new Uint8Array(await result.blob.arrayBuffer())
    expect(textOf(out)).not.toContain('udta')
    expect(textOf(out)).not.toContain('Mi peli')
    expect(textOf(out)).toContain('PIXELESVIDEO') // mdat intacto
    expectConsistentSizes(out)
  })
})

/** mp4 con metadata en `moov>meta` DIRECTO (estilo móvil Android: ©too, ©mod, ©xyz). */
const MP4_MOOV_META = concat([
  mp4Box('ftyp', ascii('isom')),
  mp4Box(
    'moov',
    concat([
      mp4Box('mvhd', concat([Uint8Array.of(0, 0, 0, 0), u32be(0), u32be(0), u32be(1000), u32be(90000)])),
      mp4Box(
        'meta',
        concat([
          new Uint8Array(4), // FullBox flags
          mp4Box(
            'ilst',
            concat([
              ilstItem('©too', 'Android 13'),
              ilstItem('©mod', 'Galaxy A34'),
              ilstItem('©xyz', '+31.2304+121.4737/'),
            ]),
          ),
        ]),
      ),
    ]),
  ),
  mp4Box('mdat', ascii('VIDEODATA')),
])

/** Bytes de un UUID de 16 bytes a partir de su hex canónico. */
function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** mp4 con timestamps reales (mvhd/tkhd) + ilst desconocido + caja uuid XMP. */
const MP4_INVENTORY = concat([
  mp4Box('ftyp', concat([ascii('isom'), u32be(0)])),
  mp4Box(
    'moov',
    concat([
      mp4Box(
        'mvhd',
        concat([Uint8Array.of(0, 0, 0, 0), u32be(3600), u32be(7200), u32be(1000), u32be(90000), new Uint8Array(80)]),
      ),
      trackWith('vide', 'avc1', 640, 480),
      mp4Box(
        'udta',
        mp4Box(
          'meta',
          concat([
            Uint8Array.of(0, 0, 0, 0),
            mp4Box('ilst', concat([ilstItem('©nam', 'N'), ilstItem('----', 'X')])),
          ]),
        ),
      ),
    ]),
  ),
  mp4Box('uuid', concat([hexBytes('be7acfcb97a942e89c71999491e3afac'), ascii('XMPDATA')])),
  mp4Box('mdat', ascii('VIDEO')),
])

/** mkv con Tags>Tag>SimpleTag reales, Info completa, Attachments con FileName y Tracks. */
const MKV_TAGS = concat([
  ebmlEl(0x1a45dfa3, ebmlEl(0x4282, ascii('matroska'))),
  ebmlEl(
    0x18538067,
    concat([
      ebmlEl(
        0x1549a966,
        concat([
          ebmlEl(0x73a4, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)), // SegmentUID
          ebmlEl(0x2ad7b1, uintBE(1000000)), // TimestampScale
          ebmlEl(0x4489, f64le(90000)), // Duration
          ebmlEl(0x4461, new Uint8Array(8)), // DateUTC
          ebmlEl(0x4d80, ascii('ffmpeg')), // MuxingApp
          ebmlEl(0x5741, ascii('Lavf60')), // WritingApp
          ebmlEl(0x7ba9, utf8('Título real')), // Title
        ]),
      ),
      ebmlEl(
        0x1654ae6b,
        ebmlEl(
          0xae,
          concat([
            ebmlEl(0x83, Uint8Array.of(1)),
            ebmlEl(0x86, ascii('V_VP9')),
            ebmlEl(0x536e, ascii('Pista principal')),
            ebmlEl(0x22b59c, ascii('spa')),
          ]),
        ),
      ),
      ebmlEl(
        0x1254c367,
        ebmlEl(
          0x7373,
          concat([
            ebmlEl(0x63c0, new Uint8Array()),
            ebmlEl(0x67c8, concat([ebmlEl(0x45a3, ascii('TITLE')), ebmlEl(0x4487, utf8('Mi título'))])),
            ebmlEl(0x67c8, concat([ebmlEl(0x45a3, ascii('COMMENT')), ebmlEl(0x4487, ascii('Hola mundo'))])),
          ]),
        ),
      ),
      ebmlEl(0x1941a469, ebmlEl(0x61a7, ebmlEl(0x466e, ascii('caratula.jpg')))), // Attachments
    ]),
  ),
])

/** mp4 más simple: ftyp + moov{…} + mdat con metadata en `moov>meta` → strip tags. */
describe('videoDomain — mp4 metadata móvil (moov/meta)', () => {
  it('scan ve etiquetas/software + GPS + claves crudas dentro del bloque tags', async () => {
    const report = await videoDomain.scan(MP4_MOOV_META)
    const tags = report.blocks.find((b) => b.id === 'tags')
    expect(tags).toBeDefined()
    expect(report.fields.some((f) => f.name === 'Software' && f.value === 'Android 13')).toBe(true)
    expect(tags?.fields.some((f) => f.name === 'GPS' && f.sensitivity === 'high')).toBe(true)
    expect(tags?.fields.some((f) => f.name === '©mod' && f.value === 'Galaxy A34')).toBe(true)
    expect(report.blocks.some((b) => b.id === 'format' && b.removableIn === 'never')).toBe(true)
  })

  it('light ["tags"] elimina moov/meta entera y conserva muov/mvhd + mdat', async () => {
    const out = await stripVideo(MP4_MOOV_META, 'mp4', { mode: 'light', blocks: ['tags'] })
    const txt = textOf(out)
    expect(txt).not.toContain('Android 13')
    expect(txt).not.toContain('©mod')
    expect(txt).not.toContain('+31.2304')
    expect(txt).toContain('mvhd')
    expect(txt).toContain('VIDEODATA') // mdat intacto
    expectConsistentSizes(out)
  })
})

/* ════════════ Regresión: remux ISO-BMFF (stco/co64) ════════════ */

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

/** stco (FullBox): versión/flags(4) + count(4) + entradas de 4 bytes. */
function stcoBox(entries: number[]): Uint8Array {
  return mp4Box('stco', concat([Uint8Array.of(0, 0, 0, 0), u32be(entries.length), concat(entries.map(u32be))]))
}

/** mp4 con stco real (trak>mdia>minf>stbl) apuntando dentro de un mdat grande. */
const MP4_STCO = concat([
  mp4Box('ftyp', concat([ascii('isom'), u32be(0), u32be(0)])),
  mp4Box(
    'moov',
    concat([
      mp4Box('mvhd', ascii('HHHH')),
      mp4Box(
        'trak',
        mp4Box(
          'mdia',
          mp4Box('minf', mp4Box('stbl', concat([mp4Box('stsz', ascii('SSSS')), stcoBox([120, 250])]))),
        ),
      ),
      mp4Box('udta', mp4Box('meta', concat([Uint8Array.of(0, 0, 0, 0), mp4Box('ilst', ilstItem('©nam', 'Mi peli'))]))),
    ]),
  ),
  mp4Box('mdat', concat([ascii('PAYLOAD'), new Uint8Array(380)])),
])

/** Lee las entradas de la primera caja `stco` (búsqueda recursiva). */
function readStcoEntries(bytes: Uint8Array): number[] {
  const findRec = (start: number, end: number): number | null => {
    let i = start
    while (i + 8 <= end) {
      const size = readU32BE(bytes, i)
      if (size === 0) break // región no parseable (FullBox con flags cero)
      if (asciiAt(bytes, i + 4) === 'stco') return i
      if (size >= 8 && i + size <= end) {
        const found = findRec(i + 8, i + size)
        if (found !== null) return found
      }
      i += size
    }
    return null
  }
  const off = findRec(0, bytes.length)
  if (off === null) return []
  const count = readU32BE(bytes, off + 12)
  const out: number[] = []
  for (let n = 0; n < count; n++) out.push(readU32BE(bytes, off + 16 + n * 4))
  return out
}

describe('videoDomain — remux ISO-BMFF (stco)', () => {
  it('light ["tags"]: moov encogido → stco re-escrito por el delta de mdat', async () => {
    const src = MP4_STCO
    const mdatOld = indexOfBytes(src, ascii('mdat'))
    expect(mdatOld).toBeGreaterThan(0)
    const before = readStcoEntries(src)
    expect(before).toEqual([120, 250])

    const out = await stripVideo(src, 'mp4', { mode: 'light', blocks: ['tags'] })
    const mdatNew = indexOfBytes(out, ascii('mdat'))
    const delta = mdatNew - mdatOld
    expect(delta).toBeLessThan(0) // moov se encogió → mdat se movió antes

    const after = readStcoEntries(out)
    expect(after[0]).toBe(before[0] + delta)
    expect(after[1]).toBe(before[1] + delta)
    // mdat (contenido) intacto y el resultado re-parsea como cajas consistentes.
    expect(indexOfBytes(out, ascii('PAYLOAD'))).toBeGreaterThan(0)
    expectConsistentSizes(out)
  })

  it('deep: mismo remux con junk eliminado (sigue quedando consistente)', async () => {
    const src = concat([MP4_STCO, mp4Box('free', ascii('BASURA'))])
    const out = await stripVideo(src, 'mp4', { mode: 'deep', blocks: [] })
    expect(indexOfBytes(out, ascii('BASURA'))).toBe(-1)
    expect(indexOfBytes(out, ascii('PAYLOAD'))).toBeGreaterThan(0)
  })
})

/* ════════════ Regresión: mkv con filler Void (layout intacto) ════════════ */

describe('videoDomain — mkv layout (filler Void)', () => {
  it('light ["tags"]: Tags/Title a ceros, pero posiciones byte a byte intactas', async () => {
    const src = MKV
    const out = await stripVideo(src, 'mkv', { mode: 'light', blocks: ['tags'] })
    expect(out.length).toBe(src.length)
    expect(indexOfBytes(out, ascii('MARCADOR'))).toBe(indexOfBytes(src, ascii('MARCADOR')))
    expect(indexOfBytes(out, ascii('ffmpeg'))).toBe(indexOfBytes(src, ascii('ffmpeg')))
    expect(indexOfBytes(out, ascii('Mi video'))).toBe(-1)
    expect(indexOfBytes(out, ascii('TAGDATA'))).toBe(-1)
  })

  it('deep: adjuntos/void a ceros, Cluster en el mismo sitio', async () => {
    const src = MKV
    const out = await stripVideo(src, 'mkv', { mode: 'deep', blocks: [] })
    expect(out.length).toBe(src.length)
    expect(indexOfBytes(out, ascii('MARCADOR'))).toBe(indexOfBytes(src, ascii('MARCADOR')))
    expect(indexOfBytes(out, ascii('caratula.jpg'))).toBe(-1)
    expect(indexOfBytes(out, ascii('BASURA'))).toBe(-1)
    expect(indexOfBytes(out, ascii('ffmpeg'))).toBe(-1) // MuxingApp sustituido por Void en deep
  })
})

/* ════════════ Inventario exhaustivo (entries) ════════════ */

describe('videoDomain — inventario mp4 (entries)', () => {
  it('incluye items de ilst desconocidos con su clave cruda', async () => {
    const report = await videoDomain.scan(MP4_INVENTORY)
    const keys = report.entries.map((e) => e.key)
    expect(keys).toContain('©nam')
    expect(keys).toContain('----')
    const unknown = report.entries.find((e) => e.key === '----')
    expect(unknown?.where).toContain('moov > udta > meta > ilst')
  })

  it('expone creation/modification de mvhd y tkhd como entradas visibles', async () => {
    const report = await videoDomain.scan(MP4_INVENTORY)
    expect(report.entries.some((e) => e.where.includes('mvhd') && e.key === 'creation_time')).toBe(true)
    expect(report.entries.some((e) => e.where.includes('tkhd') && e.key === 'creation_time')).toBe(true)
    expect(report.entries.some((e) => e.key === 'modification_time')).toBe(true)
    const mvhd = report.entries.find((e) => e.where.includes('mvhd') && e.key === 'creation_time')
    // Antes decía 'never' (fuga: el inventario prometía conservar lo que el
    // limpiador ya puede poner a cero con el bloque 'timestamps').
    expect(mvhd?.removal).toBe('individual')
  })

  it('clasifica las cajas uuid (XMP) por su identificador', async () => {
    const report = await videoDomain.scan(MP4_INVENTORY)
    const xmp = report.entries.find((e) => e.label === 'XMP')
    expect(xmp).toBeDefined()
    expect(xmp?.key).toBe('uuid')
  })

  it('toda entrada lleva `where` no vacío', async () => {
    const report = await videoDomain.scan(MP4_INVENTORY)
    expect(report.entries.length).toBeGreaterThan(0)
    expect(report.entries.every((e) => e.where.trim().length > 0)).toBe(true)
  })
})

describe('videoDomain — inventario mkv (entries)', () => {
  it('lee Tags > Tag > SimpleTag con nombre Y valor (no solo "Presentes")', async () => {
    const report = await videoDomain.scan(MKV_TAGS)
    const title = report.entries.find((e) => e.key === 'TITLE')
    expect(title?.value).toBe('Mi título')
    expect(title?.where).toContain('SimpleTag')
    expect(report.entries.find((e) => e.key === 'COMMENT')?.value).toBe('Hola mundo')
  })

  it('incluye Info (Title/DateUTC/MuxingApp/WritingApp/SegmentUID) y Name/Language/CodecID de pista', async () => {
    const report = await videoDomain.scan(MKV_TAGS)
    const keys = report.entries.map((e) => e.key)
    for (const key of ['Title', 'DateUTC', 'MuxingApp', 'WritingApp', 'SegmentUID', 'Name', 'Language', 'CodecID']) {
      expect(keys).toContain(key)
    }
  })

  it('muestra el FileName de los adjuntos', async () => {
    const report = await videoDomain.scan(MKV_TAGS)
    const file = report.entries.find((e) => e.key === 'FileName')
    expect(file?.value).toBe('caratula.jpg')
    expect(file?.where).toContain('Attachments')
  })

  it('toda entrada lleva `where` no vacío', async () => {
    const report = await videoDomain.scan(MKV_TAGS)
    expect(report.entries.length).toBeGreaterThan(0)
    expect(report.entries.every((e) => e.where.trim().length > 0)).toBe(true)
  })
})

describe('videoDomain — inventario avi (entries)', () => {
  it('enumera sub-chunks INFO no mapeados y JUNK/PAD/IDIT', async () => {
    const src = concat([
      ascii('RIFF'),
      u32le(0),
      ascii('AVI '),
      aviList('INFO', [aviChunk('INAM', ascii('Mi peli')), aviChunk('ISBJ', ascii('Materia'))]),
      aviChunk('JUNK', ascii('BASURA')),
      aviChunk('IDIT', ascii('2024-01-01')),
      aviList('movi', [aviChunk('00dc', ascii('FRAME1'))]),
    ])
    const report = await videoDomain.scan(src)
    const keys = report.entries.map((e) => e.key)
    expect(keys).toContain('ISBJ')
    expect(keys).toContain('JUNK')
    expect(keys).toContain('IDIT')
    expect(report.entries.every((e) => e.where.trim().length > 0)).toBe(true)
  })
})

/* ════════════ Fuga IDIT de AVI (fecha de digitalización) ════════════ */

/** avi con IDIT de NIVEL SUPERIOR (fecha de digitalización) junto a LIST INFO y JUNK. */
const AVI_IDIT = concat([
  ascii('RIFF'),
  u32le(0),
  ascii('AVI '),
  aviList('hdrl', [aviChunk('avih', mainAviHeader()), aviVideoStream()]),
  aviList('INFO', [aviChunk('INAM', ascii('Mi peli'))]),
  aviChunk('IDIT', ascii('2024-01-01')),
  aviChunk('JUNK', ascii('BASURA')),
  aviList('movi', [aviChunk('00dc', ascii('FRAME1'))]),
])

/** avi cuyo IDIT vive DENTRO del LIST INFO (se borra con su contenedor). */
const AVI_IDIT_IN_INFO = concat([
  ascii('RIFF'),
  u32le(0),
  ascii('AVI '),
  aviList('hdrl', [aviChunk('avih', mainAviHeader()), aviVideoStream()]),
  aviList('INFO', [aviChunk('INAM', ascii('Mi peli')), aviChunk('IDIT', ascii('2024-01-01'))]),
  aviList('movi', [aviChunk('00dc', ascii('FRAME1'))]),
])

describe('videoDomain — fuga IDIT de AVI', () => {
  it('scan reporta el IDIT de nivel superior en el bloque info (sin contradecir el inventario)', async () => {
    const report = await videoDomain.scan(AVI_IDIT)
    const info = report.blocks.find((b) => b.id === 'info')
    expect(info?.fields.some((f) => f.name === 'Fecha de digitalización' && f.value === '2024-01-01')).toBe(true)
    expect(info?.removableIn).toBe('light')
  })

  it('el inventario marca el IDIT de nivel superior como individual (ya no never)', async () => {
    const report = await videoDomain.scan(AVI_IDIT)
    const idit = report.entries.find((e) => e.key === 'IDIT')
    expect(idit).toBeDefined()
    expect(idit?.removal).toBe('individual')
    expect(idit?.sensitivity).toBe('medium')
    expect(idit?.where).toBe('RIFF > IDIT')
  })

  it('light ["info"] quita el IDIT de nivel superior y el RIFF sigue válido', async () => {
    const out = await stripVideo(AVI_IDIT, 'avi', { mode: 'light', blocks: ['info'] })
    const txt = textOf(out)
    expect(txt).not.toContain('IDIT')
    expect(txt).not.toContain('2024-01-01')
    expect(txt).not.toContain('INAM') // LIST INFO también fuera
    expect(txt).toContain('hdrl')
    expect(txt).toContain('movi')
    expect(txt).toContain('FRAME1')
    expect(txt).toContain('BASURA') // JUNK no seleccionado en light
    // cabecera y tamaño RIFF coherentes
    expect(textOf(out.slice(0, 4))).toBe('RIFF')
    expect(textOf(out.slice(8, 12))).toBe('AVI ')
    expect(out.length - 8).toBe(readLE(out, 4))
  })

  it('light sin ["info"] conserva el IDIT de nivel superior', async () => {
    const out = await stripVideo(AVI_IDIT, 'avi', { mode: 'light', blocks: ['junk'] })
    expect(textOf(out)).toContain('2024-01-01')
    expect(out.length - 8).toBe(readLE(out, 4))
  })

  it('deep quita el IDIT de nivel superior con el bloque info', async () => {
    const out = await stripVideo(AVI_IDIT, 'avi', { mode: 'deep', blocks: [] })
    expect(textOf(out)).not.toContain('2024-01-01')
    expect(out.length - 8).toBe(readLE(out, 4))
  })

  it('un IDIT dentro de LIST INFO se borra con el contenedor (comportamiento intacto)', async () => {
    const report = await videoDomain.scan(AVI_IDIT_IN_INFO)
    expect(report.entries.find((e) => e.key === 'IDIT')?.removal).toBe('with-container')
    const out = await stripVideo(AVI_IDIT_IN_INFO, 'avi', { mode: 'light', blocks: ['info'] })
    expect(textOf(out)).not.toContain('2024-01-01')
    expect(out.length - 8).toBe(readLE(out, 4))
  })

  it('un AVI sin IDIT no cambia de comportamiento', async () => {
    const out = await stripVideo(AVI, 'avi', { mode: 'light', blocks: ['info'] })
    expect(textOf(out)).not.toContain('Mi peli') // LIST INFO fuera
    expect(textOf(out)).toContain('BASURA') // JUNK conservado
    expect(out.length - 8).toBe(readLE(out, 4))
  })

  it('un IDIT de nivel superior SIN valor no aparece ni en el bloque ni en el inventario (F5)', async () => {
    const src = concat([
      ascii('RIFF'),
      u32le(0),
      ascii('AVI '),
      aviList('hdrl', [aviChunk('avih', mainAviHeader()), aviVideoStream()]),
      aviChunk('IDIT', new Uint8Array()),
      aviList('movi', [aviChunk('00dc', ascii('FRAME1'))]),
    ])
    const report = await videoDomain.scan(src)
    expect(report.entries.some((e) => e.key === 'IDIT')).toBe(false)
    expect(report.blocks.find((b) => b.id === 'info')).toBeUndefined()
  })

  it('el bloque info de AVI se etiqueta incluyendo el IDIT (F6)', async () => {
    const report = await videoDomain.scan(AVI_IDIT)
    expect(report.blocks.find((b) => b.id === 'info')?.label).toBe('Información (LIST INFO/IDIT)')
  })
})

/* ════════════ Inventario uuid (C2PA), GPS y moov anidado ════════════ */

/** mp4 con `uuid` C2PA de nivel superior y otro `uuid` hijo DIRECTO de `moov`. */
const MP4_UUID_C2PA_MOOV = concat([
  mp4Box('ftyp', concat([ascii('isom'), u32be(0)])),
  mp4Box(
    'moov',
    concat([MVHD, mp4Box('uuid', concat([hexBytes('d8fec3d61b0e483c92975828877c0c85'), ascii('C2PADATA')]))]),
  ),
  mp4Box('uuid', concat([hexBytes('d8fec3d61b0e483c92975828877c0c85'), ascii('C2PATOP')])),
  mp4Box('mdat', ascii('VIDEO')),
])

describe('videoDomain — inventario uuid (C2PA) y GPS', () => {
  it('clasifica una caja uuid C2PA por su identificador', async () => {
    const report = await videoDomain.scan(MP4_UUID_C2PA_MOOV)
    const c2pa = report.entries.find((e) => e.label === 'C2PA')
    expect(c2pa).toBeDefined()
    expect(c2pa?.key).toBe('uuid')
    expect(c2pa?.where).toBe('uuid')
  })

  it('enumera el uuid hijo directo de moov como `moov > uuid`', async () => {
    const report = await videoDomain.scan(MP4_UUID_C2PA_MOOV)
    const inMoov = report.entries.find((e) => e.where === 'moov > uuid')
    expect(inMoov).toBeDefined()
    expect(inMoov?.label).toBe('C2PA')
  })

  it('el uuid C2PA se borra con el bloque c2pa (no con junk), así que debe verse en el inventario', async () => {
    // Antes el C2PA caía en 'junk' (fuga): ahora tiene su propio bloque 'c2pa'.
    const out = await stripVideo(MP4_UUID_C2PA_MOOV, 'mp4', { mode: 'light', blocks: ['c2pa'] })
    expect(textOf(out)).not.toContain('C2PADATA') // uuid dentro de moov eliminado
    expect(textOf(out)).not.toContain('C2PATOP') // uuid de nivel superior eliminado
  })

  it('marca el GPS como with-container (se borra con su contenedor, no suelto)', async () => {
    const report = await videoDomain.scan(MP4)
    const gps = report.entries.find((e) => e.key === '©xyz')
    expect(gps?.label).toBe('GPS')
    expect(gps?.removal).toBe('with-container')
  })
})

/* ════════════ Fugas de video: 'timestamps' y 'c2pa' ════════════ */

/** Busca recursivamente la primera caja `type` (recorre contenedores). */
function findBox(bytes: Uint8Array, type: string): TestBox | null {
  const find = (start: number, end: number): TestBox | null => {
    let i = start
    while (i + 8 <= end) {
      const size = readU32BE(bytes, i)
      if (size < 8 || i + size > end) return null
      const t = asciiAt(bytes, i + 4)
      if (t === type) return { type: t, start: i, end: i + size, dataStart: i + 8 }
      const nested = find(i + 8, i + size)
      if (nested) return nested
      i += size
    }
    return null
  }
  return find(0, bytes.length)
}

/** creation_time/modification_time de una FullBox mvhd/tkhd/mdhd (v0 4B / v1 8B). */
function readBoxTimes(bytes: Uint8Array, type: string): { creation: number; modification: number } | null {
  const box = findBox(bytes, type)
  if (!box) return null
  const d = box.dataStart
  const version = bytes[d]
  if (version === 0) return { creation: readU32BE(bytes, d + 4), modification: readU32BE(bytes, d + 8) }
  if (version === 1) {
    return {
      creation: readU32BE(bytes, d + 4) * 2 ** 32 + readU32BE(bytes, d + 8),
      modification: readU32BE(bytes, d + 12) * 2 ** 32 + readU32BE(bytes, d + 16),
    }
  }
  return null
}

const UUID_C2PA_HEX = 'd8fec3d61b0e483c92975828877c0c85'
const UUID_XMP_HEX = 'be7acfcb97a942e89c71999491e3afac'
const UUID_UNKNOWN_HEX = '00112233445566778899aabbccddeeff'

/** mp4 con mvhd v0, tkhd v0 y mdhd v1 con fechas reales (duración 90 s). */
const MP4_TIMES = concat([
  mp4Box('ftyp', concat([ascii('isom'), u32be(0)])),
  mp4Box(
    'moov',
    concat([
      mp4Box(
        'mvhd',
        concat([Uint8Array.of(0, 0, 0, 0), u32be(3600), u32be(7200), u32be(1000), u32be(90000), new Uint8Array(80)]),
      ),
      mp4Box(
        'trak',
        concat([
          mp4Box(
            'tkhd',
            concat([
              Uint8Array.of(0, 0, 0, 0),
              u32be(3600), // creation_time
              u32be(7200), // modification_time
              u32be(1), // track_ID
              u32be(0), // reserved
              u32be(90000), // duration
              new Uint8Array(8), // reserved[2]
              new Uint8Array(2), // layer
              new Uint8Array(2), // alternate_group
              new Uint8Array(2), // volume
              new Uint8Array(2), // reserved
              new Uint8Array(36), // matrix
              u32be(640 * 65536), // width 16.16
              u32be(480 * 65536), // height 16.16
            ]),
          ),
          mp4Box(
            'mdia',
            concat([
              mp4Box(
                'mdhd',
                concat([
                  Uint8Array.of(1, 0, 0, 0), // version 1 + flags
                  u32be(0), u32be(3600), // creation_time (8B)
                  u32be(0), u32be(7200), // modification_time (8B)
                  u32be(90000), // timescale
                  u32be(0), u32be(90000), // duration (8B)
                  new Uint8Array(4), // language + predefined
                ]),
              ),
            ]),
          ),
        ]),
      ),
    ]),
  ),
  mp4Box('mdat', ascii('VIDEO')),
])

/** mkv con Info{DateUTC, MuxingApp, WritingApp} reales y un Cluster marcador. */
const MKV_TIMES = concat([
  ebmlEl(0x1a45dfa3, ebmlEl(0x4282, ascii('matroska'))),
  ebmlEl(
    0x18538067,
    concat([
      ebmlEl(
        0x1549a966,
        concat([
          ebmlEl(0x2ad7b1, uintBE(1000000)), // TimestampScale
          ebmlEl(0x4489, f64le(90000)), // Duration → 90 s
          ebmlEl(0x4461, uintBE(123456789, 8)), // DateUTC (8 bytes)
          ebmlEl(0x4d80, ascii('ffmpeg')), // MuxingApp
          ebmlEl(0x5741, ascii('Lavf60')), // WritingApp
        ]),
      ),
      ebmlEl(0x1f43b675, ascii('MARCADOR')), // Cluster
    ]),
  ),
])

/** mp4 con uuid C2PA (top-level y en moov), uuid XMP y uuid desconocido. */
const MP4_UUID_ALL = concat([
  mp4Box('ftyp', concat([ascii('isom'), u32be(0)])),
  mp4Box('moov', concat([MVHD, mp4Box('uuid', concat([hexBytes(UUID_C2PA_HEX), ascii('C2PAMOOV')]))])),
  mp4Box('uuid', concat([hexBytes(UUID_C2PA_HEX), ascii('C2PATOP')])),
  mp4Box('uuid', concat([hexBytes(UUID_XMP_HEX), ascii('XMPDATA')])),
  mp4Box('uuid', concat([hexBytes(UUID_UNKNOWN_HEX), ascii('UNKNOWNDATA')])),
  mp4Box('mdat', ascii('VIDEO')),
])

describe('videoDomain — fuga timestamps (mp4/mov)', () => {
  it('scan expone el bloque timestamps (light) con las fechas reales', async () => {
    const report = await videoDomain.scan(MP4_TIMES)
    const ts = report.blocks.find((b) => b.id === 'timestamps')
    expect(ts).toBeDefined()
    expect(ts?.removableIn).toBe('light')
    expect(ts?.fields.some((f) => f.name === 'Fecha de creación')).toBe(true)
    expect(ts?.fields.some((f) => f.name === 'Fecha de modificación')).toBe(true)
  })

  it('light ["timestamps"]: mvhd/tkhd/mdhd a cero y la duración NO cambia', async () => {
    const out = await stripVideo(MP4_TIMES, 'mp4', { mode: 'light', blocks: ['timestamps'] })
    expect(out.length).toBe(MP4_TIMES.length)
    for (const type of ['mvhd', 'tkhd', 'mdhd']) {
      const times = readBoxTimes(out, type)
      expect(times, `${type} presente`).not.toBeNull()
      expect(times?.creation, `${type} creation_time`).toBe(0)
      expect(times?.modification, `${type} modification_time`).toBe(0)
    }
    // La duración (mvhd) y el bloque técnico 'format' siguen intactos.
    const report = await videoDomain.scan(out)
    expect(report.fields.find((f) => f.name === 'Duración')?.value).toBe('1:30')
    expect(report.blocks.find((b) => b.id === 'format')?.removableIn).toBe('never')
    expect(report.blocks.some((b) => b.id === 'timestamps')).toBe(false)
  })

  it('deep (sin bloques) también pone a cero mvhd/tkhd/mdhd y la duración NO cambia', async () => {
    const out = await stripVideo(MP4_TIMES, 'mp4', { mode: 'deep', blocks: [] })
    expect(out.length).toBe(MP4_TIMES.length)
    for (const type of ['mvhd', 'tkhd', 'mdhd']) {
      const times = readBoxTimes(out, type)
      expect(times, `${type} presente`).not.toBeNull()
      expect(times?.creation, `${type} creation_time`).toBe(0)
      expect(times?.modification, `${type} modification_time`).toBe(0)
    }
    // La duración (mvhd) y el bloque técnico 'format' siguen intactos.
    const report = await videoDomain.scan(out)
    expect(report.fields.find((f) => f.name === 'Duración')?.value).toBe('1:30')
    expect(report.blocks.some((b) => b.id === 'timestamps')).toBe(false)
  })

  it('light sin ["timestamps"] deja las fechas como estaban', async () => {
    const out = await stripVideo(MP4_TIMES, 'mp4', { mode: 'light', blocks: ['tags'] })
    expect(readBoxTimes(out, 'mvhd')?.creation).toBe(3600)
  })
})

describe('videoDomain — fuga timestamps (mkv/webm)', () => {
  it('scan expone el bloque timestamps del mkv con sus tres campos', async () => {
    const report = await videoDomain.scan(MKV_TIMES)
    const ts = report.blocks.find((b) => b.id === 'timestamps')
    expect(ts?.removableIn).toBe('light')
    expect(ts?.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(['Fecha (UTC)', 'Aplicación de multiplexado', 'Aplicación de escritura']),
    )
  })

  it('light ["timestamps"]: DateUTC/MuxingApp/WritingApp fuera y tamaño intacto', async () => {
    const src = MKV_TIMES
    const out = await stripVideo(src, 'mkv', { mode: 'light', blocks: ['timestamps'] })
    expect(out.length).toBe(src.length) // mismo tamaño: Void del mismo largo
    const txt = textOf(out)
    expect(txt).not.toContain('ffmpeg') // MuxingApp sustituido por Void
    expect(txt).not.toContain('Lavf60') // WritingApp sustituido por Void
    // El inventario del resultado ya no ve el bloque timestamps.
    const report = await videoDomain.scan(out)
    expect(report.blocks.some((b) => b.id === 'timestamps')).toBe(false)
    // El layout no se movió: el Cluster sigue en la misma posición.
    expect(indexOfBytes(out, ascii('MARCADOR'))).toBe(indexOfBytes(src, ascii('MARCADOR')))
  })

  it('deep (sin bloques) también quita DateUTC/MuxingApp/WritingApp y el tamaño no cambia', async () => {
    const src = MKV_TIMES
    const out = await stripVideo(src, 'mkv', { mode: 'deep', blocks: [] })
    expect(out.length).toBe(src.length) // mismo tamaño: Void del mismo largo
    // Los tres elementos de Info desaparecen (sustituidos por Void).
    expect(containsBytes(out, ID_BYTES[0x4461])).toBe(false) // DateUTC fuera
    expect(containsBytes(out, ID_BYTES[0x4d80])).toBe(false) // MuxingApp fuera
    expect(containsBytes(out, ID_BYTES[0x5741])).toBe(false) // WritingApp fuera
    const txt = textOf(out)
    expect(txt).not.toContain('ffmpeg')
    expect(txt).not.toContain('Lavf60')
    // El inventario del resultado ya no ve el bloque timestamps.
    const report = await videoDomain.scan(out)
    expect(report.blocks.some((b) => b.id === 'timestamps')).toBe(false)
    // El layout no se movió: el Cluster sigue en la misma posición.
    expect(indexOfBytes(out, ascii('MARCADOR'))).toBe(indexOfBytes(src, ascii('MARCADOR')))
  })
})

describe('videoDomain — fuga c2pa (cajas uuid)', () => {
  it('scan: C2PA y XMP en el bloque c2pa (high); uuid desconocido sigue en junk', async () => {
    const report = await videoDomain.scan(MP4_UUID_ALL)
    const c2pa = report.blocks.find((b) => b.id === 'c2pa')
    expect(c2pa).toBeDefined()
    expect(c2pa?.removableIn).toBe('light')
    expect(c2pa?.fields.every((f) => f.sensitivity === 'high')).toBe(true)
    expect(c2pa?.fields.map((f) => f.name)).toEqual(expect.arrayContaining(['C2PA', 'XMP']))
    expect(report.blocks.some((b) => b.id === 'junk')).toBe(true) // el uuid desconocido
  })

  it('entries: uuid C2PA/XMP en high, uuid desconocido en medium', async () => {
    const report = await videoDomain.scan(MP4_UUID_ALL)
    expect(report.entries.find((e) => e.label === 'C2PA')?.sensitivity).toBe('high')
    expect(report.entries.find((e) => e.label === 'XMP')?.sensitivity).toBe('high')
    expect(report.entries.find((e) => e.label === 'UUID desconocido')?.sensitivity).toBe('medium')
  })

  it('light ["c2pa"] borra C2PA/XMP (top-level y moov) y conserva el desconocido', async () => {
    const out = await stripVideo(MP4_UUID_ALL, 'mp4', { mode: 'light', blocks: ['c2pa'] })
    const txt = textOf(out)
    expect(txt).not.toContain('C2PATOP')
    expect(txt).not.toContain('C2PAMOOV')
    expect(txt).not.toContain('XMPDATA')
    expect(txt).toContain('UNKNOWNDATA')
    expectConsistentSizes(out)
  })

  it('light ["junk"] borra el uuid desconocido y conserva C2PA/XMP', async () => {
    const out = await stripVideo(MP4_UUID_ALL, 'mp4', { mode: 'light', blocks: ['junk'] })
    const txt = textOf(out)
    expect(txt).not.toContain('UNKNOWNDATA')
    expect(txt).toContain('C2PATOP')
    expect(txt).toContain('XMPDATA')
  })
})

describe('videoDomain — entrada malformada', () => {
  it('strip con bloques nuevos devuelve los bytes intactos y no lanza', async () => {
    const bad = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
    const out = await stripVideo(bad, 'mp4', { mode: 'light', blocks: ['timestamps', 'c2pa'] })
    expect(out).toEqual(bad)
    const report = await videoDomain.scan(bad)
    expect(report).toEqual({ fields: [], count: 0, blocks: [], entries: [] })
  })
})

/* ════════════ Verificación posterior (verify-after-clean) ════════════ */

describe('videoDomain — verificación posterior (verify-after-clean)', () => {
  it('MP4 light ["tags"] queda limpio (no "remaining" fantasma)', async () => {
    const result = await stripMetadata({
      bytes: MP4,
      name: 'v.mp4',
      kind: 'mp4',
      config: { mode: 'light', blocks: ['tags'] },
    })
    expect(result.verification?.status).toBe('clean')
  })

  it('MP4 deep queda limpio', async () => {
    const result = await stripMetadata({
      bytes: MP4,
      name: 'v.mp4',
      kind: 'mp4',
      config: { mode: 'deep', blocks: [] },
    })
    expect(result.verification?.status).toBe('clean')
  })

  it('MOV light ["tags"] y deep quedan limpios', async () => {
    const light = await stripMetadata({
      bytes: MOV,
      name: 'v.mov',
      kind: 'mov',
      config: { mode: 'light', blocks: ['tags'] },
    })
    expect(light.verification?.status).toBe('clean')
    const deep = await stripMetadata({
      bytes: MOV,
      name: 'v.mov',
      kind: 'mov',
      config: { mode: 'deep', blocks: [] },
    })
    expect(deep.verification?.status).toBe('clean')
  })

  it('MP4 light ["timestamps"] con fechas reales queda limpio (fechas puestas a cero)', async () => {
    const result = await stripMetadata({
      bytes: MP4_TIMES,
      name: 'v.mp4',
      kind: 'mp4',
      config: { mode: 'light', blocks: ['timestamps'] },
    })
    expect(result.verification?.status).toBe('clean')
  })

  it('MP4 que conserva etiquetas eliminables reporta "remaining"', async () => {
    const result = await stripMetadata({
      bytes: MP4,
      name: 'v.mp4',
      kind: 'mp4',
      config: { mode: 'light', blocks: ['junk'] },
    })
    expect(result.verification?.status).toBe('remaining')
    expect(result.verification?.remaining).toBeGreaterThan(0)
  })
})