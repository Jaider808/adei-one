/**
 * ADEI-ONE — Tests del dominio HTML de "Eliminar metadata" (`html.ts`).
 *
 * Cirugía pura sobre bytes → se prueban en Node sin DOM. Cubre:
 * - escaneo con rutas `where` reales (ya no "no hay metadata");
 * - limpieza quirúrgica byte a byte;
 * - invariante de seguridad: `charset`, `http-equiv` y `viewport` sobreviven;
 * - ceguera a `<script>`, `<style>` y comentarios;
 * - etiquetas multilínea, passthrough y ausencia de excepciones.
 */
import { describe, expect, it } from 'vitest'
import { htmlDomain } from './html'
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

const AUTHOR_TAG = '<meta name="author" content="Ana López">'
const GENERATOR_TAG = '<meta name="generator" content="WordPress 6.4">'
const DESCRIPTION_TAG = '<meta name="description" content="Una página de ejemplo">'
const OG_TITLE_TAG = '<meta property="og:title" content="Ejemplo">'
const LINK_AUTHOR_TAG = '<link rel="author" href="https://example.com/ana">'

/** HTML típico con metadata real y etiquetas funcionales que deben sobrevivir. */
const METADATA_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${AUTHOR_TAG}
  ${GENERATOR_TAG}
  ${DESCRIPTION_TAG}
  ${OG_TITLE_TAG}
  ${LINK_AUTHOR_TAG}
  <title>Ejemplo</title>
</head>
<body>
  <h1>Hola</h1>
</body>
</html>
`

/** El mismo documento sin las etiquetas de metadata (resto byte a byte). */
const METADATA_HTML_CLEANED = METADATA_HTML.replace(AUTHOR_TAG, '')
  .replace(GENERATOR_TAG, '')
  .replace(DESCRIPTION_TAG, '')
  .replace(OG_TITLE_TAG, '')
  .replace(LINK_AUTHOR_TAG, '')

/** `<meta` dentro de una cadena JS, de una regla CSS y de un comentario. */
const BLIND_HTML = `<!DOCTYPE html>
<html>
<head>
  <script>var plantilla = '<meta name="author" content="desde-js">';</script>
  <style>/* <meta name="author" content="desde-css"> */</style>
  <!-- <meta name="author" content="desde-comentario"> -->
</head>
<body></body>
</html>
`

/** Etiqueta multilínea con atributo entrecomillado. */
const MULTILINE_TAG = '<meta name="author"\n        content="Ana López">'
const MULTILINE_HTML = `<!DOCTYPE html>
<html>
<head>
  ${MULTILINE_TAG}
  <meta charset="utf-8">
</head>
</html>
`

/** HTML sin metadata alguna (solo etiquetas funcionales). */
const CLEAN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Limpio</title>
</head>
<body>Hola</body>
</html>
`

/** HTML no interpretable: `<meta>` sin cerrar. */
const MALFORMED_HTML = '<!DOCTYPE html>\n<html><head><meta name="author" content="Ana"'

/** HTML no interpretable: `<script>` sin cerrar. */
const UNTERMINATED_SCRIPT = '<!DOCTYPE html>\n<head><script>var x = 1;'

/** HTML no interpretable: comentario sin cerrar (`<!--` sin `-->`). */
const UNCLOSED_COMMENT = '<!DOCTYPE html>\n<head><!-- sin cerrar <meta name="author" content="Ana">'

/** HTML no interpretable: `<title>` sin cerrar. */
const UNTERMINATED_TITLE = '<!DOCTYPE html>\n<head><title>Sin cerrar'

/** HTML no interpretable: `<textarea>` sin cerrar. */
const UNTERMINATED_TEXTAREA = '<!DOCTYPE html>\n<body><textarea>Sin cerrar'

/** `<meta>` literales dentro de RCDATA/RAWTEXT: NO son etiquetas. */
const RAW_TEXT_HTML = `<!DOCTYPE html>
<html>
<head>
  <title><meta name="author" content="desde-titulo"></title>
</head>
<body>
  <textarea><meta name="author" content="desde-textarea"></textarea>
  <xmp><meta name="author" content="desde-xmp"></xmp>
  <noscript><meta name="author" content="desde-noscript"></noscript>
</body>
</html>
`

/** `<plaintext>`: todo lo que sigue es texto; el `<meta>` literal no es etiqueta. */
const PLAINTEXT_HTML = '<!DOCTYPE html>\n<html>\n<body>\n  <plaintext><meta name="author" content="desde-plaintext">\n</body>\n</html>\n'

/** `<meta>` real ubicado en el `<body>`: su ruta NO debe decir `head`. */
const BODY_META_HTML = `<!DOCTYPE html>
<html>
<head><title>Ejemplo</title></head>
<body>
  <meta name="author" content="Ana">
</body>
</html>
`

const METADATA = utf8(METADATA_HTML)
const BLIND = utf8(BLIND_HTML)
const MULTILINE = utf8(MULTILINE_HTML)
const CLEAN = utf8(CLEAN_HTML)
const MALFORMED = utf8(MALFORMED_HTML)
const UNTERMINATED = utf8(UNTERMINATED_SCRIPT)
const UNCLOSED = utf8(UNCLOSED_COMMENT)
const UNTERMINATED_TITLE_BYTES = utf8(UNTERMINATED_TITLE)
const UNTERMINATED_TEXTAREA_BYTES = utf8(UNTERMINATED_TEXTAREA)
const RAW_TEXT = utf8(RAW_TEXT_HTML)
const PLAINTEXT = utf8(PLAINTEXT_HTML)
const BODY_META = utf8(BODY_META_HTML)

/* ── Dominio ── */

describe('htmlDomain — contrato', () => {
  it('declara el kind html', () => {
    expect(htmlDomain.kinds).toEqual(['html'])
  })
})

/* ── Escaneo ── */

describe('htmlDomain — escaneo (inventario)', () => {
  it('enumera los <meta> de metadata con su ruta real', async () => {
    const report = await htmlDomain.scan(METADATA)
    const wheres = report.entries.map((entry) => entry.where)
    expect(wheres).toContain('head > meta[name=author]')
    expect(wheres).toContain('head > meta[name=generator]')
    expect(wheres).toContain('head > meta[name=description]')
    expect(wheres).toContain('head > meta[property=og:title]')
  })

  it('enumera los <link rel="author|me|publisher"> con su ruta', async () => {
    const report = await htmlDomain.scan(METADATA)
    expect(report.entries.some((entry) => entry.where === 'head > link[rel=author]')).toBe(true)
  })

  it('un <meta> en el <body> no se reporta como si estuviera en <head>', async () => {
    const report = await htmlDomain.scan(BODY_META)
    const entry = report.entries.find((item) => item.key === 'author')
    expect(entry).toBeDefined()
    expect(entry?.where).not.toContain('head')
    expect(entry?.where).toContain('body')
  })

  it('reporta el bloque format (doctype/charset/viewport) con removal never', async () => {
    const report = await htmlDomain.scan(METADATA)
    expect(report.blocks.map((block) => block.id)).toContain('format')
    expect(report.entries.find((entry) => entry.key === 'doctype')?.removal).toBe('never')
    expect(report.entries.find((entry) => entry.key === 'charset')?.value).toBe('utf-8')
    expect(report.entries.find((entry) => entry.key === 'viewport')?.value).toBe('Sí')
    expect(report.entries.find((entry) => entry.key === 'viewport')?.removal).toBe('never')
  })

  it('el removal del inventario es honesto: meta borrable, format nunca', async () => {
    const report = await htmlDomain.scan(METADATA)
    expect(report.entries.find((entry) => entry.where === 'head > meta[name=author]')?.removal).toBe('with-container')
    expect(report.entries.find((entry) => entry.key === 'charset')?.removal).toBe('never')
  })

  it('engine.scanMetadata(html) ya no devuelve el report vacío', async () => {
    const report = await scanMetadata({ bytes: METADATA, kind: 'html' })
    expect(report.entries.length).toBeGreaterThan(0)
    expect(report.entries.some((entry) => entry.where === 'head > meta[name=author]')).toBe(true)
  })
})

/* ── Ceguera a regiones no-etiqueta ── */

describe('htmlDomain — ciego a script/style/comentarios', () => {
  it('no reporta un <meta> dentro de <script>, <style> ni comentario', async () => {
    const report = await htmlDomain.scan(BLIND)
    const values = report.entries.map((entry) => entry.value)
    expect(values).not.toContain('desde-js')
    expect(values).not.toContain('desde-css')
    expect(values).not.toContain('desde-comentario')
    expect(report.entries.some((entry) => entry.key === 'author')).toBe(false)
  })

  it('no elimina nada de esas regiones (deep es byte a byte idéntico)', async () => {
    const out = await htmlDomain.strip(BLIND, 'html', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, BLIND)).toBe(true)
    expect(textOf(out)).toContain('desde-js')
    expect(textOf(out)).toContain('desde-css')
    expect(textOf(out)).toContain('desde-comentario')
  })

  it('no reporta un <meta> dentro de <title>, <textarea>, <xmp> ni <noscript>', async () => {
    const report = await htmlDomain.scan(RAW_TEXT)
    const values = report.entries.map((entry) => entry.value)
    expect(values).not.toContain('desde-titulo')
    expect(values).not.toContain('desde-textarea')
    expect(values).not.toContain('desde-xmp')
    expect(values).not.toContain('desde-noscript')
    expect(report.entries.some((entry) => entry.key === 'author')).toBe(false)
  })

  it('no elimina nada de RCDATA/RAWTEXT (deep es byte a byte idéntico)', async () => {
    const out = await htmlDomain.strip(RAW_TEXT, 'html', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, RAW_TEXT)).toBe(true)
    expect(textOf(out)).toContain('desde-titulo')
    expect(textOf(out)).toContain('desde-textarea')
    expect(textOf(out)).toContain('desde-xmp')
    expect(textOf(out)).toContain('desde-noscript')
  })

  it('<plaintext> vuelve opaco el resto del documento (sin reportar ni borrar)', async () => {
    const report = await htmlDomain.scan(PLAINTEXT)
    expect(report.entries.some((entry) => entry.value === 'desde-plaintext')).toBe(false)
    const out = await htmlDomain.strip(PLAINTEXT, 'html', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, PLAINTEXT)).toBe(true)
    expect(textOf(out)).toContain('desde-plaintext')
  })
})

/* ── Limpieza quirúrgica ── */

describe('htmlDomain — limpieza quirúrgica', () => {
  it('light con meta+links elimina esas etiquetas y deja el resto byte a byte igual', async () => {
    const out = await htmlDomain.strip(METADATA, 'html', { mode: 'light', blocks: ['meta', 'links'] }, noop)
    expect(textOf(out)).toBe(METADATA_HTML_CLEANED)
    const text = textOf(out)
    expect(text).not.toContain('name="author"')
    expect(text).not.toContain('name="generator"')
    expect(text).not.toContain('name="description"')
    expect(text).not.toContain('og:title')
  })

  it('charset, http-equiv y viewport SOBREVIVEN intactos', async () => {
    const out = await htmlDomain.strip(METADATA, 'html', { mode: 'deep', blocks: [] }, noop)
    const text = textOf(out)
    expect(text).toContain('<meta charset="utf-8">')
    expect(text).toContain('<meta http-equiv="X-UA-Compatible" content="IE=edge">')
    expect(text).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">')
  })

  it('light solo con meta conserva los enlaces de autoría', async () => {
    const out = await htmlDomain.strip(METADATA, 'html', { mode: 'light', blocks: ['meta'] }, noop)
    const text = textOf(out)
    expect(text).not.toContain('name="author"')
    expect(text).toContain(LINK_AUTHOR_TAG)
  })

  it('elimina una etiqueta multilínea ENTERA', async () => {
    const out = await htmlDomain.strip(MULTILINE, 'html', { mode: 'light', blocks: ['meta'] }, noop)
    const text = textOf(out)
    expect(text).not.toContain('name="author"')
    expect(text).not.toContain('Ana López')
    expect(text).toContain('<meta charset="utf-8">')
    expect(text).toBe(MULTILINE_HTML.replace(MULTILINE_TAG, ''))
  })

  it('un HTML sin metadata no cambia (byte a byte) incluso en deep', async () => {
    const out = await htmlDomain.strip(CLEAN, 'html', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, CLEAN)).toBe(true)
  })

  it('un HTML inválido (meta sin cerrar) se devuelve intacto y no lanza', async () => {
    const out = await htmlDomain.strip(MALFORMED, 'html', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, MALFORMED)).toBe(true)
  })

  it('un <script> sin cerrar aborta el escaneo y hace passthrough sin lanzar', async () => {
    const out = await htmlDomain.strip(UNTERMINATED, 'html', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, UNTERMINATED)).toBe(true)
  })

  it('un comentario sin cerrar aborta el escaneo y hace passthrough sin lanzar', async () => {
    const report = await htmlDomain.scan(UNCLOSED)
    expect(report.entries).toEqual([])
    const out = await htmlDomain.strip(UNCLOSED, 'html', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, UNCLOSED)).toBe(true)
  })

  it('un <title> sin cerrar aborta el escaneo y hace passthrough sin lanzar', async () => {
    const out = await htmlDomain.strip(UNTERMINATED_TITLE_BYTES, 'html', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, UNTERMINATED_TITLE_BYTES)).toBe(true)
  })

  it('un <textarea> sin cerrar aborta el escaneo y hace passthrough sin lanzar', async () => {
    const out = await htmlDomain.strip(UNTERMINATED_TEXTAREA_BYTES, 'html', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, UNTERMINATED_TEXTAREA_BYTES)).toBe(true)
  })

  it('light sin bloques es passthrough byte a byte', async () => {
    const out = await htmlDomain.strip(METADATA, 'html', { mode: 'light', blocks: [] }, noop)
    expect(sameBytes(out, METADATA)).toBe(true)
  })
})

/* ── Integración con el engine ── */

describe('htmlDomain — integración con el engine', () => {
  it('engine.stripMetadata limpia un HTML y verifica clean', async () => {
    const result = await stripMetadata({
      bytes: METADATA,
      name: 'pagina.html',
      kind: 'html',
      config: { mode: 'light', blocks: ['meta', 'links'] },
    })
    expect(result.kind).toBe('html')
    expect(result.name).toBe('pagina-limpio.html')
    const out = new Uint8Array(await result.blob.arrayBuffer())
    const text = textOf(out)
    expect(text).not.toContain('name="author"')
    expect(text).not.toContain('og:title')
    expect(text).toContain('<meta charset="utf-8">')
    expect(result.verification?.status).toBe('clean')
  })
})
