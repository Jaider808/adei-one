/**
 * ADEI-ONE — Tests del dominio SVG de "Eliminar metadata" (`svg.ts`).
 *
 * Fixtures de texto SVG realista (estilo editor Inkscape/Sodipodi). Cirugía
 * pura sobre bytes → se prueban en Node sin DOM. Incluye integración con el
 * engine (`./engine`) y comprobación de que el resultado re-parsea como XML.
 */
import { describe, expect, it } from 'vitest'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { svgDomain } from './svg'
import { scanMetadata, stripMetadata } from './engine'

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

const noop = (): void => {}

/* ── Fixtures ── */

/** SVG típico de editor: declaración, comentario, metadata RDF, title/desc y editor. */
const EDITOR_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Exportado por el editor -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd" width="100" height="100" viewBox="0 0 100 100" version="1.1" inkscape:version="1.3" sodipodi:docname="dibujo.svg">
  <metadata>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <dc:title>Mi dibujo</dc:title>
      <dc:creator>Ana</dc:creator>
    </rdf:RDF>
  </metadata>
  <title>Dibujo de prueba</title>
  <desc>Un cuadrado azul</desc>
  <sodipodi:namedview id="nv" pagecolor="#ffffff" inkscape:showpageshadow="2"/>
  <g inkscape:label="Capa 1" inkscape:groupmode="layer" id="layer1" data-name="Capa Figma">
    <rect x="10" y="10" width="80" height="80" fill="#3366cc"/>
  </g>
</svg>
`

/** SVG limpio: solo geometría y atributos estructurales (sin metadata). */
const CLEAN_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" version="1.1">
  <rect x="0" y="0" width="10" height="10"/>
</svg>
`

/** SVG mal formado: etiquetas cruzadas. */
const MALFORMED_SVG = '<svg><rect></svg>'

const EDITOR = utf8(EDITOR_SVG)
const CLEAN = utf8(CLEAN_SVG)
const MALFORMED = utf8(MALFORMED_SVG)

/* ── Dominio ── */

describe('svgDomain — contrato', () => {
  it('declara el kind svg', () => {
    expect(svgDomain.kinds).toEqual(['svg'])
  })
})

/* ── Escaneo ── */

describe('svgDomain — escaneo (inventario)', () => {
  it('enumera metadata, título/descripción, comentario y editor con rutas reales', async () => {
    const report = await svgDomain.scan(EDITOR)
    const wheres = report.entries.map((entry) => entry.where)
    expect(wheres).toEqual(
      expect.arrayContaining([
        'svg > metadata',
        'svg > title',
        'svg > desc',
        'comentario XML',
        'atributo @inkscape:version',
      ]),
    )
    const ids = report.blocks.map((block) => block.id)
    expect(ids).toEqual(expect.arrayContaining(['metadata', 'title', 'comments', 'editor', 'format']))
  })

  it('enumera los elementos del editor (namedview) con su ruta', async () => {
    const report = await svgDomain.scan(EDITOR)
    expect(report.entries.some((entry) => entry.where === 'svg > sodipodi:namedview')).toBe(true)
    expect(report.entries.some((entry) => entry.where === 'atributo @data-name')).toBe(true)
  })

  it('el removal del inventario es honesto: metadata borrable, format nunca', async () => {
    const report = await svgDomain.scan(EDITOR)
    expect(report.entries.find((entry) => entry.where === 'svg > metadata')?.removal).toBe('with-container')
    expect(report.entries.find((entry) => entry.key === 'viewBox')?.removal).toBe('never')
  })

  it('engine.scanMetadata(svg) ya no devuelve el report vacío', async () => {
    const report = await scanMetadata({ bytes: EDITOR, kind: 'svg' })
    expect(report.entries.length).toBeGreaterThan(0)
    expect(report.entries.some((entry) => entry.where === 'svg > metadata')).toBe(true)
  })
})

/* ── Limpieza ── */

describe('svgDomain — limpieza quirúrgica', () => {
  it('light con los cuatro bloques elimina metadata, comentarios y editor', async () => {
    const out = await svgDomain.strip(EDITOR, 'svg', { mode: 'light', blocks: ['metadata', 'title', 'comments', 'editor'] }, noop)
    const text = textOf(out)
    expect(text).not.toContain('<metadata')
    expect(text).not.toContain('<!--')
    expect(text).not.toContain('inkscape:')
    expect(text).not.toContain('sodipodi:')
    expect(text).not.toContain('data-name')
    expect(text).toContain('<rect')
  })

  it('light solo con metadata conserva título y descripción', async () => {
    const out = await svgDomain.strip(EDITOR, 'svg', { mode: 'light', blocks: ['metadata'] }, noop)
    const text = textOf(out)
    expect(text).not.toContain('<metadata')
    expect(text).toContain('<title>Dibujo de prueba</title>')
    expect(text).toContain('<desc>Un cuadrado azul</desc>')
  })

  it('el resultado sigue siendo XML bien formado y el dibujo está intacto', async () => {
    const out = await svgDomain.strip(EDITOR, 'svg', { mode: 'deep', blocks: [] }, noop)
    const text = textOf(out)
    expect(XMLValidator.validate(text)).toBe(true)
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(text) as Record<string, any>
    expect(parsed.svg).toBeDefined()
    expect(parsed.svg.g).toBeDefined()
    expect(parsed.svg.g.rect).toBeDefined()
    expect(parsed.svg.metadata).toBeUndefined()
  })

  it('deep elimina todos los bloques', async () => {
    const out = await svgDomain.strip(EDITOR, 'svg', { mode: 'deep', blocks: [] }, noop)
    const text = textOf(out)
    expect(text).not.toContain('<metadata')
    expect(text).not.toContain('<title')
    expect(text).not.toContain('<desc')
    expect(text).not.toContain('<!--')
    expect(text).not.toContain('inkscape:')
    expect(text).not.toContain('sodipodi:')
  })

  it('un SVG sin metadata no cambia (byte a byte) incluso en deep', async () => {
    const out = await svgDomain.strip(CLEAN, 'svg', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, CLEAN)).toBe(true)
  })

  it('un SVG inválido se devuelve intacto y no lanza', async () => {
    const out = await svgDomain.strip(MALFORMED, 'svg', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, MALFORMED)).toBe(true)
  })

  it('light sin bloques es passthrough byte a byte', async () => {
    const out = await svgDomain.strip(EDITOR, 'svg', { mode: 'light', blocks: [] }, noop)
    expect(sameBytes(out, EDITOR)).toBe(true)
  })
})

/* ── Integración con el engine ── */

describe('svgDomain — integración con el engine', () => {
  it('engine.stripMetadata limpia un SVG y conserva el dibujo', async () => {
    const result = await stripMetadata({
      bytes: EDITOR,
      name: 'dibujo.svg',
      kind: 'svg',
      config: { mode: 'light', blocks: ['metadata', 'title', 'comments', 'editor'] },
    })
    expect(result.kind).toBe('svg')
    expect(result.name).toBe('dibujo-limpio.svg')
    const out = new Uint8Array(await result.blob.arrayBuffer())
    const text = textOf(out)
    expect(text).not.toContain('<metadata')
    expect(text).toContain('<rect')
    expect(XMLValidator.validate(text)).toBe(true)
    expect(result.verification?.status).toBe('clean')
  })
})
