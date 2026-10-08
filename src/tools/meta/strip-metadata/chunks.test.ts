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
  insertWebpIcc,
  listJpegCom,
  listPngChunks,
  listPngText,
  listWebpChunks,
  minimalOrientationExif,
  minimalOrientationTiff,
  patchMp4Stco,
  readU16BE,
  readU32BE,
  reinjectOrientation,
  stripJpegAllSegments,
  stripJpegMetadata,
  stripJpegMetadataKeepingExif,
  stripPngDeep,
  stripPngMetadata,
  stripPngMetadataKeepingExif,
  stripWebpMetadata,
  stripWebpMetadataKeepingExif,
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

describe('perfil ICC WebP', () => {
  const PROFILE = ascii('PROFILE-BYTES-1234')

  it('insertWebpIcc pone VP8X primero y el ICCP antes de los píxeles', () => {
    const cleaned = concat([
      ascii('RIFF'), u32le(0), ascii('WEBP'),
      webpChunk('VP8X', ascii('EXTENDED')),
      webpChunk('VP8 ', ascii('FRAMEDATA')),
    ])
    const out = insertWebpIcc(cleaned, PROFILE)
    const chunks = listWebpChunks(out)
    // libwebp solo omite chunks opcionales si VP8X es el PRIMER chunk; el ICCP
    // (perfil de color) va después de VP8X y antes de los datos de imagen.
    expect(chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'ICCP', 'VP8 '])
    expect(chunks.find((c) => c.fourcc === 'ICCP')?.data).toEqual(PROFILE)
    expect(le32(out, 4)).toBe(out.length - 8)
    expect(extractIcc(out, 'webp')).toEqual(PROFILE)
  })

  it('WebP simple sin VP8X: el ICCP nunca queda como primer chunk', () => {
    const cleaned = concat([ascii('RIFF'), u32le(0), ascii('WEBP'), webpChunk('VP8L', ascii('LOSSLESSDATA'))])
    const out = insertWebpIcc(cleaned, PROFILE)
    const chunks = listWebpChunks(out)
    expect(chunks.map((c) => c.fourcc)).toEqual(['VP8L', 'ICCP'])
    expect(chunks[0].fourcc).not.toBe('ICCP')
    expect(le32(out, 4)).toBe(out.length - 8)
    expect(extractIcc(out, 'webp')).toEqual(PROFILE)
  })
})

/* ── EXIF mínimo (orientación conservada sin re-codificar) ── */

/** TIFF de referencia: byte order + magic 42 + IFD0 en 8 + una entrada Orientation. */
function tiffHeader(order: 'II' | 'MM'): Uint8Array {
  return order === 'II'
    ? concat([ascii('II'), Uint8Array.of(0x2a, 0x00), Uint8Array.of(8, 0, 0, 0)])
    : concat([ascii('MM'), Uint8Array.of(0x00, 0x2a), Uint8Array.of(0, 0, 0, 8)])
}

describe('minimalOrientationTiff', () => {
  it('little-endian: una sola entrada IFD0 con Orientation en los 2 primeros bytes del valor', () => {
    const tiff = minimalOrientationTiff(6, 'II')
    expect(tiff.length).toBe(26) // cabecera(8) + nº entradas(2) + entrada(12) + siguiente IFD(4)
    expect(tiff.slice(0, 8)).toEqual(tiffHeader('II'))
    expect(tiff[8] | (tiff[9] << 8)).toBe(1) // 1 entrada
    expect(tiff[10] | (tiff[11] << 8)).toBe(0x0112) // tag Orientation
    expect(tiff[12] | (tiff[13] << 8)).toBe(3) // tipo SHORT
    expect(le32(tiff, 14)).toBe(1) // count
    expect(tiff[18] | (tiff[19] << 8)).toBe(6) // valor en los 2 primeros bytes
    expect(tiff[20]).toBe(0)
    expect(tiff[21]).toBe(0)
    expect(le32(tiff, 22)).toBe(0) // siguiente IFD: ninguno
  })

  it('big-endian: conserva MM y escribe el valor en big-endian', () => {
    const tiff = minimalOrientationTiff(8, 'MM')
    expect(tiff.length).toBe(26)
    expect(tiff.slice(0, 8)).toEqual(tiffHeader('MM'))
    expect(readU16BE(tiff, 8)).toBe(1)
    expect(readU16BE(tiff, 10)).toBe(0x0112)
    expect(readU16BE(tiff, 12)).toBe(3)
    expect(readU32BE(tiff, 14)).toBe(1)
    expect(readU16BE(tiff, 18)).toBe(8)
    expect(readU32BE(tiff, 22)).toBe(0)
  })
})

describe('minimalOrientationExif', () => {
  it('conserva el byte order y el prefijo Exif\\0\\0 cuando el original lo llevaba', () => {
    const original = concat([ascii('Exif'), Uint8Array.of(0, 0), tiffHeader('II')])
    const minimal = minimalOrientationExif(original, 6)
    expect(minimal).not.toBeNull()
    expect(textOf(minimal!.slice(0, 6))).toBe('Exif\x00\x00')
    expect(minimal!.slice(6, 14)).toEqual(tiffHeader('II'))
    expect(minimal!.length).toBe(6 + 26)
  })

  it('sin prefijo (WebP/PNG): devuelve solo el TIFF', () => {
    const minimal = minimalOrientationExif(tiffHeader('MM'), 3)
    expect(minimal).not.toBeNull()
    expect(minimal!.length).toBe(26)
    expect(textOf(minimal!.slice(0, 2))).toBe('MM')
  })

  it('datos no reconocibles → null (nunca lanza)', () => {
    expect(minimalOrientationExif(ascii('no-exif'), 6)).toBeNull()
  })
})

describe('stripJpegMetadataKeepingExif', () => {
  it('sustituye el APP1-EXIF por el mínimo y conserva el resto byte a byte', () => {
    const original = concat([
      Uint8Array.of(0xff, 0xd8),
      Uint8Array.of(0xff, 0xe1), u16be(2 + 8), concat([ascii('Exif'), Uint8Array.of(0, 0), tiffHeader('II')]),
      Uint8Array.of(0xff, 0xdb), u16be(2 + 4), ascii('KEED'),
      Uint8Array.of(0xff, 0xd9),
    ])
    const minimal = minimalOrientationExif(concat([ascii('Exif'), Uint8Array.of(0, 0), tiffHeader('II')]), 6)!
    const out = stripJpegMetadataKeepingExif(original, new Set([BLOCK_EXIF]), minimal)
    expect(textOf(out)).toContain('KEED')
    expect(out[0]).toBe(0xff)
    expect(out[1]).toBe(0xd8)
    expect(out[out.length - 1]).toBe(0xd9)
    // El EXIF conservado es solo el mínimo, con su prefijo y byte order.
    expect(textOf(out).slice(6, 12)).toBe('Exif\x00\x00')
    expect(textOf(out).slice(12, 14)).toBe('II')
  })

  it('sin mínimo o sin bloque EXIF delega en la cirugía normal', () => {
    const realExif = concat([
      Uint8Array.of(0xff, 0xd8),
      Uint8Array.of(0xff, 0xe1), u16be(2 + 8), concat([ascii('Exif'), Uint8Array.of(0, 0), tiffHeader('II')]),
      Uint8Array.of(0xff, 0xd9),
    ])
    const out = stripJpegMetadataKeepingExif(realExif, new Set([BLOCK_EXIF]), null)
    expect(textOf(out)).not.toContain('Exif')
  })
})

describe('stripWebpMetadataKeepingExif', () => {
  it('sustituye el chunk EXIF por el mínimo y re-escribe el tamaño RIFF', () => {
    const minimal = minimalOrientationExif(tiffHeader('II'), 6)!
    const out = stripWebpMetadataKeepingExif(WEBP, new Set([BLOCK_EXIF]), minimal)
    expect(textOf(out)).toContain('VP8 ')
    expect(textOf(out)).toContain('FRAMEDATA')
    expect(le32(out, 4)).toBe(out.length - 8)
    // El chunk EXIF ya no contiene el payload original ('GPSDATA').
    expect(textOf(out)).not.toContain('GPSDATA')
    expect(textOf(out)).toContain('EXIF')
  })
})

describe('stripPngMetadataKeepingExif', () => {
  it('sustituye el chunk eXIf por el mínimo y conserva IDAT', () => {
    const minimal = minimalOrientationExif(tiffHeader('II'), 6)!
    const out = stripPngMetadataKeepingExif(PNG, new Set([BLOCK_EXIF]), minimal)
    expect(textOf(out)).toContain('IDAT')
    expect(textOf(out)).toContain('PIXELES')
    expect(textOf(out)).toContain('eXIf')
    expect(textOf(out)).not.toContain('GPS')
    // El CRC del chunk reescrito debe ser correcto (listPngChunks lo relee).
    expect(listPngChunks(out).map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'eXIf', 'tEXt', 'IEND'])
  })
})

/* ── Re-inyección de orientación tras re-encodear (deep) ── */

describe('reinjectOrientation', () => {
  it('sin orientación (undefined o 1) devuelve los bytes sin tocar', () => {
    expect(reinjectOrientation(JPG_SPEC, 'jpg', undefined)).toEqual(JPG_SPEC)
    expect(reinjectOrientation(JPG_SPEC, 'jpg', 1)).toEqual(JPG_SPEC)
  })

  it('JPEG sin EXIF: añade un APP1 mínimo con solo Orientation y no toca el resto', async () => {
    const jpeg = concat([
      Uint8Array.of(0xff, 0xd8),
      Uint8Array.of(0xff, 0xdb), u16be(2 + 4), ascii('KEED'),
      Uint8Array.of(0xff, 0xd9),
    ])
    const out = reinjectOrientation(jpeg, 'jpg', 6)

    // Cabecera EXIF mínima justo tras el SOI.
    expect(out[0]).toBe(0xff)
    expect(out[1]).toBe(0xd8)
    expect(out[2]).toBe(0xff)
    expect(out[3]).toBe(0xe1)
    // El payload del APP1 (tras marcador y longitud) empieza con 'Exif\0\0'.
    expect(textOf(out.slice(6, 12))).toBe('Exif\x00\x00')

    // El resto del archivo queda byte a byte idéntico (solo se insertó el APP1).
    const injectedLen = out.length - jpeg.length
    expect(injectedLen).toBeGreaterThan(0)
    expect(concat([out.slice(0, 2), out.slice(2 + injectedLen)])).toEqual(jpeg)

    // Se relee el único tag Orientation, con su valor.
    const exifr = await import('exifr')
    const parsed = (await exifr.parse(out, { translateValues: false })) as Record<string, unknown> | undefined
    expect(parsed?.['Orientation']).toBe(6)
    expect(parsed?.['Make']).toBeUndefined()
  })

  it('PNG sin EXIF: añade un chunk eXIf mínimo tras IHDR y conserva IDAT/IEND', async () => {
    const png = concat([
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
      pngChunk('IHDR', new Uint8Array(13)),
      pngChunk('IDAT', ascii('PIXELES')),
      pngChunk('IEND', new Uint8Array()),
    ])
    const out = reinjectOrientation(png, 'png', 8)

    const chunks = listPngChunks(out)
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'eXIf', 'IDAT', 'IEND'])
    expect(chunks.find((c) => c.type === 'IDAT')?.data).toEqual(ascii('PIXELES'))

    const exifr = await import('exifr')
    const parsed = (await exifr.parse(out, { translateValues: false })) as Record<string, unknown> | undefined
    expect(parsed?.['Orientation']).toBe(8)
  })

  it('WebP simple sin VP8X: los píxeles van primero y el EXIF después (decodificable)', async () => {
    const webp = concat([ascii('RIFF'), u32le(0), ascii('WEBP'), webpChunk('VP8 ', ascii('FRAMEDATA'))])
    const out = reinjectOrientation(webp, 'webp', 6)

    expect(textOf(out)).toContain('VP8 ')
    expect(textOf(out)).toContain('FRAMEDATA')
    const chunks = listWebpChunks(out)
    // libwebp solo omite chunks opcionales si VP8X es el PRIMER chunk; sin VP8X
    // los píxeles deben ir primero o el decoder trata el EXIF como bitstream.
    expect(chunks.map((c) => c.fourcc)).toEqual(['VP8 ', 'EXIF'])
    expect(chunks[0].fourcc).not.toBe('EXIF')
    expect(le32(out, 4)).toBe(out.length - 8)

    const exifr = await import('exifr')
    const exifChunk = chunks.find((c) => c.fourcc === 'EXIF')!
    const parsed = (await exifr.parse(exifChunk.data, { translateValues: false })) as Record<string, unknown> | undefined
    expect(parsed?.['Orientation']).toBe(6)
  })

  it('WebP con VP8X: VP8X primero y el EXIF después de los datos de imagen', async () => {
    const webp = concat([
      ascii('RIFF'), u32le(0), ascii('WEBP'),
      webpChunk('VP8X', ascii('EXTENDED')),
      webpChunk('VP8 ', ascii('FRAMEDATA')),
    ])
    const out = reinjectOrientation(webp, 'webp', 8)

    const chunks = listWebpChunks(out)
    expect(chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'VP8 ', 'EXIF'])
    expect(chunks[0].fourcc).toBe('VP8X')
    expect(le32(out, 4)).toBe(out.length - 8)

    const exifr = await import('exifr')
    const parsed = (await exifr.parse(chunks[chunks.length - 1].data, { translateValues: false })) as Record<string, unknown> | undefined
    expect(parsed?.['Orientation']).toBe(8)
  })
})