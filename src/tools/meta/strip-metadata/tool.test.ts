/**
 * ADEI-ONE — Tests de la tool "Eliminar metadata" (meta.strip) tras el refactor.
 * Fixtures de bytes puros (sin File, worker-safe): PDF con pdf-lib, DOCX ZIP
 * con fflate, Markdown con frontmatter, JPG/PNG con metadata de la spec.
 * Semántica probada: light = solo bloques seleccionados; passthrough si no se
 * selecciona nada; deep = guardas de navegador (canvas/pdf.js se prueban a mano).
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { ResultPanel } from '@/components/workflow/ResultPanel'
import { canvasToBytes, decodeToCanvas } from '@/tools/image/shared'
import { scanMetadata, stripMetadata } from './engine'
import { imagePlusDomain } from './image-plus'
import type { Artifact, EngineInput, FileKind, VerificationResult } from '@/core/types'

/*
 * El re-encode profundo de imagen usa canvas (solo navegador). Se envuelven los
 * helpers en spies que DELEGAN en la implementación real por defecto: así las
 * guardas de navegador siguen lanzando y un test puede fijar su propio mock.
 */
vi.mock('@/tools/image/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/tools/image/shared')>()
  return {
    ...actual,
    decodeToCanvas: vi.fn(actual.decodeToCanvas),
    canvasToBytes: vi.fn(actual.canvasToBytes),
  }
})

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

/** PDF con Producer/ModDate explícitos en el Info dict (claves del binario real). */
async function pdfInfoWithProducerBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.setTitle('T')
  doc.setProducer('ADEI Producer')
  doc.setModificationDate(new Date('2020-01-02T03:04:05Z'))
  doc.addPage()
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

/** PDF con un AcroForm real (un campo de texto) → riesgo de formularios. */
async function pdfFormBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const page = doc.addPage()
  const form = doc.getForm()
  form.createTextField('nombre').addToPage(page)
  return new Uint8Array(await doc.save())
}

/** PDF con una anotación de enlace en la página → riesgo de enlaces. */
async function pdfLinkBytes(): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  const page = doc.addPage()
  const annot = doc.context.obj({ Type: PDFName.of('Annot'), Subtype: PDFName.of('Link'), Rect: [0, 0, 100, 100] })
  page.node.set(PDFName.of('Annots'), doc.context.obj([annot]))
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

/** DOCX con un proyecto VBA (macros) dentro del paquete OOXML. */
function docxMacroBytes(): Uint8Array {
  return zipSync({
    'docProps/core.xml': strToU8('<cp:coreProperties><dc:creator>Ana</dc:creator></cp:coreProperties>'),
    'word/document.xml': strToU8('<w:document/>'),
    'word/vbaProject.bin': new Uint8Array([1, 2, 3, 4]),
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

/** JPEG con EXIF real (TIFF LE) con Orientation = 1 ("Horizontal (normal)"). */
function jpgNormalOrientationBytes(): Uint8Array {
  const tiff = concat([
    ascii('II'), u16le(0x2a), u32leBytes(8), // cabecera TIFF → IFD0 en 8
    u16le(1), // 1 entrada
    u16le(0x0112), u16le(3), u32leBytes(1), u32leBytes(1), // Orientation = SHORT → 1
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

/** Posición del marcador SOS (FF DA): a partir de ahí van los datos de imagen. */
function sosIndex(bytes: Uint8Array): number {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xda) return i
  }
  return -1
}

/**
 * JPEG con EXIF real (TIFF LE) con Make + Orientation = 6, y datos de imagen
 * (DQT + SOS + scan). Permite comprobar que en light NO se re-codifican píxeles.
 */
function jpgOrientationScanBytes(): Uint8Array {
  const make = ascii('NIKON\0')
  const ifd = concat([
    u16le(2), // 2 entradas
    Uint8Array.from([0x0f, 0x01, 0x02, 0x00]), u32leBytes(make.length), u32leBytes(38), // Make → 38
    Uint8Array.from([0x12, 0x01, 0x03, 0x00]), u32leBytes(1), u32leBytes(6), // Orientation = SHORT → 6
    u32leBytes(0), // siguiente IFD: ninguno
  ])
  // IFD0 en 8: 2 + 2*12 + 4 = 30 → termina en 38. Make en 38.
  const tiff = concat([ascii('II'), u16le(0x2a), u32leBytes(8), ifd, make])
  const payload = concat([ascii('Exif'), Uint8Array.of(0, 0), tiff])
  const sos = concat([Uint8Array.of(0xff, 0xda), u16be(2 + 2), Uint8Array.of(0x01, 0x01)])
  return concat([
    Uint8Array.of(0xff, 0xd8),
    Uint8Array.of(0xff, 0xe1), u16be(2 + payload.length), payload,
    Uint8Array.of(0xff, 0xdb), u16be(2 + 4), ascii('KEED'),
    sos,
    ascii('SCANDATA-PIXELES'),
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

/** Chunk RIFF WebP (fourcc + tamaño LE + datos + pad si es impar). */
function webpChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const pad = data.length % 2 === 1 ? Uint8Array.of(0) : new Uint8Array(0)
  return concat([ascii(fourcc), u32leBytes(data.length), data, pad])
}

/** WebP animado: VP8X con el flag de animación (0x02) + un chunk ANMF. */
function webpAnimatedBytes(): Uint8Array {
  const vp8x = Uint8Array.of(0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0)
  const body = concat([ascii('WEBP'), webpChunk('VP8X', vp8x), webpChunk('ANMF', ascii('FRAME'))])
  return concat([ascii('RIFF'), u32leBytes(body.length), body])
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

  it('PDF: TODAS las claves del Info dict declaran borrado, incluidas las personalizadas', async () => {
    const report = await scanMetadata({ bytes: await pdfCustomInfoBytes(), kind: 'pdf' })
    const custom = report.entries.find((e) => e.key === 'MyCustomKey')
    expect(custom).toBeDefined()
    expect(custom?.where).toBe('info dictionary')
    expect(custom?.value).toBe('valor secreto')
    // `stripPdfLight` elimina TODAS las claves del Info dict: la etiqueta es honesta.
    expect(custom?.removal).toBe('with-container')
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
  it('PDF: elimina TODAS las claves del Info dict con blocks=["info"]', async () => {
    const result = await stripMetadata(eng(await pdfBytes(), 'x.pdf', 'pdf', { mode: 'light', blocks: ['info'] }))
    expect(result.name).toBe('x-limpio.pdf')
    const cleaned = await PDFDocument.load(await bytesOf(result), { updateMetadata: false })
    const info = cleaned.context.lookup(cleaned.context.trailerInfo.Info)
    const keys = info instanceof PDFDict ? info.keys().map((k) => k.asString()) : []
    expect(keys).not.toContain('/Title')
    expect(keys).not.toContain('/Author')
    expect(cleaned.getPageCount()).toBe(1)
  })

  it('PDF: una clave personalizada (/MyCustomKey) desaparece tras ligero y el PDF sigue válido', async () => {
    const source = await pdfCustomInfoBytes()
    const before = await PDFDocument.load(source, { updateMetadata: false })
    const beforeInfo = before.context.lookup(before.context.trailerInfo.Info)
    expect(beforeInfo instanceof PDFDict && beforeInfo.has(PDFName.of('MyCustomKey'))).toBe(true)

    const result = await stripMetadata(eng(source, 'x.pdf', 'pdf', { mode: 'light', blocks: ['info'] }))
    const out = await bytesOf(result)
    const cleaned = await PDFDocument.load(out, { updateMetadata: false })
    const info = cleaned.context.lookup(cleaned.context.trailerInfo.Info)
    const keys = info instanceof PDFDict ? info.keys().map((k) => k.asString()) : []
    expect(keys).not.toContain('/MyCustomKey')
    // Sigue siendo un PDF válido y con su página.
    expect(cleaned.getPageCount()).toBe(1)
    // El valor secreto de la clave personalizada ya no está en el binario.
    expect(new TextDecoder().decode(out)).not.toContain('valor secreto')
  })

  it('PDF: light con blocks=["info"] elimina Producer y ModDate del Info dict', async () => {
    const source = await pdfInfoWithProducerBytes()
    const before = await PDFDocument.load(source, { updateMetadata: false })
    const beforeInfo = before.context.lookup(before.context.trailerInfo.Info)
    const beforeKeys = beforeInfo instanceof PDFDict ? beforeInfo.keys().map((k) => k.asString()) : []
    expect(beforeKeys).toContain('/Producer')
    expect(beforeKeys).toContain('/ModDate')

    const out = await bytesOf(
      await stripMetadata(eng(source, 'x.pdf', 'pdf', { mode: 'light', blocks: ['info'] })),
    )
    const cleaned = await PDFDocument.load(out, { updateMetadata: false })
    const info = cleaned.context.lookup(cleaned.context.trailerInfo.Info)
    const keys = info instanceof PDFDict ? info.keys().map((k) => k.asString()) : []
    expect(keys).not.toContain('/Producer')
    expect(keys).not.toContain('/ModDate')
    expect(cleaned.getPageCount()).toBe(1)
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

  it('JPG con orientación EXIF (vertical): en light conserva el tag y NO toca los píxeles', async () => {
    const source = jpgOrientationScanBytes()
    const result = await stripMetadata(eng(source, 'vertical.jpg', 'jpg', { mode: 'light', blocks: ['exif'] }))
    const out = await bytesOf(result)

    // La verificación posterior confirma que no queda metadata eliminable: la
    // orientación conservada está marcada `never` y NO cuenta como resto. Si se
    // etiquetara como eliminable, este caso pasaría a 'remaining' y fallaría.
    expect(result.verification?.status).toBe('clean')

    // (a) Los datos de imagen tras SOS quedan byte a byte idénticos: no hubo re-encode.
    const from = sosIndex(source)
    expect(from).toBeGreaterThan(0)
    expect(out.slice(sosIndex(out))).toEqual(source.slice(from))

    // (b) Sigue siendo un JPEG válido y conserva las cabeceras no metadatos.
    expect(out[0]).toBe(0xff)
    expect(out[1]).toBe(0xd8)
    expect(out[out.length - 1]).toBe(0xd9)
    expect(new TextDecoder().decode(out)).toContain('KEED')

    // (c) El EXIF queda reducido al único tag Orientation, con su valor original.
    const exifr = await import('exifr')
    const parsed = (await exifr.parse(out, { translateValues: false })) as Record<string, unknown> | undefined
    expect(parsed?.['Orientation']).toBe(6)

    // (d) El resto del EXIF (Make) desaparece del inventario.
    const report = await scanMetadata({ bytes: out, kind: 'jpg' })
    expect(report.entries.some((e) => e.key === 'Make')).toBe(false)
  })

  it('JPG sin orientación: el EXIF se elimina entero (comportamiento sin cambios)', async () => {
    const result = await stripMetadata(eng(jpgExifBytes(), 'foto.jpg', 'jpg', { mode: 'light', blocks: ['exif'] }))
    const out = await bytesOf(result)
    const txt = new TextDecoder().decode(out)
    expect(txt).not.toContain('CAMERAX')
    expect(txt).toContain('KEED')
    // Sin orientación no se conserva ningún EXIF.
    expect(txt).not.toContain('Exif')
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

  it('JPG deep: decodifica los píxeles TAL CUAL (imageOrientation "none", sin rotar)', async () => {
    const fakeCanvas = {
      width: 4,
      height: 4,
      getContext: () => ({ clearRect: vi.fn() }),
    } as unknown as HTMLCanvasElement
    const decode = vi.mocked(decodeToCanvas)
    const encode = vi.mocked(canvasToBytes)
    decode.mockResolvedValueOnce({ canvas: fakeCanvas, width: 4, height: 4 })
    encode.mockResolvedValueOnce(new Uint8Array([1, 2, 3]))

    await stripMetadata(eng(jpgExifBytes(), 'foto.jpg', 'jpg', { mode: 'deep' }))

    // Debe pedir los píxeles CRUDOS: sin esta opción el canvas los enderezaría
    // y el re-encode cambiaría la rotación (regresión del cambio "deep no cambia
    // la rotación"). El test falla si se elimina la opción.
    expect(decode).toHaveBeenCalledWith(expect.any(Uint8Array), { imageOrientation: 'none' })
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

describe('scanMetadata — avisos de regeneración (risks)', () => {
  it('PDF plano: no produce ningún aviso', async () => {
    const report = await scanMetadata({ bytes: await pdfBytes(), kind: 'pdf' })
    expect(report.risks ?? []).toHaveLength(0)
  })

  it('PDF con AcroForm: avisa de formularios (profundo)', async () => {
    const report = await scanMetadata({ bytes: await pdfFormBytes(), kind: 'pdf' })
    const risk = report.risks?.find((r) => r.id === 'pdf-forms')
    expect(risk).toBeDefined()
    expect(risk?.affects).toBe('deep')
    expect(risk?.severity).toBe('high')
  })

  it('PDF con anotación de enlace: avisa de enlaces (profundo)', async () => {
    const report = await scanMetadata({ bytes: await pdfLinkBytes(), kind: 'pdf' })
    const risk = report.risks?.find((r) => r.id === 'pdf-links')
    expect(risk).toBeDefined()
    expect(risk?.affects).toBe('deep')
  })

  it('OOXML con vbaProject.bin: avisa de macros (profundo)', async () => {
    const report = await scanMetadata({ bytes: docxMacroBytes(), kind: 'docx' })
    const risk = report.risks?.find((r) => r.id === 'office-macros')
    expect(risk).toBeDefined()
    expect(risk?.severity).toBe('high')
    expect(risk?.affects).toBe('deep')
  })

  it('DOCX sin macros: no produce aviso de macros', async () => {
    const report = await scanMetadata({ bytes: docxBytes(), kind: 'docx' })
    expect(report.risks?.some((r) => r.id === 'office-macros') ?? false).toBe(false)
  })

  it('WebP animado: avisa de que profundo deja solo el primer frame', async () => {
    const report = await scanMetadata({ bytes: webpAnimatedBytes(), kind: 'webp' })
    const risk = report.risks?.find((r) => r.id === 'webp-animated')
    expect(risk).toBeDefined()
    expect(risk?.affects).toBe('deep')
  })

  it('Imagen con Orientation > 1: el aviso habla de re-codificación y NO de perder la orientación', async () => {
    const report = await scanMetadata({ bytes: jpgOrientationBytes(), kind: 'jpg' })
    const risk = report.risks?.find((r) => r.id === 'image-reencode')
    expect(risk).toBeDefined()
    expect(risk?.affects).toBe('deep')
    // El aviso ya NO miente: no describe una rotación ni una pérdida de orientación.
    expect(risk?.detail).not.toMatch(/rotando los píxeles/i)
    expect(risk?.detail).not.toMatch(/se elimina su orientación/i)
    // Sí avisa de la re-codificación (pérdida de calidad) y de que la orientación se conserva.
    expect(risk?.detail).toMatch(/re-codific/i)
    expect(risk?.detail).toMatch(/orientación se conserva/i)
    // El identificador antiguo ya no existe.
    expect(report.risks?.some((r) => r.id === 'image-orientation') ?? false).toBe(false)
  })
})

describe('scanMetadata — orientación conservada (honestidad)', () => {
  it('marca la orientación como "se conserva" (never) y explica por qué', async () => {
    const report = await scanMetadata({ bytes: jpgOrientationScanBytes(), kind: 'jpg' })
    const entry = report.entries.find((e) => e.key === 'Orientation')
    expect(entry).toBeDefined()
    expect(entry?.removal).toBe('never')
    expect(entry?.label ?? '').toMatch(/conserva/i)
  })

  it('orientación 1 (normal): NO se marca como conservada (el modo ligero la elimina)', async () => {
    const report = await scanMetadata({ bytes: jpgNormalOrientationBytes(), kind: 'jpg' })
    const entry = report.entries.find((e) => e.key === 'Orientation')
    expect(entry).toBeDefined()
    // El modo ligero solo conserva la orientación cuando es > 1; con 1 el tag
    // se elimina junto al resto del EXIF: la etiqueta debe ser honesta.
    expect(entry?.removal).toBe('with-container')
    expect(entry?.label ?? '').not.toMatch(/conserva/i)
  })
})

/** GIF con un comentario (bloque 'text'): sirve para forzar el re-escaneo. */
function gifCommentBytes(): Uint8Array {
  return concat([
    ascii('GIF89a'),
    Uint8Array.of(0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00),
    Uint8Array.of(0x21, 0xfe, 0x03),
    ascii('HOLA'),
    Uint8Array.of(0x00),
    Uint8Array.of(0x3b),
  ])
}

describe('stripMetadata — verificación posterior (verify-after-clean)', () => {
  it('un archivo que queda limpio reporta status "clean"', async () => {
    const result = await stripMetadata(
      eng(await pdfBytes(), 'x.pdf', 'pdf', { mode: 'light', blocks: ['info'] }),
    )
    expect(result.verification?.status).toBe('clean')
  })

  it('cuando queda metadata eliminable reporta "remaining" con recuento y muestra', async () => {
    // Solo se limpia el Info dict: el paquete XMP sigue presente (no seleccionado).
    const result = await stripMetadata(
      eng(await pdfXmpBytes(), 'x.pdf', 'pdf', { mode: 'light', blocks: ['info'] }),
    )
    expect(result.verification?.status).toBe('remaining')
    expect(result.verification?.remaining).toBeGreaterThan(0)
    expect(result.verification?.sample?.length).toBeGreaterThan(0)
  })

  it('si el re-escaneo falla informa "unverifiable" y la limpieza no falla', async () => {
    const spy = vi
      .spyOn(imagePlusDomain, 'scan')
      .mockRejectedValue(new Error('fallo de re-escaneo'))
    try {
      const result = await stripMetadata(
        eng(gifCommentBytes(), 'foto.gif', 'gif', { mode: 'light', blocks: ['text'] }),
      )
      expect(result.verification?.status).toBe('unverifiable')
      // La operación termina y entrega un archivo descargable.
      expect(result.name).toBe('foto-limpio.gif')
      expect(result.blob.size).toBeGreaterThan(0)
    } finally {
      spy.mockRestore()
    }
  })

  it('si ni el original ni el resultado son interpretables informa "unverifiable" (nunca "clean")', async () => {
    // Ambos escaneos devuelven EMPTY_REPORT ("no parseable"): no se puede afirmar limpieza.
    const result = await stripMetadata(
      eng(new TextEncoder().encode('NOT-A-FLAC'), 'x.flac', 'flac', { mode: 'light', blocks: ['vorbis'] }),
    )
    expect(result.verification?.status).toBe('unverifiable')
  })
})

describe('<ResultPanel /> — aviso de verificación', () => {
  function renderPanel(verification?: VerificationResult): string {
    const artifact: Artifact = {
      id: 'r1',
      name: 'x-limpio.pdf',
      kind: 'pdf',
      size: 1024,
      source: 'file',
      blob: new Blob(['limpio']),
    }
    return renderToStaticMarkup(
      createElement(ResultPanel, {
        artifact,
        onDownload: () => {},
        onRestart: () => {},
        verification,
      }),
    )
  }

  it('con status "clean" no muestra ningún aviso', () => {
    const html = renderPanel({ status: 'clean' })
    expect(html).not.toMatch(/Quedan .* sin eliminar/i)
    expect(html).not.toMatch(/no se pudo verificar/i)
    expect(html).not.toContain('role="alert"')
  })

  it('sin verificación no muestra ningún aviso', () => {
    const html = renderPanel(undefined)
    expect(html).not.toMatch(/Quedan .* sin eliminar/i)
    expect(html).not.toMatch(/no se pudo verificar/i)
  })

  it('con restos muestra el recuento y la muestra, sin bloquear la descarga', () => {
    const html = renderPanel({
      status: 'remaining',
      remaining: 3,
      sample: ['Título', 'Autor', 'dc:title'],
    })
    expect(html).toMatch(/Quedan 3 datos sin eliminar/)
    expect(html).toMatch(/Título, Autor, dc:title/)
    expect(html).toMatch(/Descargar/)
  })

  it('con "unverifiable" muestra una nota suave', () => {
    const html = renderPanel({ status: 'unverifiable' })
    expect(html).toMatch(/no se pudo verificar/i)
  })
})