/**
 * ADEI-ONE — Tests del dominio AUDIO de "Eliminar metadata" (`audio.ts`).
 * Fixtures construidos byte a byte (mismo estilo que `chunks.test.ts`):
 * mp3 (ID3v2 + ID3v1 + APE + Lyrics3), flac (fLaC + bloques), m4a (cajas
 * ISO-BMFF) y wav (RIFF/WAVE). Cirugía pura → se prueba en Node sin DOM.
 */
import { describe, expect, it } from 'vitest'
import { audioDomain } from './audio'
import { stripMetadata } from './engine'
import { asciiAt, readU32BE } from './chunks'
import type { MetadataField } from '@/core/types'

/* ── Helpers de construcción de fixtures ── */

function ascii(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)))
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value)

function u32be(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function u32le(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])
}

function u16le(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >>> 8) & 0xff])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, part) => n + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** Tamaño ID3v2 SYNC-SAFE (4 bits útiles por byte, bit alto a 0). */
function synchsafe(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 21) & 0x7f, (n >>> 14) & 0x7f, (n >>> 7) & 0x7f, n & 0x7f])
}

/** Entero BE plano de 4 bytes (tamaños RIFF / cajas). */
function be32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]
  ) >>> 0
}

/** Entero LE de 4 bytes (tamaño RIFF). */
function le32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  )
}

/** Tipos de las cajas top-level de un contenedor ISO-BMFF (valida tamaños al caminar). */
function boxTypes(bytes: Uint8Array): string[] {
  const out: string[] = []
  let i = 0
  while (i + 8 <= bytes.length) {
    const size = be32(bytes, i)
    if (size < 8 || i + size > bytes.length) break
    out.push(textOf(bytes.slice(i + 4, i + 8)))
    i += size
  }
  return out
}

const noop = (): void => {}

/* ── Fixtures mp3 ── */

function id3v2Frame(id: string, enc: number, value: string): Uint8Array {
  const body = concat([Uint8Array.of(enc), enc === 3 ? utf8(value) : ascii(value)])
  return concat([ascii(id), synchsafe(body.length), Uint8Array.of(0, 0), body])
}

function id3v2Tag(frames: Uint8Array[]): Uint8Array {
  const size = frames.reduce((n, frame) => n + frame.length, 0)
  return concat([ascii('ID3'), Uint8Array.of(3, 0, 0), synchsafe(size), ...frames])
}

/** Etiqueta ID3v1 (128 bytes) con campos fijos. */
function id3v1Tag(opts: { title: string; artist: string; album: string }): Uint8Array {
  const fit = (value: string): Uint8Array => {
    const out = new Uint8Array(30)
    out.set(ascii(value).slice(0, 30))
    return out
  }
  return concat([
    ascii('TAG'),
    fit(opts.title),
    fit(opts.artist),
    fit(opts.album),
    ascii('2023'),
    new Uint8Array(31),
  ])
}

/** Etiqueta APEv2 (cabecera + ítem + footer) junto al final. */
function apeTag(key: string, value: string): Uint8Array {
  const item = concat([u32le(utf8(value).length), u32le(0), ascii(key), Uint8Array.of(0), utf8(value)])
  const itemsSize = item.length
  const header = concat([ascii('APETAGEX'), u32le(2000), u32le(itemsSize), u32le(1), u32le(0x80000000), new Uint8Array(8)])
  const footer = concat([ascii('APETAGEX'), u32le(2000), u32le(itemsSize), u32le(1), u32le(0xa0000000), new Uint8Array(8)])
  return concat([header, item, footer])
}

/** Letra Lyrics3v2 justo antes de la ID3v1. */
function lyrics3Tag(text: string): Uint8Array {
  const size = String(text.length).padStart(6, '0')
  return concat([ascii(text), ascii('LYRICS200'), ascii('LYR   '), ascii(size)])
}

const ID3V2_TAG = id3v2Tag([
  id3v2Frame('TIT2', 3, 'Mi canción'),
  id3v2Frame('TPE1', 3, 'Artista Anónima'),
])

/** Audio MP3 con cabecera MPEG real: MPEG1 Layer III, 128 kbps, 44.1 kHz, estéreo. */
const MP3_AUDIO = concat([ascii('\xff\xfb\x90\x00'), ascii('MARC1'), ascii('MARC2')])

const MP3 = concat([
  ID3V2_TAG,
  MP3_AUDIO,
  apeTag('Title', 'Mi canción'),
  lyrics3Tag('LATIN LYRICS'),
  id3v1Tag({ title: 'Vieja canción', artist: 'Antiguo', album: 'Vinilo' }),
])

/* ── Fixtures flac ── */

function flacBlock(data: Uint8Array, type: number, last = false): Uint8Array {
  const len = data.length
  const header = (last ? 0x80 : 0) | (type & 0x7f)
  return concat([Uint8Array.of(header, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff), data])
}

function vorbisComment(comments: string[]): Uint8Array {
  const vendor = ascii('adei')
  const parts: Uint8Array[] = [u32le(vendor.length), vendor, u32le(comments.length)]
  for (const comment of comments) parts.push(u32le(utf8(comment).length), utf8(comment))
  return concat(parts)
}

/** STREAMINFO realista: empaqueta sample rate (20b) + canales-1 (3b) + bps-1 (5b) + muestras (36b). */
function streamInfoBytes(opts: {
  sampleRate: number
  channels: number
  bitsPerSample: number
  totalSamples: number
}): Uint8Array {
  const out = new Uint8Array(34)
  const word =
    (BigInt(opts.sampleRate) << 44n) |
    (BigInt(opts.channels - 1) << 41n) |
    (BigInt(opts.bitsPerSample - 1) << 36n) |
    BigInt(opts.totalSamples)
  for (let i = 0; i < 8; i++) out[10 + i] = Number((word >> BigInt(56 - i * 8)) & 0xffn)
  return out
}

const FLAC_STREAMINFO = flacBlock(
  streamInfoBytes({ sampleRate: 44100, channels: 2, bitsPerSample: 16, totalSamples: 441000 }),
  0,
  false,
)

const FLAC = concat([
  ascii('fLaC'),
  FLAC_STREAMINFO,
  flacBlock(vorbisComment(['TITLE=Misión de prueba', 'ARTIST=Quién']), 4, false),
  flacBlock(ascii('PICTDUMMY'), 6, true),
  ascii('AUDIODATA8'),
])

/* ── Fixtures m4a ── */

function box(type: string, data: Uint8Array): Uint8Array {
  return concat([u32be(8 + data.length), ascii(type), data])
}

function ilstItem(fourcc: string, value: string): Uint8Array {
  return box(fourcc, box('data', concat([new Uint8Array(4), utf8(value)])))
}

/** Caja `mvhd` v0 completa (creación/modificación/timescale/duración…). */
function mvhdBox(timescale: number, duration: number): Uint8Array {
  return box(
    'mvhd',
    concat([
      Uint8Array.of(0, 0, 0, 0), // versión/flags (v0)
      u32be(0), // creation_time
      u32be(0), // modification_time
      u32be(timescale),
      u32be(duration),
      u32be(0x00010000), // rate 16.16
      Uint8Array.of(0x01, 0x00), // volume
      new Uint8Array(2), // reserved
      new Uint8Array(8), // reserved
      new Uint8Array(36), // matriz
      new Uint8Array(24), // pre_defined
      u32be(2), // next_track_ID
    ]),
  )
}

/** Caja `stsd` con un único sample entry del códec indicado. */
function stsdBox(codec: string): Uint8Array {
  const entry = concat([u32be(16), ascii(codec), new Uint8Array(6), Uint8Array.of(0, 1)])
  return box('stsd', concat([new Uint8Array(4), u32be(1), entry]))
}

/** Pista `trak` con la ruta mdia>minf>stbl>stsd (para detectar el códec). */
function trakWithStsd(codec: string): Uint8Array {
  return box('trak', box('mdia', box('minf', box('stbl', stsdBox(codec)))))
}

const M4A = concat([
  box('ftyp', ascii('M4A ')),
  box('free', ascii('JUNKFREE')),
  box(
    'moov',
    concat([
      mvhdBox(44100, 4410000), // → 100 s
      box(
        'udta',
        box(
          'meta',
          concat([
            new Uint8Array(4), // versión/flags del full-box `meta`
            box('hdlr', ascii('MDIRAPP')),
            box('ilst', concat([ilstItem('©nam', 'Melodía'), ilstItem('©ART', 'Intérprete X')])),
          ]),
        ),
      ),
      trakWithStsd('mp4a'),
    ]),
  ),
  box('mdat', ascii('PCMDATA123')),
])

/* ── Fixtures wav ── */

function riffChunk(id: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 === 1 ? Uint8Array.of(0) : new Uint8Array()
  return concat([ascii(id), u32le(data.length), data, pad])
}

function riffListInfo(subChunks: Uint8Array[]): Uint8Array {
  return riffChunk('LIST', concat([ascii('INFO'), ...subChunks]))
}

const WAV = concat([
  ascii('RIFF'),
  u32le(0),
  ascii('WAVE'),
  riffChunk('fmt ', concat([u16le(1), u16le(2), u32le(44100), u32le(176400), u16le(4), u16le(16)])),
  riffChunk('JUNK', ascii('JUNKJUNK')),
  riffListInfo([
    riffChunk('INAM', ascii('Mi pista')),
    riffChunk('ISFT', ascii('Adei Studio')),
  ]),
  riffChunk('data', ascii('DATADATADATA')),
])

/* ── Fixtures de inventario (entries) ── */

/** MP3 con frames que el allowlist antiguo ocultaba (TXXX/USLT/PRIV). */
const MP3_UNMAPPED = concat([
  id3v2Tag([
    id3v2Frame('TIT2', 3, 'Conocida'),
    id3v2Frame('TXXX', 3, 'Clave personalizada'),
    id3v2Frame('USLT', 3, 'Letra'),
    id3v2Frame('PRIV', 3, 'DATO'),
  ]),
  MP3_AUDIO,
])

/** FLAC con parejas Vorbis que el allowlist antiguo ocultaba. */
const FLAC_UNMAPPED = concat([
  ascii('fLaC'),
  FLAC_STREAMINFO,
  flacBlock(vorbisComment(['TITLE=K', 'ARTIST=A', 'DESCRIPTION=algo', 'TRACKNUMBER=3']), 4, true),
  ascii('AUDIODATA8'),
])

/** M4A con items de ilst desconocidos (----) y carátula (covr). */
const M4A_UNKNOWN = concat([
  box('ftyp', ascii('M4A ')),
  box(
    'moov',
    concat([
      mvhdBox(44100, 4410000),
      box(
        'udta',
        box(
          'meta',
          concat([
            new Uint8Array(4),
            box('ilst', concat([ilstItem('©nam', 'Melodía'), ilstItem('----', 'Custom'), ilstItem('covr', 'IMGBYTES')])),
          ]),
        ),
      ),
    ]),
  ),
  box('mdat', ascii('PCMDATA123')),
])

/** WAV con un sub-chunk INFO no mapeado (ISBJ) y un chunk técnico (bext). */
const WAV_UNMAPPED = concat([
  ascii('RIFF'),
  u32le(0),
  ascii('WAVE'),
  riffChunk('fmt ', concat([u16le(1), u16le(2), u32le(44100), u32le(176400), u16le(4), u16le(16)])),
  riffListInfo([riffChunk('INAM', ascii('T')), riffChunk('ISBJ', ascii('Materia'))]),
  riffChunk('bext', ascii('BEXTDATA')),
  riffChunk('data', ascii('DATADATADATA')),
])

/* ── mp3 ── */

describe('audioDomain — mp3', () => {
  it('kinds expone mp3/flac/m4a/wav en ese orden', () => {
    expect(audioDomain.kinds).toEqual(['mp3', 'flac', 'm4a', 'wav'])
  })

  it('scan detecta Título/Artista y los cuatro bloques', async () => {
    const report = await audioDomain.scan(MP3)
    expect(report.blocks.map((b) => b.id)).toEqual(['id3v2', 'id3v1', 'ape', 'lyrics', 'format'])

    // Frames de la ID3v2 (TIT2 → Título, TPE1 → Artista)
    const title = report.fields.find((f) => f.name === 'Título')
    expect(title?.value).toBe('Mi canción')
    const artist = report.fields.find((f) => f.name === 'Artista')
    expect(artist?.value).toBe('Artista Anónima')

    // La ID3v1 aporta su propio bloque con el título antiguo
    const id3v1 = report.blocks.find((b) => b.id === 'id3v1')
    expect(id3v1?.fields.some((f) => f.value === 'Vieja canción')).toBe(true)
  })

  it('strip light ["id3v2"] quita la ID3 y conserva audio e ID3v1', async () => {
    const out = await audioDomain.strip(MP3, 'mp3', { mode: 'light', blocks: ['id3v2'] }, noop)
    expect(out.length).toBe(MP3.length - ID3V2_TAG.length)
    expect(out.slice(0, 2)).toEqual(ascii('\xff\xfb'))
    expect(textOf(out)).toContain('MARC1')
    expect(out.slice(out.length - 128, out.length - 125)).toEqual(ascii('TAG'))
  })

  it('strip light sin bloques → passthrough byte-idéntico (array nuevo)', async () => {
    const out = await audioDomain.strip(MP3, 'mp3', { mode: 'light', blocks: [] }, noop)
    expect(out).toEqual(MP3)
    expect(out).not.toBe(MP3)
  })

  it('strip deep elimina id3v2+id3v1+ape+lyrics y deja solo el audio', async () => {
    const out = await audioDomain.strip(MP3, 'mp3', { mode: 'deep', blocks: [] }, noop)
    expect(out).toEqual(MP3_AUDIO)
    const txt = textOf(out)
    expect(txt).not.toContain('ID3')
    expect(txt).not.toContain('APETAGEX')
    expect(txt).not.toContain('LYRICS200')
  })

  it('strip con kind no soportado lanza un mensaje de "fase próxima"', async () => {
    await expect(
      audioDomain.strip(MP3, 'mp4', { mode: 'deep', blocks: [] }, noop),
    ).rejects.toThrow(/fase próxima/i)
  })
})

/* ── flac ── */

describe('audioDomain — flac', () => {
  it('scan detecta Título/Artista del VORBIS_COMMENT y Carátula por PICTURE', async () => {
    const report = await audioDomain.scan(FLAC)
    expect(report.blocks.map((b) => b.id)).toEqual(['vorbis', 'pictures', 'format'])
    const title = report.fields.find((f) => f.name === 'Título')
    expect(title?.value).toBe('Misión de prueba')
    const cover = report.fields.find((f) => f.name === 'Carátula')
    expect(cover?.value).toBe('Presente')
  })

  it('strip light ["vorbis"] quita el comentario y conserva STREAMINFO/PICTURE/audio', async () => {
    const out = await audioDomain.strip(FLAC, 'flac', { mode: 'light', blocks: ['vorbis'] }, noop)
    const txt = textOf(out)
    expect(txt).not.toContain('Misión')
    expect(txt).not.toContain('TITLE=')
    expect(txt).toContain('PICTDUMMY')
    expect(txt).toContain('AUDIODATA8')
    expect(textOf(out.slice(0, 4))).toBe('fLaC')
  })

  it('strip deep quita también el PICTURE y conserva STREAMINFO + audio', async () => {
    const out = await audioDomain.strip(FLAC, 'flac', { mode: 'deep', blocks: [] }, noop)
    const txt = textOf(out)
    expect(txt).not.toContain('Misión')
    expect(txt).not.toContain('PICTDUMMY')
    expect(txt).toContain('AUDIODATA8')
    expect(textOf(out.slice(0, 4))).toBe('fLaC')
    // STREAMINFO (tipo 0) intacto: 4 (firma) + (1+3+34)
    expect(out.length).toBe(4 + 38 + ascii('AUDIODATA8').length)
    expect(out[4] & 0x7f).toBe(0)
  })

  it('strip deep sobre bytes no-flac devuelve los mismos bytes (no lanza)', async () => {
    const junk = ascii('NOTFLAC')
    const out = await audioDomain.strip(junk, 'flac', { mode: 'deep', blocks: [] }, noop)
    expect(out).toEqual(junk)
  })

  it('scan con bytes sin firma conocida devuelve el report vacío', async () => {
    const report = await audioDomain.scan(ascii('NOAUDIOATALL'))
    expect(report).toEqual({ fields: [], count: 0, blocks: [], entries: [] })
  })
})

/* ── m4a ── */

describe('audioDomain — m4a', () => {
  it('scan ve el Título dentro de moov/udta/meta/ilst', async () => {
    const report = await audioDomain.scan(M4A)
    expect(report.blocks.map((b) => b.id)).toEqual(['tags', 'format'])
    const title = report.fields.find((f) => f.name === 'Título')
    expect(title?.value).toBe('Melodía')
    const artist = report.fields.find((f) => f.name === 'Artista')
    expect(artist?.value).toBe('Intérprete X')
  })

  it('strip light ["tags"] quita udta/ilst y conserva trak, mdat y el resto', async () => {
    const out = await audioDomain.strip(M4A, 'm4a', { mode: 'light', blocks: ['tags'] }, noop)
    expect(boxTypes(out)).toEqual(['ftyp', 'free', 'moov', 'mdat'])
    const txt = textOf(out)
    expect(txt).not.toContain('Melodía')
    expect(txt).not.toContain('udta')
    expect(txt).toContain('mp4a')
    expect(txt).toContain('PCMDATA123')
  })

  it('strip deep además quita cajas free/skip', async () => {
    const out = await audioDomain.strip(M4A, 'm4a', { mode: 'deep', blocks: [] }, noop)
    expect(boxTypes(out)).toEqual(['ftyp', 'moov', 'mdat'])
    const txt = textOf(out)
    expect(txt).not.toContain('JUNKFREE')
    expect(txt).not.toContain('Melodía')
    expect(txt).toContain('PCMDATA123')
  })

  it('el moov reconstruido sigue siendo parseable hasta mdat (tamaños recalculados)', async () => {
    const out = await audioDomain.strip(M4A, 'm4a', { mode: 'deep', blocks: [] }, noop)
    const types = boxTypes(out)
    expect(types.at(-1)).toBe('mdat')
  })

  it('remux: quitar udta re-escribe stco según el desplazamiento de mdat', async () => {
    function stcoBox(entries: number[]): Uint8Array {
      return box('stco', concat([Uint8Array.of(0, 0, 0, 0), u32be(entries.length), concat(entries.map(u32be))]))
    }
    const src = concat([
      box('ftyp', ascii('M4A ')),
      box(
        'moov',
        concat([
          box('udta', box('meta', concat([new Uint8Array(4), box('ilst', ilstItem('©nam', 'Melodía'))]))),
          box('trak', box('mdia', box('minf', box('stbl', stcoBox([140, 220]))))),
        ]),
      ),
      box('mdat', concat([ascii('PCMDATAC'), new Uint8Array(300)])),
    ])
    const indexOf = (hay: Uint8Array, needle: Uint8Array): number => {
      outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
        return i
      }
      return -1
    }
    const readStco = (bytes: Uint8Array): number[] => {
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
      const entries: number[] = []
      for (let n = 0; n < count; n++) entries.push(readU32BE(bytes, off + 16 + n * 4))
      return entries
    }

    const mdatOld = indexOf(src, ascii('mdat'))
    expect(mdatOld).toBeGreaterThan(0)
    expect(readStco(src)).toEqual([140, 220])

    const out = await audioDomain.strip(src, 'm4a', { mode: 'light', blocks: ['tags'] }, noop)
    const delta = indexOf(out, ascii('mdat')) - mdatOld
    expect(delta).toBeLessThan(0) // moov encogido → mdat antes
    const after = readStco(out)
    expect(after[0]).toBe(140 + delta)
    expect(after[1]).toBe(220 + delta)
    expect(indexOf(out, ascii('PCMDATAC'))).toBeGreaterThan(0) // audio intacto
  })
})

/* ── wav ── */

describe('audioDomain — wav', () => {
  it('scan parsea LIST/INFO a campos traducidos (Título/Software)', async () => {
    const report = await audioDomain.scan(WAV)
    expect(report.blocks.map((b) => b.id)).toEqual(['info', 'format'])
    const title = report.fields.find((f) => f.name === 'Título')
    expect(title?.value).toBe('Mi pista')
    const software = report.fields.find((f) => f.name === 'Software')
    expect(software?.value).toBe('Adei Studio')
  })

  it('strip light ["info"] quita LIST INFO y conserva fmt/JUNK/data', async () => {
    const out = await audioDomain.strip(WAV, 'wav', { mode: 'light', blocks: ['info'] }, noop)
    const txt = textOf(out)
    expect(txt).not.toContain('Mi pista')
    expect(txt).not.toContain('INAM')
    expect(txt).not.toContain('INFO')
    expect(textOf(out.slice(12, 16))).toBe('fmt ')
    expect(txt).toContain('JUNKJUNK')
    expect(txt).toContain('DATADATADATA')
    expect(textOf(out.slice(0, 4))).toBe('RIFF')
    expect(textOf(out.slice(8, 12))).toBe('WAVE')
    expect(le32(out, 4)).toBe(out.length - 8)
  })

  it('strip deep además quita JUNK y re-escribe el tamaño RIFF', async () => {
    const out = await audioDomain.strip(WAV, 'wav', { mode: 'deep', blocks: [] }, noop)
    const txt = textOf(out)
    expect(txt).not.toContain('JUNK')
    expect(txt).not.toContain('INFO')
    expect(txt).not.toContain('Mi pista')
    expect(textOf(out.slice(12, 16))).toBe('fmt ')
    expect(txt).toContain('DATADATADATA')
    expect(le32(out, 4)).toBe(out.length - 8)
  })
})

/* ── Bloque 'format' (técnico, nunca se borra) ── */

describe('audioDomain — bloque format', () => {
  it('mp3: cabecera MPEG produce el bloque format con removableIn never', async () => {
    const report = await audioDomain.scan(MP3)
    const format = report.blocks.find((b) => b.id === 'format')
    expect(format?.removableIn).toBe('never')
    const field = (name: string): MetadataField | undefined => format?.fields.find((f) => f.name === name)
    expect(field('Versión')?.value).toBe('MPEG1')
    expect(field('Capa')?.value).toBe('Layer III')
    expect(field('Bitrate')?.value).toBe('128 kbps')
    expect(field('Frecuencia de muestreo')?.value).toBe('44100 Hz')
    expect(field('Canales')?.value).toBe('Stereo')
    expect(field('Duración')).toBeDefined()
  })

  it('mp3: los bloques de etiquetas exponen removableIn light', async () => {
    const report = await audioDomain.scan(MP3)
    for (const id of ['id3v2', 'id3v1', 'ape', 'lyrics']) {
      expect(report.blocks.find((b) => b.id === id)?.removableIn).toBe('light')
    }
  })

  it('flac: STREAMINFO produce el bloque format (nunca borrable)', async () => {
    const report = await audioDomain.scan(FLAC)
    const format = report.blocks.find((b) => b.id === 'format')
    expect(format?.removableIn).toBe('never')
    const field = (name: string): MetadataField | undefined => format?.fields.find((f) => f.name === name)
    expect(field('Frecuencia de muestreo')?.value).toBe('44100 Hz')
    expect(field('Canales')?.value).toBe('2')
    expect(field('Bits por muestra')?.value).toBe('16')
    expect(field('Duración')).toBeDefined()
    expect(report.blocks.find((b) => b.id === 'vorbis')?.removableIn).toBe('light')
    expect(report.blocks.find((b) => b.id === 'pictures')?.removableIn).toBe('light')
  })

  it('m4a: mvhd y stsd producen Duración/Escala de tiempo/Códec', async () => {
    const report = await audioDomain.scan(M4A)
    const format = report.blocks.find((b) => b.id === 'format')
    expect(format?.removableIn).toBe('never')
    const field = (name: string): MetadataField | undefined => format?.fields.find((f) => f.name === name)
    expect(field('Duración')?.value).toBe('1:40')
    expect(field('Escala de tiempo')?.value).toBe('44100')
    expect(field('Códec')?.value).toBe('mp4a')
    expect(report.blocks.find((b) => b.id === 'tags')?.removableIn).toBe('light')
  })

  it('wav: el chunk fmt produce formato/canales/bitrate y duración', async () => {
    const report = await audioDomain.scan(WAV)
    const format = report.blocks.find((b) => b.id === 'format')
    expect(format?.removableIn).toBe('never')
    const field = (name: string): MetadataField | undefined => format?.fields.find((f) => f.name === name)
    expect(field('Formato')?.value).toBe('PCM')
    expect(field('Canales')?.value).toBe('2')
    expect(field('Frecuencia de muestreo')?.value).toBe('44100 Hz')
    expect(field('Tasa de bytes')?.value).toBe('176400 B/s')
    expect(field('Bits por muestra')?.value).toBe('16')
    expect(field('Duración')).toBeDefined()
    expect(report.blocks.find((b) => b.id === 'info')?.removableIn).toBe('light')
  })
})

/* ── Integración con el engine ── */

describe('audioDomain — integración con el engine', () => {
  it('engine.stripMetadata limpia un mp3 (light ["id3v2"])', async () => {
    const result = await stripMetadata({
      bytes: MP3,
      name: 'pista.mp3',
      kind: 'mp3',
      config: { mode: 'light', blocks: ['id3v2'] },
    })
    expect(result.kind).toBe('mp3')
    expect(result.name).toBe('pista-limpio.mp3')
    const cleaned = new Uint8Array(await result.blob.arrayBuffer())
    expect(cleaned.length).toBe(MP3.length - ID3V2_TAG.length)
    expect(textOf(cleaned)).not.toContain('TIT2')
    expect(textOf(cleaned)).not.toContain('TPE1')
    expect(textOf(cleaned)).toContain('MARC1')
    expect(cleaned.slice(0, 2)).toEqual(ascii('\xff\xfb'))
    expect(cleaned.slice(cleaned.length - 128, cleaned.length - 125)).toEqual(ascii('TAG'))
  })
})

/* ── Inventario exhaustivo (entries) ── */

describe('audioDomain — inventario (entries)', () => {
  it('mp3: enumera TODOS los frames, incluidos los desconocidos, con su id crudo', async () => {
    const report = await audioDomain.scan(MP3_UNMAPPED)
    const keys = report.entries.map((e) => e.key)
    expect(keys).toEqual(expect.arrayContaining(['TIT2', 'TXXX', 'USLT', 'PRIV']))
    const txxx = report.entries.find((e) => e.key === 'TXXX')
    expect(txxx?.where).toContain('ID3v2')
    expect(txxx?.removal).toBe('with-container')
  })

  it('mp3: las entradas técnicas de formato nunca se borran', async () => {
    const report = await audioDomain.scan(MP3_UNMAPPED)
    const format = report.entries.find((e) => e.key === 'Formato')
    expect(format?.removal).toBe('never')
  })

  it('mp3: enumera la ID3v1 y la etiqueta APE por elementos', async () => {
    const report = await audioDomain.scan(MP3)
    const keys = report.entries.map((e) => e.key)
    expect(keys).toEqual(expect.arrayContaining(['TITLE', 'ARTIST', 'ALBUM', 'Title']))
    const ape = report.entries.find((e) => e.key === 'Title' && e.where.includes('APE'))
    expect(ape?.value).toBe('Mi canción')
  })

  it('flac: enumera TODAS las parejas Vorbis, incluidas las no mapeadas', async () => {
    const report = await audioDomain.scan(FLAC_UNMAPPED)
    const keys = report.entries.map((e) => e.key)
    expect(keys).toContain('TITLE')
    expect(keys).toContain('DESCRIPTION')
    expect(keys).toContain('TRACKNUMBER')
    const desc = report.entries.find((e) => e.key === 'DESCRIPTION')
    expect(desc?.value).toBe('algo')
  })

  it('m4a: enumera todos los items de ilst, incluidos los desconocidos y covr', async () => {
    const report = await audioDomain.scan(M4A_UNKNOWN)
    const keys = report.entries.map((e) => e.key)
    expect(keys).toContain('©nam')
    expect(keys).toContain('----')
    expect(keys).toContain('covr')
    const unknown = report.entries.find((e) => e.key === '----')
    expect(unknown?.where).toContain('ilst')
  })

  it('wav: enumera sub-chunks INFO no mapeados y chunks técnicos con su id crudo', async () => {
    const report = await audioDomain.scan(WAV_UNMAPPED)
    const keys = report.entries.map((e) => e.key)
    expect(keys).toContain('ISBJ')
    expect(keys).toContain('bext')
  })

  it('toda entrada lleva una ruta `where` no vacía', async () => {
    for (const src of [MP3_UNMAPPED, FLAC_UNMAPPED, M4A_UNKNOWN, WAV_UNMAPPED]) {
      const report = await audioDomain.scan(src)
      expect(report.entries.length).toBeGreaterThan(0)
      expect(report.entries.every((e) => e.where.trim().length > 0)).toBe(true)
    }
  })
})

/* ── Verificación posterior (verify-after-clean) ── */

/** FLAC con un bloque PADDING (tipo 1): relleno que el modo ligero no elimina. */
const FLAC_WITH_PADDING = concat([
  ascii('fLaC'),
  FLAC_STREAMINFO,
  flacBlock(vorbisComment(['TITLE=K']), 4, false),
  flacBlock(ascii('PADDINGX'), 1, true),
  ascii('AUDIODATA8'),
])

describe('audioDomain — verificación posterior (verify-after-clean)', () => {
  it('FLAC light queda limpio (el PADDING no es metadata eliminable)', async () => {
    const result = await stripMetadata({
      bytes: FLAC_WITH_PADDING,
      name: 'a.flac',
      kind: 'flac',
      config: { mode: 'light', blocks: ['vorbis'] },
    })
    expect(result.verification?.status).toBe('clean')
  })

  it('WAV light ["info"] queda limpio (JUNK/PAD es relleno, no metadata)', async () => {
    const result = await stripMetadata({
      bytes: WAV,
      name: 'a.wav',
      kind: 'wav',
      config: { mode: 'light', blocks: ['info'] },
    })
    expect(result.verification?.status).toBe('clean')
  })

  it('FLAC light que conserva la carátula reporta "remaining"', async () => {
    const result = await stripMetadata({
      bytes: FLAC,
      name: 'a.flac',
      kind: 'flac',
      config: { mode: 'light', blocks: ['vorbis'] },
    })
    expect(result.verification?.status).toBe('remaining')
    expect(result.verification?.remaining).toBeGreaterThan(0)
  })
})