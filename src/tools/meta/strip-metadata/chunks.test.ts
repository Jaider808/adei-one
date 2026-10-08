/**
 * ADEI-ONE — Tests de la cirugía binaria base de "Eliminar metadata"
 * (`chunks.ts`): JPEG, PNG y WebP. Cirugía pura → Node sin canvas/DOM.
 * Los fixtures se construyen byte a byte (igual que en el antiguo image.metadata).
 */
import { describe, expect, it } from 'vitest'
import {
  BLOCK_EXIF,
  BLOCK_ICC,
  BLOCK_TEXT,
  BLOCK_XMP,
  asciiAt,
  concat,
  extractIcc,
  insertJpegIcc,
  listJpegCom,
  listPngChunks,
  listPngText,
  listWebpChunks,
  patchMp4Stco,
  readU32BE,
  stripJpegAllSegments,
  stripJpegMetadata,
  stripPngDeep,
  stripPngMetadata,
  stripWebpMetadata,
} from './chunks'

/* ── Helpers de construcción de fixtures ── */

function ascii(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)))
}

function u16be(n: number): Uint8Array {
  return Uint8Array.from([(n >> 8) & 0xff, n & 0xff])
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

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  return concat([u32be(data.length), ascii(type), data, new Uint8Array(4)])
}

function webpChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 === 1 ? Uint8Array.of(0) : new Uint8Array()
  return concat([ascii(fourcc), u32le(data.length), data, pad])
}

function le32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  )
}

/* ── Fixtures ── */

const JPG_SPEC = concat([
  Uint8Array.of(0xff, 0xd8),
  Uint8Array.of(0xff, 0xe1), u16be(2 + 3), ascii('XYZ'),
  Uint8Array.of(0xff, 0xdb), ascii('KEED'),
  Uint8Array.of(0xff, 0xd9),
])

const JPG_FULL = concat([
  Uint8Array.of(0xff, 0xd8),
  Uint8Array.of(0xff, 0xe1), u16be(2 + 3), ascii('XYZ'),
  Uint8Array.of(0xff, 0xe2), u16be(2 + 3), ascii('QUX'),
  Uint8Array.of(0xff, 0xdb), u16be(2 + 4), ascii('KEED'),
  Uint8Array.of(0xff, 0xd9),
])

const PNG = concat([
  Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  pngChunk('IHDR', new Uint8Array(13)),
  pngChunk('IDAT', ascii('PIXELES')),
  pngChunk('eXIf', ascii('GPS')),
  pngChunk('tEXt', concat([ascii('Autor'), Uint8Array.of(0), ascii('Juan')])),
  pngChunk('IEND', new Uint8Array()),
])

const WEBP = concat([
  ascii('RIFF'),
  u32le(1000),
  ascii('WEBP'),
  webpChunk('EXIF', ascii('GPSDATA')),
  webpChunk('VP8 ', ascii('FRAMEDATA')),
])

/* ── JPEG ── */

describe('stripJpegMetadata', () => {
  it('elimina el segmento APP1 y conserva el resto (fixture de la spec)', () => {
    const out = stripJpegMetadata(JPG_SPEC)
    const txt = textOf(out)
    expect(txt).not.toContain('XYZ')
    expect(txt).toContain('KEED')
    expect(out[out.length - 1]).toBe(0xd9)
  })

  it('lee longitudes y elimina APP1 y APP2 (fixture válido)', () => {
    const out = stripJpegMetadata(JPG_FULL)
    const txt = textOf(out)
    expect(txt).not.toContain('XYZ')
    expect(txt).not.toContain('QUX')
    expect(txt).toContain('KEED')
  })

  it('selectivo: con blocks={icc} elimina APP2-ICC y conserva APP1 (EXIF)', () => {
    const jpg = concat([
      Uint8Array.of(0xff, 0xd8),
      Uint8Array.of(0xff, 0xe1), u16be(2 + 3), ascii('XYZ'),
      Uint8Array.of(0xff, 0xe2), u16be(2 + 13), concat([ascii('ICC_PROFILE'), Uint8Array.of(0), ascii('P')]),
      Uint8Array.of(0xff, 0xdb), ascii('KEED'),
      Uint8Array.of(0xff, 0xd9),
    ])
    const out = stripJpegMetadata(jpg, new Set([BLOCK_ICC]))
    const txt = textOf(out)
    expect(txt).toContain('XYZ') // APP1 no seleccionado → se conserva
    expect(txt).not.toContain('ICC_PROFILE')
    expect(txt).toContain('KEED')
  })
})

/* ── PNG ── */

describe('stripPngMetadata', () => {
  it('conserva firma/IHDR/IDAT/IEND; descarta eXIf y tEXt', () => {
    const out = stripPngMetadata(PNG)
    const txt = textOf(out)
    expect(txt).toContain('IHDR')
    expect(txt).toContain('IDAT')
    expect(txt).toContain('IEND')
    expect(txt).toContain('PIXELES')
    expect(txt).not.toContain('eXIf')
    expect(txt).not.toContain('tEXt')
    expect(txt).not.toContain('GPS')
    expect(txt).not.toContain('Autor')
  })

  it('selectivo: con blocks={text} elimina tEXt y conserva eXIf', () => {
    const out = stripPngMetadata(PNG, new Set([BLOCK_TEXT]))
    const txt = textOf(out)
    expect(txt).not.toContain('tEXt')
    expect(txt).not.toContain('Autor')
    expect(txt).toContain('eXIf')
    expect(txt).toContain('GPS')
  })

  it('listPngText extrae keyword/valor de tEXt', () => {
    const items = listPngText(PNG)
    expect(items.some((t) => t.keyword === 'Autor')).toBe(true)
  })

  it('listPngChunks conserva el orden y los tipos', () => {
    const types = listPngChunks(PNG).map((c) => c.type)
    expect(types).toEqual(['IHDR', 'IDAT', 'eXIf', 'tEXt', 'IEND'])
  })
})

/* ── WebP ── */

describe('stripWebpMetadata', () => {
  it('conserva VP8 , descarta EXIF y re-escribe el tamaño RIFF', () => {
    const out = stripWebpMetadata(WEBP)
    const txt = textOf(out)
    expect(txt).toContain('VP8 ')
    expect(txt).toContain('FRAMEDATA')
    expect(txt).not.toContain('EXIF')
    expect(txt).not.toContain('GPSDATA')
    expect(textOf(out.slice(0, 4))).toBe('RIFF')
    expect(textOf(out.slice(8, 12))).toBe('WEBP')
    expect(le32(out, 4)).toBe(out.length - 8)
  })

  it('selectivo: con blocks={exif} conserva XMP e ICCP', () => {
    const webp = concat([
      ascii('RIFF'), u32le(0), ascii('WEBP'),
      webpChunk('XMP ', ascii('XMLDATA')),
      webpChunk('ICCP', ascii('PROFILEDATA')),
      webpChunk('VP8L', ascii('LOSSLESSDATA')),
    ])
    const out = stripWebpMetadata(webp, new Set([BLOCK_EXIF]))
    const txt = textOf(out)
    expect(txt).toContain('XMP ')
    expect(txt).toContain('ICCP')
    expect(txt).toContain('VP8L')
  })

  it('bytes que no son RIFF/WebP → passthrough', () => {
    const notWebp = ascii('JPEGDATA')
    expect(stripWebpMetadata(notWebp)).toEqual(notWebp)
  })

  it('listWebpChunks enumera fourcc y datos', () => {
    const chunks = listWebpChunks(WEBP)
    expect(chunks.map((c) => c.fourcc)).toEqual(['EXIF', 'VP8 '])
  })
})

/* ── Accesores de scan ── */

describe('listJpegCom', () => {
  it('extrae comentarios COM (0xFE)', () => {
    const jpg = concat([
      Uint8Array.of(0xff, 0xd8),
      Uint8Array.of(0xff, 0xfe), u16be(2 + 5), ascii(' hola'),
      Uint8Array.of(0xff, 0xd9),
    ])
    expect(listJpegCom(jpg)).toEqual(['hola'])
  })
})

/* ── Limpieza profunda (encoders no deben "añadir" metadata) ── */

describe('stripJpegAllSegments', () => {
  it('elimina APP0-JFIF, APP1 y COM; conserva DQT/SOF y el cierre', () => {
    const jpg = concat([
      Uint8Array.of(0xff, 0xd8),
      Uint8Array.of(0xff, 0xe0), u16be(2 + 14), ascii('JFIF\0\x01\x01\0\0\x01\0\x01\0\0'), // APP0
      Uint8Array.of(0xff, 0xe1), u16be(2 + 6), concat([ascii('Exif'), Uint8Array.of(0, 0)]),
      Uint8Array.of(0xff, 0xfe), u16be(2 + 4), ascii(' ola'),
      Uint8Array.of(0xff, 0xdb), u16be(2 + 4), ascii('KEED'), // DQT
      Uint8Array.of(0xff, 0xd9),
    ])
    const out = stripJpegAllSegments(jpg)
    const txt = textOf(out)
    expect(txt).not.toContain('JFIF')
    expect(txt).not.toContain('Exif')
    expect(txt).not.toContain('ola')
    expect(txt).toContain('KEED')
    expect(out[0]).toBe(0xff)
    expect(out[1]).toBe(0xd8)
    expect(out[out.length - 1]).toBe(0xd9)
  })
})

describe('stripPngDeep', () => {
  it('elimina metadata y chunks de color; conserva IHDR/PLTE/IDAT/tRNS/IEND', () => {
    const png = concat([
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      pngChunk('IHDR', new Uint8Array(13)),
      pngChunk('PLTE', new Uint8Array(3)),
      pngChunk('sRGB', ascii('perceptual')),
      pngChunk('gAMA', new Uint8Array(4)),
      pngChunk('tEXt', concat([ascii('Autor'), Uint8Array.of(0), ascii('X')])),
      pngChunk('tRNS', new Uint8Array(1)),
      pngChunk('IDAT', ascii('PIXELES')),
      pngChunk('IEND', new Uint8Array()),
    ])
    const out = stripPngDeep(png)
    const txt = textOf(out)
    expect(txt).toContain('IHDR')
    expect(txt).toContain('PLTE')
    expect(txt).toContain('IDAT')
    expect(txt).toContain('tRNS')
    expect(txt).toContain('IEND')
    expect(txt).toContain('PIXELES')
    expect(txt).not.toContain('sRGB')
    expect(txt).not.toContain('gAMA')
    expect(txt).not.toContain('tEXt')
  })
})

/* ── Remux lossless: parcheo de stco/co64 (ISO-BMFF) ── */

describe('patchMp4Stco', () => {
  it('suma el delta a cada entrada de stco de forma recursiva', () => {
    // moov > trak > mdia > minf > stbl > stco con 2 entradas.
    const entries = concat([u32be(100), u32be(250)])
    const stco = concat([u16be(0), u16be(0), u32be(2), entries]) // fullbox: ver/flags(4)+count(4)
    const stcoBox = concat([u32be(8 + stco.length), ascii('stco'), stco])
    const stbl = concat([u32be(8 + stcoBox.length), ascii('stbl'), stcoBox])
    const minf = concat([u32be(8 + stbl.length), ascii('minf'), stbl])
    const mdia = concat([u32be(8 + minf.length), ascii('mdia'), minf])
    const trak = concat([u32be(8 + mdia.length), ascii('trak'), mdia])
    const moov = concat([u32be(8 + trak.length), ascii('moov'), trak])

    patchMp4Stco(moov, -40)
    // Localizar stco dentro del moov reconstruido.
    const bytes = moov
    const find = (start: number, end: number, type: string, depth: number): number | null => {
      let i = start
      while (i + 8 <= end) {
        const size = readU32BE(bytes, i)
        if (asciiAt(bytes, i + 4) === type) return i
        if (depth > 0 && size >= 8 && i + size <= end) {
          const found = find(i + 8, i + size, type, depth - 1)
          if (found !== null) return found
        }
        i += size
      }
      return null
    }
    const stcoOffset = find(0, bytes.length, 'stco', 6)
    expect(stcoOffset).not.toBeNull()
    if (stcoOffset === null) return
    const dataStart = stcoOffset + 8
    expect(readU32BE(bytes, dataStart + 8)).toBe(60)
    expect(readU32BE(bytes, dataStart + 12)).toBe(210)
  })
})

describe('selective exif/xmp/icc', () => {
  it('con blocks={exif} borra APP1-EXIF y conserva COM', () => {
    const jpg = concat([
      Uint8Array.of(0xff, 0xd8),
      Uint8Array.of(0xff, 0xe1), u16be(2 + 6), concat([ascii('Exif'), Uint8Array.of(0, 0)]),
      Uint8Array.of(0xff, 0xfe), u16be(2 + 4), ascii(' ola'),
      Uint8Array.of(0xff, 0xd9),
    ])
    const out = stripJpegMetadata(jpg, new Set([BLOCK_EXIF]))
    const txt = textOf(out)
    expect(txt).not.toContain('Exif')
    expect(txt).toContain('ola')
  })

  it('con blocks={xmp} borra APP1-XMP', () => {
    const payload = concat([ascii('http://ns.adobe.com/xap/1.0/'), Uint8Array.of(0), ascii('X')])
    const jpg = concat([
      Uint8Array.of(0xff, 0xd8),
      Uint8Array.of(0xff, 0xe1), u16be(2 + payload.length), payload,
      Uint8Array.of(0xff, 0xd9),
    ])
    const txt = textOf(stripJpegMetadata(jpg, new Set([BLOCK_XMP])))
    expect(txt).not.toContain('ns.adobe.com')
  })
})

it('BLOCK_ICC y BLOCK_TEXT existen', () => {
  expect(BLOCK_ICC).toBe('icc')
  expect(BLOCK_TEXT).toBe('text')
})

/* ── Perfil ICC: extraer y re-insertar (se conserva) ── */

describe('perfil ICC JPEG', () => {
  const PROFILE = ascii('PROFILE-BYTES-1234')

  it('extractIcc recupera el perfil de los segmentos APP2', () => {
    const original = concat([
      Uint8Array.of(0xff, 0xd8),
      Uint8Array.of(0xff, 0xe2), u16be(2 + 14 + PROFILE.length),
      concat([ascii('ICC_PROFILE'), Uint8Array.of(0), Uint8Array.of(1, 1), PROFILE]),
      Uint8Array.of(0xff, 0xdb), ascii('KEED'),
      Uint8Array.of(0xff, 0xd9),
    ])
    expect(extractIcc(original, 'jpg')).toEqual(PROFILE)
  })

  it('insertJpegIcc re-inserta el perfil y conserva el contenido', () => {
    const cleaned = concat([
      Uint8Array.of(0xff, 0xd8),
      Uint8Array.of(0xff, 0xdb), ascii('KEED'),
      Uint8Array.of(0xff, 0xd9),
    ])
    const out = insertJpegIcc(cleaned, PROFILE)
    expect(extractIcc(out, 'jpg')).toEqual(PROFILE)
    expect(textOf(out)).toContain('KEED')
    expect(out[0]).toBe(0xff)
    expect(out[1]).toBe(0xd8)
  })
})