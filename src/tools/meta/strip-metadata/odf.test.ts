/**
 * ADEI-ONE — Tests del dominio ODT de "Eliminar metadata" (`odf.ts`).
 *
 * Se construye un ODT realista en memoria (meta.xml con autor/fechas/generador,
 * settings.xml y Thumbnails/thumbnail.png, con su META-INF/manifest.xml). Se
 * comprueba el escaneo, la limpieza por bloques, la coherencia del manifest y
 * que el ZIP resultante conserva `mimetype` primero y almacenado.
 */
import { describe, expect, it } from 'vitest'
import { XMLValidator } from 'fast-xml-parser'
import { zipSync } from 'fflate'
import { odfDomain } from './odf'
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

const MIMETYPE = 'application/vnd.oasis.opendocument.text'

const META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.2">
  <office:meta>
    <dc:creator>Ana</dc:creator>
    <meta:initial-creator>Ana</meta:initial-creator>
    <dc:date>2024-01-02T03:04:05Z</dc:date>
    <meta:creation-date>2024-01-02T03:04:05Z</meta:creation-date>
    <meta:generator>LibreOffice/7.6</meta:generator>
    <meta:editing-cycles>3</meta:editing-cycles>
    <meta:editing-duration>PT1H2M</meta:editing-duration>
    <dc:title>Informe</dc:title>
    <dc:description>Descripción de prueba</dc:description>
    <dc:subject>Asunto</dc:subject>
    <meta:keyword>clave1</meta:keyword>
    <meta:keyword>clave2</meta:keyword>
    <meta:user-defined meta:name="Proyecto">ADEI</meta:user-defined>
  </office:meta>
</office:document-meta>
`

const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" office:version="1.2">
  <office:settings>
    <config:config-item-set config:name="ooo:view-settings">
      <config:config-item config:name="ViewAreaTop" config:type="int">0</config:config-item>
      <config:config-item config:name="ZoomValue" config:type="int">100</config:config-item>
    </config:config-item-set>
  </office:settings>
</office:document-settings>
`

const MANIFEST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">
  <manifest:file-entry manifest:full-path="/" manifest:version="1.2" manifest:media-type="application/vnd.oasis.opendocument.text"/>
  <manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/>
  <manifest:file-entry manifest:full-path="Thumbnails/thumbnail.png" manifest:media-type="image/png"/>
</manifest:manifest>
`

const CONTENT_XML = '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"><office:body><office:text><text:p xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">Hola</text:p></office:text></office:body></office:document-content>'

/** Construye un ODT de prueba con `mimetype` primero y almacenado. */
function buildOdt(meta: string = META_XML): Uint8Array {
  return zipSync({
    mimetype: [utf8(MIMETYPE), { level: 0 }],
    'META-INF/manifest.xml': utf8(MANIFEST_XML),
    'content.xml': utf8(CONTENT_XML),
    'styles.xml': utf8('<office:document-styles/>'),
    'meta.xml': utf8(meta),
    'settings.xml': utf8(SETTINGS_XML),
    'Thumbnails/thumbnail.png': utf8('fake-png-bytes'),
  })
}

/* ── Contrato ── */

describe('odfDomain — contrato', () => {
  it('declara el kind odt', () => {
    expect(odfDomain.kinds).toEqual(['odt'])
  })
})

/* ── Escaneo ── */

describe('odfDomain — escaneo (inventario)', () => {
  it('enumera meta.xml, settings.xml y la miniatura con rutas reales', async () => {
    const report = await odfDomain.scan(buildOdt())
    const wheres = report.entries.map((entry) => entry.where)
    expect(wheres).toEqual(
      expect.arrayContaining([
        'meta.xml > dc:creator',
        'meta.xml > meta:initial-creator',
        'meta.xml > dc:date',
        'meta.xml > meta:generator',
        'meta.xml > meta:editing-cycles',
        'meta.xml > dc:title',
        'meta.xml > meta:keyword',
        'meta.xml > meta:user-defined',
      ]),
    )
    expect(wheres.some((where) => where.startsWith('settings.xml'))).toBe(true)
    expect(wheres).toContain('Thumbnails/thumbnail.png')
    const ids = report.blocks.map((block) => block.id)
    expect(ids).toEqual(expect.arrayContaining(['meta', 'settings', 'thumb', 'format']))
  })

  it('el removal del inventario es honesto: metadata borrable, format nunca', async () => {
    const report = await odfDomain.scan(buildOdt())
    expect(report.entries.find((entry) => entry.where === 'meta.xml > dc:creator')?.removal).toBe('with-container')
    expect(report.entries.find((entry) => entry.key === 'mimetype')?.removal).toBe('never')
  })

  it('engine.scanMetadata(odt) ya no devuelve el report vacío', async () => {
    const report = await scanMetadata({ bytes: buildOdt(), kind: 'odt' })
    expect(report.entries.length).toBeGreaterThan(0)
    expect(report.entries.some((entry) => entry.where === 'meta.xml > dc:creator')).toBe(true)
  })
})

/* ── Limpieza ── */

describe('odfDomain — limpieza', () => {
  it('meta: elimina autor, generador y fechas y deja meta.xml bien formado', async () => {
    const out = await odfDomain.strip(buildOdt(), 'odt', { mode: 'light', blocks: ['meta'] }, noop)
    const entries = readZip(out)!
    const meta = textOf(entries['meta.xml']!)
    expect(meta).not.toContain('dc:creator')
    expect(meta).not.toContain('meta:generator')
    expect(meta).not.toContain('2024-01-02')
    expect(XMLValidator.validate(meta)).toBe(true)
    expect(meta).toContain('<office:document-meta')
    expect(meta).toContain('xmlns:office=')
    // Los otros bloques siguen intactos.
    expect(entries['settings.xml']).toBeDefined()
    expect(entries['Thumbnails/thumbnail.png']).toBeDefined()
  })

  it('meta: si el meta.xml limpio no es XML bien formado, passthrough byte a byte', async () => {
    const brokenMeta = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0">
  <office:meta><dc:creator>Ana</dc:creator></office:meta>
  <office:roto>
</office:document-meta>
`
    const odt = buildOdt(brokenMeta)
    const out = await odfDomain.strip(odt, 'odt', { mode: 'light', blocks: ['meta'] }, noop)
    expect(sameBytes(out, odt)).toBe(true)
  })

  it('settings + thumb: elimina las entradas y sus referencias del manifest', async () => {
    const out = await odfDomain.strip(buildOdt(), 'odt', { mode: 'light', blocks: ['settings', 'thumb'] }, noop)
    const entries = readZip(out)!
    expect(entries['settings.xml']).toBeUndefined()
    expect(entries['Thumbnails/thumbnail.png']).toBeUndefined()
    const manifest = textOf(entries['META-INF/manifest.xml']!)
    expect(manifest).not.toContain('settings.xml')
    expect(manifest).not.toContain('thumbnail.png')
    expect(manifest).toContain('content.xml')
    expect(manifest).toContain('meta.xml')
    expect(XMLValidator.validate(manifest)).toBe(true)
  })

  it('mimetype sigue siendo la primera entrada y almacenada', async () => {
    const out = await odfDomain.strip(buildOdt(), 'odt', { mode: 'deep', blocks: [] }, noop)
    expect(firstLocalEntry(out)).toEqual({ name: 'mimetype', method: 0 })
  })

  it('light sin bloques es passthrough byte a byte', async () => {
    const odt = buildOdt()
    const out = await odfDomain.strip(odt, 'odt', { mode: 'light', blocks: [] }, noop)
    expect(sameBytes(out, odt)).toBe(true)
  })

  it('un ZIP inválido se devuelve intacto y no lanza', async () => {
    const junk = utf8('no soy un zip')
    const out = await odfDomain.strip(junk, 'odt', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, junk)).toBe(true)
  })
})

/* ── Integración con el engine ── */

describe('odfDomain — integración con el engine', () => {
  it('engine.stripMetadata limpia un ODT y lo verifica limpio', async () => {
    const result = await stripMetadata({
      bytes: buildOdt(),
      name: 'informe.odt',
      kind: 'odt',
      config: { mode: 'deep', blocks: [] },
    })
    expect(result.kind).toBe('odt')
    expect(result.name).toBe('informe-limpio.odt')
    const out = new Uint8Array(await result.blob.arrayBuffer())
    const entries = readZip(out)!
    expect(textOf(entries['meta.xml']!)).not.toContain('dc:creator')
    expect(entries['settings.xml']).toBeUndefined()
    expect(entries['Thumbnails/thumbnail.png']).toBeUndefined()
    expect(firstLocalEntry(out)).toEqual({ name: 'mimetype', method: 0 })
    expect(result.verification?.status).toBe('clean')
  })
})
