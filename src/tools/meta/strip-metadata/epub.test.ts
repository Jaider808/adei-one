/**
 * ADEI-ONE — Tests del dominio EPUB de "Eliminar metadata" (`epub.ts`).
 *
 * Se construye un EPUB realista en memoria (`mimetype` primero y almacenado,
 * `META-INF/container.xml` que apunta al OPF, un OPF con campos personales,
 * obligatorios y `meta calibre:*`, y un sidecar de posición de lectura). Se
 * comprueba el escaneo, la limpieza por bloques, la conservación de los campos
 * obligatorios, la validez XML del OPF y que el ZIP resultante mantiene
 * `mimetype` primero y almacenado.
 */
import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { zipSync } from 'fflate'
import { epubDomain } from './epub'
import { firstLocalEntry, readZip } from './zipdoc'
import { scanMetadata, stripMetadata } from './engine'

const noop = (): void => {}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/* ── Fixture ── */

const EPUB_MIMETYPE = 'application/epub+zip'
const OPF_PATH = 'OEBPS/content.opf'

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="${OPF_PATH}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`

const OPF_XML = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Mi libro</dc:title>
    <dc:creator opf:role="aut">Ana Autora</dc:creator>
    <dc:contributor>Beto</dc:contributor>
    <dc:publisher>Editorial Privada</dc:publisher>
    <dc:subject>Asunto personal</dc:subject>
    <dc:description>Descripción personal</dc:description>
    <dc:rights>© Ana Autora</dc:rights>
    <dc:date>2020-05-06T07:08:09Z</dc:date>
    <dc:identifier id="pub-id">urn:uuid:12345678-1234-1234-1234-123456789abc</dc:identifier>
    <dc:language>es</dc:language>
    <meta name="calibre:series" content="Serie privada"/>
    <meta name="calibre:series_index" content="3"/>
    <meta property="dcterms:modified">2020-05-06T07:08:09Z</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="cover-image" href="images/cover.jpg" media-type="image/jpeg"/>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="nav"/>
  </spine>
  <guide>
    <reference type="cover" href="images/cover.jpg"/>
  </guide>
</package>
`

/** Construye un EPUB de prueba con `mimetype` primero y almacenado. */
function buildEpub(opf: string = OPF_XML): Uint8Array {
  return zipSync({
    mimetype: [utf8(EPUB_MIMETYPE), { level: 0 }],
    'META-INF/container.xml': utf8(CONTAINER_XML),
    [OPF_PATH]: utf8(opf),
    'OEBPS/nav.xhtml': utf8('<html xmlns="http://www.w3.org/1999/xhtml"><body/></html>'),
    'META-INF/calibre_bookmarks.txt': utf8('epubcfi(/6/4[chap01]!/4/2/2)'),
  })
}

/* ── Contrato ── */

describe('epubDomain — contrato', () => {
  it('declara el kind epub', () => {
    expect(epubDomain.kinds).toEqual(['epub'])
  })
})

/* ── Escaneo ── */

describe('epubDomain — escaneo (inventario)', () => {
  it('enumera los campos del OPF y el sidecar con rutas reales', async () => {
    const report = await epubDomain.scan(buildEpub())
    const wheres = report.entries.map((entry) => entry.where)
    expect(wheres).toEqual(
      expect.arrayContaining([
        'OPF > metadata > dc:title',
        'OPF > metadata > dc:creator',
        'OPF > metadata > dc:publisher',
        'OPF > metadata > dc:date',
        'OPF > metadata > dc:identifier',
        'OPF > metadata > dc:language',
        'OPF > metadata > meta[@name=calibre:series]',
        'OPF > metadata > meta[@property=dcterms:modified]',
        'sidecar: META-INF/calibre_bookmarks.txt',
      ]),
    )
    const ids = report.blocks.map((block) => block.id)
    expect(ids).toEqual(expect.arrayContaining(['metadata', 'sidecars', 'format']))
  })

  it('el removal del inventario es honesto: personales borrables, obligatorios nunca', async () => {
    const report = await epubDomain.scan(buildEpub())
    const removal = (where: string): string | undefined =>
      report.entries.find((entry) => entry.where === where)?.removal
    expect(removal('OPF > metadata > dc:creator')).toBe('with-container')
    expect(removal('OPF > metadata > dc:publisher')).toBe('with-container')
    expect(removal('OPF > metadata > dc:identifier')).toBe('never')
    expect(removal('OPF > metadata > dc:title')).toBe('never')
    expect(removal('OPF > metadata > dc:language')).toBe('never')
    expect(removal('sidecar: META-INF/calibre_bookmarks.txt')).toBe('with-container')
    expect(report.entries.find((entry) => entry.key === 'mimetype')?.removal).toBe('never')
  })

  it('engine.scanMetadata(epub) ya no devuelve el report vacío', async () => {
    const report = await scanMetadata({ bytes: buildEpub(), kind: 'epub' })
    expect(report.entries.length).toBeGreaterThan(0)
    expect(report.entries.some((entry) => entry.where === 'OPF > metadata > dc:creator')).toBe(true)
  })
})

/* ── Limpieza ── */

describe('epubDomain — limpieza', () => {
  it('metadata: quita los personales y conserva identifier/title/language, con el OPF válido', async () => {
    const out = await epubDomain.strip(buildEpub(), 'epub', { mode: 'light', blocks: ['metadata'] }, noop)
    const entries = readZip(out)!
    const opf = textOf(entries[OPF_PATH]!)

    // Personales: fuera (elemento y valor).
    expect(opf).not.toContain('dc:creator')
    expect(opf).not.toContain('Ana Autora')
    expect(opf).not.toContain('dc:contributor')
    expect(opf).not.toContain('dc:publisher')
    expect(opf).not.toContain('Editorial Privada')
    expect(opf).not.toContain('dc:subject')
    expect(opf).not.toContain('dc:description')
    expect(opf).not.toContain('dc:rights')
    expect(opf).not.toContain('calibre:series')

    // Obligatorios: presentes (elemento y valor).
    expect(opf).toContain('<dc:identifier')
    expect(opf).toContain('urn:uuid:12345678-1234-1234-1234-123456789abc')
    expect(opf).toContain('<dc:title>Mi libro</dc:title>')
    expect(opf).toContain('<dc:language>es</dc:language>')

    // Fechas: normalizadas, nunca borradas.
    expect(opf).not.toContain('2020-05-06')
    expect(opf).toContain('1970-01-01T00:00:00Z')

    // Estructura intacta.
    expect(opf).toContain('<meta name="cover"')
    expect(opf).toContain('<manifest>')
    expect(opf).toContain('<spine>')
    expect(opf).toContain('<guide>')
    expect(XMLValidator.validate(opf)).toBe(true)

    // container.xml intacto y el sidecar sigue (solo se pidió metadata).
    expect(textOf(entries['META-INF/container.xml']!)).toBe(CONTAINER_XML)
    expect(entries['META-INF/calibre_bookmarks.txt']).toBeDefined()
  })

  it('metadata: elimina los `meta refines` que quedarían colgando al borrar su objetivo', async () => {
    const opfConRefines = OPF_XML.replace(
      '<dc:creator opf:role="aut">Ana Autora</dc:creator>',
      '<dc:creator id="creador-1" opf:role="aut">Ana Autora</dc:creator>\n    <meta refines="#creador-1" property="role" scheme="marc:relators">aut</meta>',
    )
    const out = await epubDomain.strip(buildEpub(opfConRefines), 'epub', { mode: 'light', blocks: ['metadata'] }, noop)
    const opf = textOf(readZip(out)![OPF_PATH]!)
    expect(opf).not.toContain('dc:creator')
    expect(opf).not.toContain('creador-1')
    expect(opf).not.toContain('refines=')
    expect(XMLValidator.validate(opf)).toBe(true)
  })

  it('metadata: normaliza la fecha de un `dcterms:modified` autocerrado (atributo content)', async () => {
    const opfSelfClosing = OPF_XML.replace(
      '<meta property="dcterms:modified">2020-05-06T07:08:09Z</meta>',
      '<meta name="dcterms:modified" content="2020-05-06T07:08:09Z"/>',
    )
    const out = await epubDomain.strip(buildEpub(opfSelfClosing), 'epub', { mode: 'light', blocks: ['metadata'] }, noop)
    const opf = textOf(readZip(out)![OPF_PATH]!)
    expect(opf).not.toContain('2020-05-06')
    expect(opf).toContain('1970-01-01T00:00:00Z')
    expect(XMLValidator.validate(opf)).toBe(true)
  })

  it('sidecars: elimina el sidecar de posición de lectura', async () => {
    const out = await epubDomain.strip(buildEpub(), 'epub', { mode: 'light', blocks: ['sidecars'] }, noop)
    const entries = readZip(out)!
    expect(entries['META-INF/calibre_bookmarks.txt']).toBeUndefined()
    // El OPF no se toca si no se pidió el bloque metadata.
    expect(textOf(entries[OPF_PATH]!)).toContain('dc:creator')
  })

  it('mimetype sigue siendo la primera entrada y almacenada', async () => {
    const out = await epubDomain.strip(buildEpub(), 'epub', { mode: 'deep', blocks: [] }, noop)
    expect(firstLocalEntry(out)).toEqual({ name: 'mimetype', method: 0 })
  })

  it('light sin bloques es passthrough byte a byte', async () => {
    const epub = buildEpub()
    const out = await epubDomain.strip(epub, 'epub', { mode: 'light', blocks: [] }, noop)
    expect(sameBytes(out, epub)).toBe(true)
  })

  it('un ZIP inválido se devuelve intacto y no lanza', async () => {
    const junk = utf8('no soy un epub')
    const out = await epubDomain.strip(junk, 'epub', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, junk)).toBe(true)
  })

  it('un EPUB sin container.xml se devuelve intacto y no lanza', async () => {
    const noContainer = zipSync({
      mimetype: [utf8(EPUB_MIMETYPE), { level: 0 }],
      [OPF_PATH]: utf8(OPF_XML),
    })
    const out = await epubDomain.strip(noContainer, 'epub', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, noContainer)).toBe(true)
  })
})

/* ── Integración con el engine ── */

describe('epubDomain — integración con el engine', () => {
  it('engine.stripMetadata limpia un EPUB y lo verifica limpio', async () => {
    const result = await stripMetadata({
      bytes: buildEpub(),
      name: 'libro.epub',
      kind: 'epub',
      config: { mode: 'deep', blocks: [] },
    })
    expect(result.kind).toBe('epub')
    expect(result.name).toBe('libro-limpio.epub')
    const out = new Uint8Array(await result.blob.arrayBuffer())
    const entries = readZip(out)!
    expect(textOf(entries[OPF_PATH]!)).not.toContain('dc:creator')
    expect(entries['META-INF/calibre_bookmarks.txt']).toBeUndefined()
    expect(firstLocalEntry(out)).toEqual({ name: 'mimetype', method: 0 })
    expect(result.verification?.status).toBe('clean')
  })
})
