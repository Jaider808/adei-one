/**
 * ADEI-ONE — Tests de la tool "Eliminar metadata" (meta.strip) tras el refactor.
 * Fixtures de bytes puros (sin File, worker-safe): PDF con pdf-lib, DOCX ZIP
 * con fflate, Markdown con frontmatter, JPG/PNG con metadata de la spec.
 * Semántica probada: light = solo bloques seleccionados; passthrough si no se
 * selecciona nada; deep = guardas de navegador (canvas/pdf.js se prueban a mano).
 */
import { describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { scanMetadata, stripMetadata } from './engine'
import type { EngineInput, FileKind } from '@/core/types'

function eng(bytes: Uint8Array, name: string, kind: FileKind, config: Record<string, unknown> = {}): EngineInput {
  return { bytes, name, kind, config }
}

async function bytesOf(result: { blob: Blob }): Promise<Uint8Array> {
  return new Uint8Array(await result.blob.arrayBuffer())
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from([...text].map((c) => c.charCodeAt(0)))
}

function u16be(n: number): Uint8Array {
  return Uint8Array.from([(n >> 8) & 0xff, n & 0xff])
}

function u32be(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
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

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  return concat([u32be(data.length), ascii(type), data, new Uint8Array(4)])
}

/** PDF con metadata (Title/Author). */
async function pdfBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.setTitle('Título secreto')
  doc.setAuthor('Juan')
  doc.addPage()
  return new Uint8Array(await doc.save())
}

/** PDF con una clave personalizada en el diccionario de información (/MyCustomKey). */
async function pdfCustomInfoBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.setTitle('T')
  doc.addPage()
  const infoRef = doc.context.trailerInfo.Info
  if (infoRef) {
    const info = doc.context.lookup(infoRef, PDFDict)
    info.set(PDFName.of('MyCustomKey'), PDFString.of('valor secreto'))
  }
  return new Uint8Array(await doc.save())
}

/** PDF con un stream XMP (Metadata) con una propiedad dc:title. */
async function pdfXmpBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.addPage()
  const xmp =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:title="Hola XMP"/></rdf:RDF></x:xmpmeta>'
  const stream = doc.context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })
  doc.catalog.set(PDFName.of('Metadata'), stream)
  return new Uint8Array(await doc.save())
}

/** DOCX mínimo con docProps/core.xml y un documento. */
function docxBytes(): Uint8Array {
  return zipSync({
    'docProps/core.xml': strToU8(
      '<cp:coreProperties xmlns:dc="..."><dc:creator>Ana</dc:creator><cp:lastModifiedBy>Ana</cp:lastModifiedBy></cp:coreProperties>',
    ),
    'docProps/app.xml': strToU8('<Properties xmlns="..."/>'),
    'word/document.xml': strToU8('<w:document/>'),
  })
}

/** DOCX con carpetas separadas: props core/app, custom (custom.xml) y customXml/. */
function docxSplitBytes(): Uint8Array {
  return zipSync({
    'docProps/core.xml': strToU8('<cp:coreProperties><dc:creator>Ana</dc:creator></cp:coreProperties>'),
    'docProps/app.xml': strToU8('<Properties xmlns="..."/>'),
    'docProps/custom.xml': strToU8('<Properties><property name="Cliente"/></Properties>'),
    'customXml/item1.xml': strToU8('<igx>secreto</igx>'),
    'word/document.xml': strToU8('<w:document/>'),
  })
}

/** DOCX con entradas reales en docProps/app.xml (Application/AppVersion/Company). */
function docxAppPropsBytes(): Uint8Array {
  return zipSync({
    'docProps/core.xml': strToU8('<cp:coreProperties><dc:creator>Ana</dc:creator></cp:coreProperties>'),
    'docProps/app.xml': strToU8(
      '<Properties xmlns="x"><Application>ADEI Test</Application><AppVersion>1.2.3</AppVersion><Company>ACME</Company></Properties>',
    ),
    'word/document.xml': strToU8('<w:document/>'),
  })
}

function mdBytes(): Uint8Array {
  return new TextEncoder().encode('---\ntitle: Mi nota\nauthor: Juan\n---\n# Hola\nCuerpo.')
}

/** JPEG con APP1-EXIF real (cabecera 'Exif\0\0') + contenido DQT. */
function jpgExifBytes(): Uint8Array {
  const payload = concat([ascii('Exif'), Uint8Array.of(0, 0), ascii('CAMERAX')])
  return concat([
    Uint8Array.of(0xff, 0xd8),
    Uint8Array.of(0xff, 0xe1), u16be(2 + payload.length), payload,
    Uint8Array.of(0xff, 0xdb), ascii('KEED'),
    Uint8Array.of(0xff, 0xd9),
  ])
}

/* Enteros little-endian para el fixture TIFF de Orientación. */
function u16le(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >> 8) & 0xff])
}

function u32leBytes(n: number): Uint8Array {
  return Uint8Array.from([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff])
}

/**
 * JPEG con EXIF REAL (TIFF LE válido): IFD0 con Orientation = 6 (girada 90°,
 * el caso típico de una foto de móvil tomada en vertical).
 */
function jpgOrientationBytes(): Uint8Array {
  const tiff = concat([
    ascii('II'), u16le(0x2a), u32leBytes(8), // cabecera TIFF → IFD0 en 8
    u16le(1), // 1 entrada
    u16le(0x0112), u16le(3), u32leBytes(1), u32leBytes(6), // Orientation = SHORT → 6
    u32leBytes(0), // siguiente IFD: ninguno
  ])
  const payload = concat([ascii('Exif'), Uint8Array.of(0, 0), tiff])
  return concat([
    Uint8Array.of(0xff, 0xd8),
    Uint8Array.of(0xff, 0xe1), u16be(2 + payload.length), payload,
    Uint8Array.of(0xff, 0xdb), ascii('KEED'),
    Uint8Array.of(0xff, 0xd9),
  ])
}

/** JPEG con EXIF real (TIFF LE) que incluye un tag privado no mapeado (0x9999). */
function jpgPrivateExifBytes(): Uint8Array {
  const make = ascii('NIKON\0')
  const ifd = concat([
    u16le(2), // 2 entradas
    Uint8Array.from([0x0f, 0x01, 0x02, 0x00]), u32leBytes(make.length), u32leBytes(38), // Make → 38
    Uint8Array.from([0x99, 0x99, 0x03, 0x00]), u32leBytes(1), u32leBytes(7), // 0x9999 (privado) = 7
    u32leBytes(0), // siguiente IFD: ninguno
  ])
  // IFD0 en 8: 2 + 2*12 + 4 = 30 → termina en 38. Make en 38.
  const tiff = concat([ascii('II'), u16le(0x2a), u32leBytes(8), ifd, make])
  const payload = concat([ascii('Exif'), Uint8Array.of(0, 0), tiff])
  return concat([
    Uint8Array.of(0xff, 0xd8),
    Uint8Array.of(0xff, 0xe1), u16be(2 + payload.length), payload,
    Uint8Array.of(0xff, 0xdb), ascii('KEED'),
    Uint8Array.of(0xff, 0xd9),
  ])
}

/** JPEG con un segmento APP1 XMP (namespace dc → título). */
function jpgXmpBytes(): Uint8Array {
  const xmp =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:title="Hola"/></rdf:RDF></x:xmpmeta>'
  const payload = concat([ascii('http://ns.adobe.com/xap/1.0/\0'), new TextEncoder().encode(xmp)])
  return concat([
    Uint8Array.of(0xff, 0xd8),
    Uint8Array.of(0xff, 0xe1), u16be(2 + payload.length), payload,
    Uint8Array.of(0xff, 0xdb), ascii('KEED'),
    Uint8Array.of(0xff, 0xd9),
  ])
}

/** JPEG con APP1 XMP que usa el namespace por defecto (`xmp:CreatorTool`). */
function jpgDefaultXmpBytes(): Uint8Array {
  const xmp =
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="MiEditor"/></rdf:RDF></x:xmpmeta>'
  const payload = concat([ascii('http://ns.adobe.com/xap/1.0/\0'), new TextEncoder().encode(xmp)])
  return concat([
    Uint8Array.of(0xff, 0xd8),
    Uint8Array.of(0xff, 0xe1), u16be(2 + payload.length), payload,
    Uint8Array.of(0xff, 0xdb), ascii('KEED'),
    Uint8Array.of(0xff, 0xd9),
  ])
}

/** JPEG con EXIF real (TIFF LE) con ImageWidth/ImageHeight + Make en el IFD0. */
function jpgExifDimensionBytes(): Uint8Array {
  const make = ascii('NIKON\0')
  const ifd = concat([
    u16le(3), // 3 entradas
    Uint8Array.from([0x00, 0x01, 0x03, 0x00]), u32leBytes(1), u32leBytes(4000), // ImageWidth (0x0100) SHORT
    Uint8Array.from([0x01, 0x01, 0x03, 0x00]), u32leBytes(1), u32leBytes(3000), // ImageHeight (0x0101) SHORT
    Uint8Array.from([0x0f, 0x01, 0x02, 0x00]), u32leBytes(make.length), u32leBytes(50), // Make → 50
    u32leBytes(0), // siguiente IFD: ninguno
  ])
  // IFD0 en 8: 2 + 3*12 + 4 = 42 → termina en 50. Make en 50.
  const tiff = concat([ascii('II'), u16le(0x2a), u32leBytes(8), ifd, make])
  const payload = concat([ascii('Exif'), Uint8Array.of(0, 0), tiff])
  return concat([
    Uint8Array.of(0xff, 0xd8),
    Uint8Array.of(0xff, 0xe1), u16be(2 + payload.length), payload,
    Uint8Array.of(0xff, 0xdb), ascii('KEED'),
    Uint8Array.of(0xff, 0xd9),
  ])
}

/** PNG con eXIf + tEXt (texto incrustado). */
function pngTextBytes(): Uint8Array {
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', new Uint8Array(13)),
    pngChunk('IDAT', ascii('PIXELES')),
    pngChunk('eXIf', ascii('GPS')),
    pngChunk('tEXt', concat([ascii('Autor'), Uint8Array.of(0), ascii('Juan')])),
    pngChunk('IEND', new Uint8Array()),
  ])
}

describe('scanMetadata', () => {
  it('PDF: detecta Título y Autor como bloque info', async () => {
    const report = await scanMetadata({ bytes: await pdfBytes(), kind: 'pdf' })
    const ids = report.blocks.map((b) => b.id)
    expect(ids).toContain('info')
    const names = report.fields.map((f) => f.name)
    expect(names).toContain('Título')
    expect(names).toContain('Autor')
  })

  it('DOCX: bloque props con el autor', async () => {
    const report = await scanMetadata({ bytes: docxBytes(), kind: 'docx' })
    const block = report.blocks.find((b) => b.id === 'props')
    expect(block?.fields[0]?.name).toBe('Autor')
    expect(report.count).toBeGreaterThanOrEqual(1)
  })

  it('MD: extrae las claves del frontmatter como bloque', async () => {
    const report = await scanMetadata({ bytes: mdBytes(), kind: 'md' })
    expect(report.blocks[0]?.id).toBe('frontmatter')
    expect(report.count).toBeGreaterThanOrEqual(2)
  })

  it('PNG: bloque text por los chunks tEXt', async () => {
    const report = await scanMetadata({ bytes: pngTextBytes(), kind: 'png' })
    expect(report.blocks.some((b) => b.id === 'text')).toBe(true)
  })

  it('JPG: enumera el EXIF completo, incluida una clave no mapeada', async () => {
    const report = await scanMetadata({ bytes: jpgPrivateExifBytes(), kind: 'jpg' })
    const unknown = report.entries.find((e) => e.key === '39321') // tag 0x9999 sin diccionario
    expect(unknown).toBeDefined()
    expect(unknown?.where).toBe('EXIF IFD0')
    const make = report.entries.find((e) => e.key === 'Make')
    expect(make?.label).toBe('Fabricante')
    expect(make?.where).toBe('EXIF IFD0')
    expect(make?.removal).toBe('with-container')
  })

  it('JPG: enumera cada propiedad XMP con su ruta', async () => {
    const report = await scanMetadata({ bytes: jpgXmpBytes(), kind: 'jpg' })
    const title = report.entries.find((e) => e.key === 'dc:title')
    expect(title).toBeDefined()
    expect(title?.where).toBe('XMP')
    expect(title?.value).toBe('Hola')
    expect(title?.removal).toBe('with-container')
  })

  it('txt: sin metadata estándar → count 0 y sin bloques', async () => {
    const report = await scanMetadata({ bytes: new TextEncoder().encode('hola'), kind: 'txt' })
    expect(report.count).toBe(0)
    expect(report.blocks).toEqual([])
  })

  it('PDF: una clave personalizada del Info dict no promete borrado (el limpiador no la toca)', async () => {
    const report = await scanMetadata({ bytes: await pdfCustomInfoBytes(), kind: 'pdf' })
    const custom = report.entries.find((e) => e.key === 'MyCustomKey')
    expect(custom).toBeDefined()
    expect(custom?.where).toBe('info dictionary')
    expect(custom?.value).toBe('valor secreto')
    // `stripPdfLight` NO borra claves desconocidas: la etiqueta debe ser honesta.
    expect(custom?.removal).toBe('never')
    // Las claves que el limpiador sí vacía conservan su declaración de borrado.
    expect(report.entries.find((e) => e.key === 'Title')?.removal).toBe('with-container')
  })

  it('JPG: enumera el namespace XMP por defecto (xmp:) además de dc:', async () => {
    const report = await scanMetadata({ bytes: jpgDefaultXmpBytes(), kind: 'jpg' })
    const creatorTool = report.entries.find((e) => e.key === 'xmp:CreatorTool')
    expect(creatorTool).toBeDefined()
    expect(creatorTool?.where).toBe('XMP')
    expect(creatorTool?.value).toBe('MiEditor')
    expect(creatorTool?.removal).toBe('with-container')
  })

  it('JPG: ImageWidth/ImageHeight declaran borrado (viven en el EXIF que sí se elimina)', async () => {
    const report = await scanMetadata({ bytes: jpgExifDimensionBytes(), kind: 'jpg' })
    const width = report.entries.find((e) => e.key === 'ImageWidth')
    expect(width).toBeDefined()
    expect(width?.where).toBe('EXIF IFD0')
    expect(width?.removal).toBe('with-container')
    expect(report.entries.find((e) => e.key === 'ImageHeight')?.removal).toBe('with-container')
  })

  it('PDF: enumera cada propiedad XMP con su clave cruda', async () => {
    const report = await scanMetadata({ bytes: await pdfXmpBytes(), kind: 'pdf' })
    const title = report.entries.find((e) => e.key === 'dc:title')
    expect(title).toBeDefined()
    expect(title?.where).toBe('XMP')
    expect(title?.value).toBe('Hola XMP')
    expect(title?.removal).toBe('with-container')
  })

  it('DOCX: enumera cada entrada de docProps/app.xml', async () => {
    const report = await scanMetadata({ bytes: docxAppPropsBytes(), kind: 'docx' })
    const app = report.entries.find((e) => e.key === 'Application')
    expect(app).toBeDefined()
    expect(app?.where).toBe('docProps/app.xml')
    expect(app?.value).toBe('ADEI Test')
    expect(app?.removal).toBe('with-container')
  })

  it('DOCX: enumera las propiedades personalizadas de docProps/custom.xml', async () => {
    const report = await scanMetadata({ bytes: docxSplitBytes(), kind: 'docx' })
    const custom = report.entries.find((e) => e.where === 'docProps/custom.xml' && e.key === 'Cliente')
    expect(custom).toBeDefined()
    expect(custom?.removal).toBe('with-container')
  })

  it('MD: enumera una clave de frontmatter no estándar con su clave cruda', async () => {
    const md = new TextEncoder().encode('---\ntitle: T\ncustom_key: valor\n---\ncuerpo')
    const report = await scanMetadata({ bytes: md, kind: 'md' })
    const custom = report.entries.find((e) => e.key === 'custom_key')
    expect(custom).toBeDefined()
    expect(custom?.where).toBe('frontmatter')
    expect(custom?.value).toBe('valor')
  })
})

describe('stripMetadata — light lossless', () => {
  it('PDF: elimina Título/Autor con blocks=["info"]', async () => {
    const result = await stripMetadata(eng(await pdfBytes(), 'x.pdf', 'pdf', { mode: 'light', blocks: ['info'] }))
    expect(result.name).toBe('x-limpio.pdf')
    const cleaned = await PDFDocument.load(await bytesOf(result), { updateMetadata: false })
    expect(cleaned.getTitle()).toBe('')
    expect(cleaned.getAuthor()).toBe('')
  })

  it('PDF: sin bloques seleccionados → passthrough intacto', async () => {
    const source = await pdfBytes()
    const result = await stripMetadata(eng(source, 'x.pdf', 'pdf', { mode: 'light', blocks: [] }))
    expect(Buffer.from(await bytesOf(result)).equals(Buffer.from(source))).toBe(true)
  })

  it('DOCX: elimina docProps con blocks=["props"] y conserva el resto', async () => {
    const result = await stripMetadata(eng(docxBytes(), 'x.docx', 'docx', { mode: 'light', blocks: ['props'] }))
    const zipped = unzipSync(await bytesOf(result))
    expect(Object.keys(zipped).some((n) => n.startsWith('docProps'))).toBe(false)
    expect(zipped['word/document.xml']).toBeDefined()
  })

  it('DOCX: props y custom son independientes (no se arrastran entre ellos)', async () => {
    const onlyProps = unzipSync(
      await bytesOf(
        await stripMetadata(eng(docxSplitBytes(), 'x.docx', 'docx', { mode: 'light', blocks: ['props'] })),
      ),
    )
    expect(onlyProps['docProps/core.xml']).toBeUndefined()
    expect(onlyProps['docProps/app.xml']).toBeUndefined()
    expect(onlyProps['docProps/custom.xml']).toBeDefined()
    expect(onlyProps['customXml/item1.xml']).toBeDefined()

    const onlyCustom = unzipSync(
      await bytesOf(
        await stripMetadata(eng(docxSplitBytes(), 'x.docx', 'docx', { mode: 'light', blocks: ['custom'] })),
      ),
    )
    expect(onlyCustom['docProps/core.xml']).toBeDefined()
    expect(onlyCustom['docProps/custom.xml']).toBeUndefined()
    expect(onlyCustom['customXml/item1.xml']).toBeUndefined()
    expect(onlyCustom['word/document.xml']).toBeDefined()
  })

  it('MD: quita el frontmatter y conserva el cuerpo', async () => {
    const result = await stripMetadata(eng(mdBytes(), 'x.md', 'md', { mode: 'light', blocks: ['frontmatter'] }))
    const text = new TextDecoder().decode(await bytesOf(result))
    expect(text.startsWith('---')).toBe(false)
    expect(text).toContain('# Hola')
  })

  it('JPG: elimina EXIF con blocks=["exif"] y conserva el contenido', async () => {
    const result = await stripMetadata(eng(jpgExifBytes(), 'foto.jpg', 'jpg', { mode: 'light', blocks: ['exif'] }))
    const txt = new TextDecoder().decode(await bytesOf(result))
    expect(txt).not.toContain('CAMERAX')
    expect(txt).toContain('KEED')
  })

  it('JPG con orientación EXIF (vertical): en light se re-procesa para no girar', async () => {
    // La foto "vertical" (Orientation=6) debe re-orientarse → requiere navegador.
    await expect(
      stripMetadata(eng(jpgOrientationBytes(), 'vertical.jpg', 'jpg', { mode: 'light', blocks: ['exif'] })),
    ).rejects.toThrow(/navegador/i)
  })

  it('scan JPG: el perfil ICC se marca como "se conserva" (never)', async () => {
    const iccJpg = concat([
      Uint8Array.of(0xff, 0xd8),
      Uint8Array.of(0xff, 0xe2), u16be(2 + 13), concat([ascii('ICC_PROFILE'), Uint8Array.of(0), ascii('P')]),
      Uint8Array.of(0xff, 0xdb), ascii('KEED'),
      Uint8Array.of(0xff, 0xd9),
    ])
    const report = await scanMetadata({ bytes: iccJpg, kind: 'jpg' })
    const icc = report.blocks.find((b) => b.id === 'icc')
    expect(icc?.removableIn).toBe('never')
  })

  it('PNG: elimina el bloque text y conserva IDAT', async () => {
    const result = await stripMetadata(eng(pngTextBytes(), 'icono.png', 'png', { mode: 'light', blocks: ['text'] }))
    const txt = new TextDecoder().decode(await bytesOf(result))
    expect(txt).toContain('IDAT')
    expect(txt).not.toContain('tEXt')
    expect(txt).toContain('PIXELES')
  })

  it('txt: passthrough de los mismos bytes', async () => {
    const result = await stripMetadata(eng(new TextEncoder().encode('hola'), 'hola.txt', 'txt'))
    expect(result.kind).toBe('txt')
    expect(new TextDecoder().decode(await bytesOf(result))).toBe('hola')
  })
})

describe('stripMetadata — deep (guardas de navegador)', () => {
  it('JPG deep → requiere navegador (canvas)', async () => {
    await expect(
      stripMetadata(eng(jpgExifBytes(), 'foto.jpg', 'jpg', { mode: 'deep' })),
    ).rejects.toThrow(/navegador/i)
  })

  it('PDF deep → requiere navegador (rasterizado)', async () => {
    await expect(
      stripMetadata(eng(await pdfBytes(), 'x.pdf', 'pdf', { mode: 'deep' })),
    ).rejects.toThrow(/navegador/i)
  })
})

describe('stripMetadata — guardas y despacho', () => {
  it('bytes vacíos: guardia clara', async () => {
    await expect(stripMetadata(eng(new Uint8Array(), 'x.pdf', 'pdf'))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })

  it('gif: imagen-plus limpia comentarios (blocks=["text"])', async () => {
    const gif = concat([
      ascii('GIF89a'),
      Uint8Array.of(0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00), // LSD (8x8)
      Uint8Array.of(0x21, 0xfe, 0x03), // comentario (3 bytes)
      ascii('HOLA'),
      Uint8Array.of(0x00), // fin de sub-bloques
      Uint8Array.of(0x3b), // trailer
    ])
    const result = await stripMetadata(eng(gif, 'foto.gif', 'gif', { mode: 'light', blocks: ['text'] }))
    expect(result.kind).toBe('gif')
    expect(result.name).toBe('foto-limpio.gif')
    const out = await bytesOf(result)
    expect(new TextDecoder().decode(out)).not.toContain('HOLA')
    expect(out[out.length - 1]).toBe(0x3b)
  })

  it('gif: light con blocks vacío → passthrough de los mismos bytes', async () => {
    const gif = concat([
      ascii('GIF89a'),
      Uint8Array.of(0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00),
      Uint8Array.of(0x3b),
    ])
    const result = await stripMetadata(eng(gif, 'foto.gif', 'gif', { mode: 'light', blocks: [] }))
    expect(Buffer.from(await bytesOf(result)).equals(Buffer.from(gif))).toBe(true)
  })

  it('unknown: formato sin soporte → error de fase próxima', async () => {
    await expect(stripMetadata(eng(new TextEncoder().encode('x'), 'raro.bin', 'unknown'))).rejects.toThrow(
      /fase próxima/i,
    )
  })
})

describe('scanMetadata — inventario genérico (entries)', () => {
  it('PDF: el inventario usa claves crudas del Info dict con su contenedor real', async () => {
    const report = await scanMetadata({ bytes: await pdfBytes(), kind: 'pdf' })
    expect(report.entries.length).toBeGreaterThan(0)
    expect(report.entries.every((e) => e.where.trim().length > 0)).toBe(true)
    const title = report.entries.find((e) => e.key === 'Title')
    expect(title?.where).toBe('info dictionary')
    expect(title?.label).toBe('Título')
    expect(report.entries.some((e) => e.removal === 'never')).toBe(true)
    expect(report.entries.some((e) => e.removal === 'with-container')).toBe(true)
  })

  it('MD: las claves del frontmatter aparecen como entradas', async () => {
    const report = await scanMetadata({ bytes: mdBytes(), kind: 'md' })
    expect(report.entries.some((e) => e.key === 'title')).toBe(true)
  })
})