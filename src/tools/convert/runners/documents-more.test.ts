/**
 * ADEI-ONE — Tests de los runners "documentos (más)" (documents-more.ts).
 * Los fixtures ZIP se construyen con `zipSync` (fflate) y los runners se
 * ejecutan DIRECTAMENTE por su id (este dominio aún no está en el índice,
 * lo agrega el orquestador sin tocar el engine).
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { strToU8, zipSync } from 'fflate'
import { docMoreRunners } from './documents-more'
import type { ActionConfig, EngineInput, FileKind } from '@/core/types'

/** Localiza el runner por id dentro del dominio (falla si no existe). */
function runner(id: string) {
  const def = docMoreRunners.find((r) => r.id === id)
  if (!def) throw new Error(`Runner no encontrado: ${id}`)
  return def
}

/** EngineInput desde bytes ya empaquetados (ZIP o crudos) para un kind. */
function zipInput(zip: Uint8Array, name: string, kind: FileKind, id: string): EngineInput {
  return { bytes: zip, name, kind, config: { to: id } as ActionConfig }
}

/** Ejecuta un runner y devuelve el texto de su resultado. */
async function runText(id: string, input: EngineInput): Promise<string> {
  return (await runner(id).run(input)).blob.text()
}

describe('pptx → txt', () => {
  it('extrae el texto de los runs <a:t> de las diapositivas', async () => {
    const zip = zipSync({
      'ppt/slides/slide1.xml': strToU8(`<p:sld><p:txBody><a:p><a:r><a:t>Hola</a:t></a:r></a:p></p:txBody></p:sld>`),
    })
    const text = await runText('pptx-to-txt', zipInput(zip, 'diapositivas.pptx', 'pptx', 'pptx-to-txt'))
    expect(text).toContain('Hola')
    expect(text).toContain('Slide 1')
  })

  it('bytes vacíos → "Se necesita un archivo"', async () => {
    const input = zipInput(new Uint8Array(), 'vacia.pptx', 'pptx', 'pptx-to-txt')
    await expect(runner('pptx-to-txt').run(input)).rejects.toThrow('Se necesita un archivo')
  })
})

describe('pptx → pdf', () => {
  it('página el texto extraído en un PDF A4 con al menos una página', async () => {
    const zip = zipSync({
      'ppt/slides/slide1.xml': strToU8(`<p:sld><a:txBody><a:p><a:r><a:t>Hola</a:t></a:r></a:p></a:txBody></p:sld>`),
    })
    const result = await runner('pptx-to-pdf').run(
      zipInput(zip, 'diapositivas.pptx', 'pptx', 'pptx-to-pdf'),
    )
    expect(result.kind).toBe('pdf')
    const doc = await PDFDocument.load(await result.blob.arrayBuffer())
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
  })
})

describe('epub → txt', () => {
  it('quita las etiquetas y conserva el texto de los capítulos', async () => {
    const zip = zipSync({
      'mimetype': strToU8('application/epub+zip'),
      'OEBPS/ch1.xhtml': strToU8('<html><body><h1>Título</h1><p>Texto</p></body></html>'),
    })
    const text = await runText('epub-to-txt', zipInput(zip, 'libro.epub', 'epub', 'epub-to-txt'))
    expect(text).toContain('Título')
    expect(text).toContain('Texto')
    expect(text).not.toContain('<h1>')
  })

  it('bytes vacíos → "Se necesita un archivo"', async () => {
    const input = zipInput(new Uint8Array(), 'vacio.epub', 'epub', 'epub-to-txt')
    await expect(runner('epub-to-txt').run(input)).rejects.toThrow('Se necesita un archivo')
  })
})

describe('odt → txt', () => {
  it('extrae los párrafos de content.xml', async () => {
    const zip = zipSync({
      'content.xml': strToU8(
        '<office:document><office:body><text:p>Linea</text:p></office:body></office:document>',
      ),
    })
    const text = await runText('odt-to-txt', zipInput(zip, 'documento.odt', 'odt', 'odt-to-txt'))
    expect(text).toContain('Linea')
  })
})

describe('rtf → txt', () => {
  it('estripe control words y conserva la separación de párrafos', async () => {
    const input = zipInput(
      strToU8('{\\rtf1\\ansi Hola\\par Mundo} '),
      'documento.rtf',
      'rtf',
      'rtf-to-txt',
    )
    const text = await runText('rtf-to-txt', input)
    expect(text).toContain('Hola')
    expect(text).toContain('Mundo')
    expect(text).toContain('\n') // separación de párrafos (\par → salto)
  })
})