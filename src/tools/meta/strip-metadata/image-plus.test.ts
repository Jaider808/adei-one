/**
 * ADEI-ONE — Tests del dominio IMAGEN EXTRA de "Eliminar metadata"
 * (`image-plus.ts`): gif, tiff y heic. Igual que `chunks.test.ts`, los
 * fixtures se construyen byte a byte (cirugía binaria pura, Node sin DOM).
 * Incluye un test de integración con el engine (`../engine`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { imagePlusDomain } from './image-plus'
import { stripMetadata } from './engine'

/**
 * `exifr` simulado: el HEIC de juguete no es un ISO-BMFF parseable (exifr real
 * lanza "Unknown file format"), así que su salida se controla por test. Por
 * defecto no devuelve nada → mismo comportamiento que el exifr real con bytes
 * de juguete (el resto de tests de HEIC no dependen de él).
 */
const exifrMock = vi.hoisted(() => ({ parse: vi.fn() }))
vi.mock('exifr', () => exifrMock)

/* ── Ayudantes de construcción de fixtures ── */

function ascii(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)))
}

function u32be(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function u16le(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >> 8) & 0xff])
}

function u32le(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])
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

function le32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
  )
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/* ── Fixtures ── */

/** GIF89a: comentario + extensión de aplicación XMP + imagen LZW + trailer. */
function gifFixture(): Uint8Array {
  return concat([
    ascii('GIF89a'),
    u16le(1), u16le(1), Uint8Array.of(0x00, 0x00, 0x00), // Logical Screen Descriptor
    Uint8Array.of(0x21, 0xfe), Uint8Array.of(10), ascii('HOLA MUNDO'), Uint8Array.of(0x00), // comentario
    Uint8Array.of(0x21, 0xff), Uint8Array.of(11), ascii('XMP DataXMP'), Uint8Array.of(12), ascii('<x:xmpmeta/>'), Uint8Array.of(0x00), // XMP
    Uint8Array.of(0x2c), // descriptor de imagen
    u16le(0), u16le(0), u16le(1), u16le(1), Uint8Array.of(0x00),
    Uint8Array.of(0x02), // tamaño mínimo de código LZW
    Uint8Array.of(3), ascii('abc'), // datos LZW
    Uint8Array.of(0x00),
    Uint8Array.of(0x3b), // trailer
  ])
}

/** GIF89a: paleta global (0xF0) + DOS descriptores de imagen (bloque 'format'). */
function gifWithPaletteFixture(): Uint8Array {
  return concat([
    ascii('GIF89a'),
    u16le(320), u16le(240), Uint8Array.of(0xf0, 0x00, 0x00), // LSD: GCT + resolución 8 bits
    Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x00, 0x00), // GCT (2 entradas = 6 bytes)
    Uint8Array.of(0x2c), u16le(0), u16le(0), u16le(10), u16le(10), Uint8Array.of(0x00),
    Uint8Array.of(0x02), Uint8Array.of(2), ascii('ab'), Uint8Array.of(0x00), // imagen 1
    Uint8Array.of(0x2c), u16le(0), u16le(0), u16le(10), u16le(10), Uint8Array.of(0x00),
    Uint8Array.of(0x02), Uint8Array.of(2), ascii('cd'), Uint8Array.of(0x00), // imagen 2
    Uint8Array.of(0x3b), // trailer
  ])
}

/** GIF89a con DIEZ comentarios: prueba que ya no hay tope de 8. */
function gifManyCommentsFixture(): Uint8Array {
  const parts: Uint8Array[] = [
    ascii('GIF89a'),
    u16le(1), u16le(1), Uint8Array.of(0x00, 0x00, 0x00), // Logical Screen Descriptor
  ]
  for (let i = 1; i <= 10; i++) {
    const text = ascii(`COMENTARIO ${i}`)
    parts.push(Uint8Array.of(0x21, 0xfe), Uint8Array.of(text.length), text, Uint8Array.of(0x00))
  }
  parts.push(Uint8Array.of(0x3b)) // trailer
  return concat(parts)
}

/** Entrada TIFF de 12 bytes (little endian). */
function tiffEntry(tag: number, type: number, count: number, value: number): Uint8Array {
  return concat([u16le(tag), u16le(type), u32le(count), u32le(value)])
}

/** TIFF little-endian: Make/Model + puntero GPS + StripOffsets → "IMGDATA". */
function tiffFixture(): Uint8Array {
  const make = ascii('NIKON\0')
  const model = ascii('D850\0')
  const img = ascii('IMGDATA')
  const ifd = concat([
    u16le(4),
    tiffEntry(0x010f, 2, make.length, 62), // Make → 62
    tiffEntry(0x0110, 2, model.length, 68), // Model → 68
    tiffEntry(0x8825, 4, 1, 0), // puntero GPS (sin sub-IFD)
    tiffEntry(0x0111, 4, 1, 73), // StripOffsets → 73
    u32le(0), // siguiente IFD: ninguno
  ])
  // IFD en offset 8: 2 + 4*12 + 4 = 54 bytes → termina en 62. Datos: 62/68/73.
  return concat([ascii('II'), Uint8Array.of(42, 0), u32le(8), ifd, make, model, img])
}

/** TIFF little-endian con un tag privado/desconocido (0xC4A5) además de Make. */
function tiffUnknownTagFixture(): Uint8Array {
  const make = ascii('NIKON\0')
  const ifd = concat([
    u16le(2),
    tiffEntry(0x010f, 2, make.length, 38), // Make → 38
    tiffEntry(0xc4a5, 3, 1, 7), // tag privado no mapeado
    u32le(0), // siguiente IFD: ninguno
  ])
  // IFD en offset 8: 2 + 2*12 + 4 = 30 bytes → termina en 38. Make en 38.
  return concat([ascii('II'), Uint8Array.of(42, 0), u32le(8), ifd, make])
}

/** TIFF little-endian con tags ESTRUCTURALES del IFD0 (bloque 'format'). */
function tiffFormatFixture(): Uint8Array {
  const make = ascii('NIKON\0')
  const bits = Uint8Array.of(8, 0, 8, 0, 8, 0) // BitsPerSample: 8, 8, 8 (SHORTs LE)
  const bitsOffset = 74 + make.length // 80
  const ifd = concat([
    u16le(5),
    tiffEntry(0x0100, 3, 1, 4000), // ImageWidth → 4000
    tiffEntry(0x0101, 3, 1, 3000), // ImageLength → 3000
    tiffEntry(0x0102, 3, 3, bitsOffset), // BitsPerSample → 80
    tiffEntry(0x0103, 3, 1, 1), // Compression → 1
    tiffEntry(0x010f, 2, make.length, 74), // Make → 74
    u32le(0), // siguiente IFD: ninguno
  ])
  // IFD en offset 8: 2 + 5*12 + 4 = 66 bytes → termina en 74. Datos: Make 74, Bits 80.
  return concat([ascii('II'), Uint8Array.of(42, 0), u32le(8), ifd, make, bits])
}

/** Caja ISO-BMFF de nivel superior (size 4BE + type 4 + datos). */
function isoBox(type: string, data: Uint8Array): Uint8Array {
  return concat([u32be(8 + data.length), ascii(type), data])
}

/** HEIC de juguete: ftyp + meta + free + uuid + mdat. */
function heicFixture(): Uint8Array {
  return concat([
    isoBox('ftyp', ascii('heic')),
    isoBox('meta', ascii('ITEMS')),
    isoBox('free', ascii('JUNKDATA')),
    isoBox('uuid', ascii('EXIFDATA')),
    isoBox('mdat', ascii('PIXELS')),
  ])
}

/** Ejecuta el strip del dominio como helper síncrono. */
function stripSync(
  bytes: Uint8Array,
  kind: 'gif' | 'tiff' | 'heic',
  config: { mode: 'light' | 'deep'; blocks: string[] },
): Promise<Uint8Array> {
  return imagePlusDomain.strip(bytes, kind, config, () => {})
}

/** Busca una entrada en el IFD little-endian de un TIFF. */
function findTiffEntry(
  bytes: Uint8Array,
  tag: number,
): { type: number; count: number; value: number } | null {
  if (bytes.length < 10) return null
  const count = bytes[8] | (bytes[9] << 8)
  for (let i = 0; i < count; i++) {
    const base = 10 + i * 12
    if (base + 12 > bytes.length) return null
    const t = bytes[base] | (bytes[base + 1] << 8)
    if (t === tag) {
      return {
        type: bytes[base + 2] | (bytes[base + 3] << 8),
        count: le32(bytes, base + 4),
        value: le32(bytes, base + 8),
      }
    }
  }
  return null
}

/* ── Dominio ── */

describe('imagePlusDomain', () => {
  it('declara los kinds de imagen extra', () => {
    expect(imagePlusDomain.kinds).toEqual(['gif', 'tiff', 'heic'])
  })
})

/* ── GIF ── */

describe('gif', () => {
  it('scan: ve el comentario (text) y la extensión XMP', async () => {
    const report = await imagePlusDomain.scan(gifFixture())
    const ids = report.blocks.map((b) => b.id)
    expect(ids).toContain('text')
    expect(ids).toContain('xmp')
    expect(report.fields.some((f) => f.name === 'Comentario' && f.value === 'HOLA MUNDO')).toBe(true)
  })

  it('scan: enumera TODOS los comentarios (sin tope de 8) con su ruta real', async () => {
    const report = await imagePlusDomain.scan(gifManyCommentsFixture())
    const comments = report.entries.filter((e) => e.where === 'GIF > Comentario')
    expect(comments).toHaveLength(10)
    expect(comments.map((e) => e.value)).toContain('COMENTARIO 10')
    expect(comments.every((e) => e.removal === 'with-container')).toBe(true)
  })

  it('scan: la extensión XMP se lista como entrada con su ruta', async () => {
    const report = await imagePlusDomain.scan(gifFixture())
    const xmp = report.entries.find((e) => e.where === 'XMP')
    expect(xmp).toBeDefined()
    expect(xmp?.removal).toBe('with-container')
  })

  it('light blocks=["text"]: quita el comentario y conserva XMP e imagen', async () => {
    const out = await stripSync(gifFixture(), 'gif', { mode: 'light', blocks: ['text'] })
    const txt = textOf(out)
    expect(txt).not.toContain('HOLA MUNDO')
    expect(txt).toContain('XMP DataXMP')
    expect(txt).toContain('abc')
    expect(out[out.length - 1]).toBe(0x3b)
  })

  it('light blocks=[]: passthrough idéntico', async () => {
    const src = gifFixture()
    const out = await stripSync(src, 'gif', { mode: 'light', blocks: [] })
    expect(sameBytes(out, src)).toBe(true)
  })

  it('deep: quita text y xmp y conserva el trailer', async () => {
    const out = await stripSync(gifFixture(), 'gif', { mode: 'deep', blocks: [] })
    const txt = textOf(out)
    expect(txt).not.toContain('HOLA MUNDO')
    expect(txt).not.toContain('XMP DataXMP')
    expect(txt).toContain('abc')
    expect(out[out.length - 1]).toBe(0x3b)
  })

  it('strip nunca lanza con bytes no-GIF (mensaje fase próxima)', async () => {
    const junk = ascii('NO ES UN GIF')
    let phase = ''
    const out = await imagePlusDomain.strip(junk, 'gif', { mode: 'light', blocks: ['text'] }, (p) => {
      phase = p
    })
    expect(sameBytes(out, junk)).toBe(true)
    expect(phase).toMatch(/fase próxima/)
  })

  it('scan: el bloque técnico "format" existe, es "never" y text/xmp son "light"', async () => {
    const report = await imagePlusDomain.scan(gifFixture())
    const format = report.blocks.find((b) => b.id === 'format')
    expect(format).toBeDefined()
    expect(format?.removableIn).toBe('never')
    expect(format?.fields.every((f) => f.sensitivity === 'low')).toBe(true)
    const vals = Object.fromEntries((format?.fields ?? []).map((f) => [f.name, f.value]))
    expect(vals['Ancho (px)']).toBe('1')
    expect(vals['Alto (px)']).toBe('1')
    expect(vals['Resolución de color']).toMatch(/bits por color/)
    expect(vals['Paleta global']).toBe('No')
    expect(vals['Imágenes']).toBe('1')
    // text/xmp siguen borrándose en modo ligero.
    expect(report.blocks.find((b) => b.id === 'text')?.removableIn).toBe('light')
    expect(report.blocks.find((b) => b.id === 'xmp')?.removableIn).toBe('light')
  })

  it('scan: "format" cuenta varias imágenes y detecta la paleta global', async () => {
    const report = await imagePlusDomain.scan(gifWithPaletteFixture())
    const format = report.blocks.find((b) => b.id === 'format')
    const vals = Object.fromEntries((format?.fields ?? []).map((f) => [f.name, f.value]))
    expect(vals['Ancho (px)']).toBe('320')
    expect(vals['Alto (px)']).toBe('240')
    expect(vals['Paleta global']).toBe('Sí')
    expect(vals['Resolución de color']).toBe('8 bits por color')
    expect(vals['Imágenes']).toBe('2')
  })
})

/* ── TIFF ── */

describe('tiff', () => {
  it('scan: traduce Make/Model a Fabricante/Modelo', async () => {
    const report = await imagePlusDomain.scan(tiffFixture())
    const names = report.fields.map((f) => f.name)
    expect(names).toContain('Fabricante')
    expect(names).toContain('Modelo')
    const make = report.fields.find((f) => f.name === 'Fabricante')
    expect(make?.value).toBe('NIKON')
    expect(report.blocks.some((b) => b.id === 'exif')).toBe(true)
  })

  it('scan: enumera un tag TIFF desconocido con su id hex y su ruta IFD', async () => {
    const report = await imagePlusDomain.scan(tiffUnknownTagFixture())
    const unknown = report.entries.find((e) => e.key === '0xC4A5')
    expect(unknown).toBeDefined()
    expect(unknown?.where).toBe('IFD0 > Tag 0xC4A5')
    expect(unknown?.label).toBeUndefined()
    expect(unknown?.removal).toBe('never')
    const make = report.entries.find((e) => e.key === '0x010F')
    expect(make?.label).toBe('Fabricante')
    expect(make?.where).toBe('IFD0 > Tag 0x010F')
    expect(make?.removal).toBe('with-container')
  })

  it('light blocks=["exif"]: elimina Make/Model, conserva IMGDATA y recalcula el offset', async () => {
    const out = await stripSync(tiffFixture(), 'tiff', { mode: 'light', blocks: ['exif'] })
    expect(textOf(out)).toContain('IMGDATA')
    // Re-escaneo del resultado: ya no hay metadatos de cámara.
    const rescan = await imagePlusDomain.scan(out)
    const names = rescan.fields.map((f) => f.name)
    expect(names).not.toContain('Fabricante')
    expect(names).not.toContain('Modelo')
    // El IFD reescrito sigue apuntando al marcador ASCII (delta −36: 73 → 37).
    const strip = findTiffEntry(out, 0x0111)
    expect(strip?.value).toBe(37)
    expect(textOf(out.slice(37, 37 + 7))).toBe('IMGDATA')
  })

  it('deep: mismo borrado lossless que light exif', async () => {
    const out = await stripSync(tiffFixture(), 'tiff', { mode: 'deep', blocks: [] })
    const strip = findTiffEntry(out, 0x0111)
    expect(strip?.value).toBe(37)
    expect(textOf(out.slice(37, 37 + 7))).toBe('IMGDATA')
  })

  it('el output sigue siendo un TIFF válido (cabecera + IFD compacto)', async () => {
    const out = await stripSync(tiffFixture(), 'tiff', { mode: 'light', blocks: ['exif'] })
    expect(out[0]).toBe(0x49)
    expect(out[1]).toBe(0x49)
    expect(out[2]).toBe(42)
    expect(out[3]).toBe(0)
    const count = out[8] | (out[9] << 8)
    expect(count).toBe(1)
    expect(findTiffEntry(out, 0x010f)).toBeNull() // Make eliminado
    expect(findTiffEntry(out, 0x0110)).toBeNull() // Model eliminado
  })

  it('light blocks=[]: passthrough idéntico', async () => {
    const src = tiffFixture()
    const out = await stripSync(src, 'tiff', { mode: 'light', blocks: [] })
    expect(sameBytes(out, src)).toBe(true)
  })

  it('scan: bloque "format" con tags estructurales del IFD0 y exif "light"', async () => {
    const report = await imagePlusDomain.scan(tiffFormatFixture())
    const format = report.blocks.find((b) => b.id === 'format')
    expect(format).toBeDefined()
    expect(format?.removableIn).toBe('never')
    expect(format?.fields.every((f) => f.sensitivity === 'low')).toBe(true)
    const vals = Object.fromEntries((format?.fields ?? []).map((f) => [f.name, f.value]))
    expect(vals['Ancho']).toBe('4000')
    expect(vals['Alto']).toBe('3000')
    expect(vals['Bits por muestra']).toBe('8, 8, 8')
    expect(vals['Compresión']).toBe('1')
    const exif = report.blocks.find((b) => b.id === 'exif')
    expect(exif?.removableIn).toBe('light')
    // Make → exif; los tags estructurales NO se repiten en 'exif'.
    expect(exif?.fields.some((f) => f.name === 'Fabricante')).toBe(true)
    expect(exif?.fields.some((f) => f.name === 'Ancho')).toBe(false)
  })
})

/* ── HEIC ── */

describe('heic', () => {
  afterEach(() => exifrMock.parse.mockReset())

  it('deep: quita free/uuid y conserva ftyp/meta/mdat', async () => {
    const out = await stripSync(heicFixture(), 'heic', { mode: 'deep', blocks: [] })
    const txt = textOf(out)
    expect(txt).toContain('ftyp')
    expect(txt).toContain('meta')
    expect(txt).toContain('mdat')
    expect(txt).toContain('PIXELS')
    expect(txt).not.toContain('JUNKDATA')
    expect(txt).not.toContain('EXIFDATA')
  })

  it('light blocks=["exif"]: quita free/uuid y conserva el resto', async () => {
    const out = await stripSync(heicFixture(), 'heic', { mode: 'light', blocks: ['exif'] })
    const txt = textOf(out)
    expect(txt).toContain('ftyp')
    expect(txt).toContain('ITEMS')
    expect(txt).toContain('PIXELS')
    expect(txt).not.toContain('JUNKDATA')
    expect(txt).not.toContain('EXIFDATA')
  })

  it('light blocks=[]: passthrough idéntico', async () => {
    const src = heicFixture()
    const out = await stripSync(src, 'heic', { mode: 'light', blocks: [] })
    expect(sameBytes(out, src)).toBe(true)
  })

  it('regresión: heic mantiene el layout byte a byte (free del mismo tamaño → iloc válido)', async () => {
    const src = heicFixture()
    const out = await stripSync(src, 'heic', { mode: 'deep', blocks: [] })
    // Mismo largo y mdat en la MISMA posición: los offsets absolutos de `iloc`
    // siguen apuntando a los items (antes esto desplazaba mdat y rompía la foto).
    expect(out.length).toBe(src.length)
    const indexOf = (hay: Uint8Array, needle: Uint8Array): number => {
      outer: for (let i = 0; i + needle.length <= hay.length; i++) {
        for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
        return i
      }
      return -1
    }
    expect(indexOf(out, ascii('PIXELS'))).toBe(indexOf(src, ascii('PIXELS')))
    expect(indexOf(out, ascii('mdat'))).toBe(indexOf(src, ascii('mdat')))
  })

  it('scan nunca lanza con bytes basura', async () => {
    const junk = Uint8Array.from([0x00, 0x01, 0xfe, 0xff, 0x44, 0x00, 0x11, 0xaa])
    const report = await imagePlusDomain.scan(junk)
    expect(report).toBeDefined()
    expect(report.count).toBe(0)
  })

  it('scan: bloque "format" con la marca principal del ftyp (nunca se borra)', async () => {
    const report = await imagePlusDomain.scan(heicFixture())
    const format = report.blocks.find((b) => b.id === 'format')
    expect(format).toBeDefined()
    expect(format?.removableIn).toBe('never')
    expect(format?.fields.some((f) => f.name === 'Marca principal' && f.value === 'heic')).toBe(true)
  })

  it('scan: "format" lista las marcas compatibles del ftyp', async () => {
    const src = concat([
      isoBox('ftyp', concat([ascii('mif1'), u32be(0), ascii('mif1'), ascii('heic'), ascii('avif')])),
      isoBox('mdat', ascii('PIXELS')),
    ])
    const report = await imagePlusDomain.scan(src)
    const format = report.blocks.find((b) => b.id === 'format')
    expect(format?.removableIn).toBe('never')
    expect(format?.fields.find((f) => f.name === 'Marca principal')?.value).toBe('mif1')
    expect(format?.fields.find((f) => f.name === 'Marcas compatibles')?.value).toBe('mif1, heic, avif')
  })

  it('scan: el EXIF dentro de `meta` no promete borrado (never) y el namespace xmp por defecto se enumera', async () => {
    // exifr real no puede leer el HEIC de juguete: se simula su salida estructurada.
    exifrMock.parse.mockImplementation(async (_bytes: unknown, options?: unknown) => {
      if (options) return { ifd0: { Make: 'NIKON', ImageWidth: 4000 }, xmp: { CreatorTool: 'MiEditor' } }
      return { Make: 'NIKON' }
    })
    const report = await imagePlusDomain.scan(heicFixture())
    const make = report.entries.find((e) => e.key === 'Make')
    expect(make).toBeDefined()
    expect(make?.where).toBe('EXIF IFD0')
    // `stripHeic` NO elimina el EXIF dentro de `meta`: la etiqueta debe ser honesta.
    expect(make?.removal).toBe('never')
    const width = report.entries.find((e) => e.key === 'ImageWidth')
    expect(width?.removal).toBe('never')
    // El namespace XMP por defecto (`xmp:`) también se enumera (antes se descartaba).
    const creatorTool = report.entries.find((e) => e.key === 'xmp:CreatorTool')
    expect(creatorTool).toBeDefined()
    expect(creatorTool?.where).toBe('XMP')
    expect(creatorTool?.removal).toBe('never')
  })
})

/* ── Integración con el engine ── */

describe('integración con el engine', () => {
  it('stripMetadata(gif, light text) → -limpio.gif y comentario fuera', async () => {
    const src = gifFixture()
    const result = await stripMetadata({
      bytes: src,
      name: 'animacion.gif',
      kind: 'gif',
      config: { mode: 'light', blocks: ['text'] },
    })
    expect(result.kind).toBe('gif')
    expect(result.name).toBe('animacion-limpio.gif')
    const out = new Uint8Array(await result.blob.arrayBuffer())
    const txt = textOf(out)
    expect(txt).not.toContain('HOLA MUNDO')
    expect(txt).toContain('XMP DataXMP')
    expect(out[out.length - 1]).toBe(0x3b)
  })
})