/**
 * ADEI-ONE — Tests de "Comprimir PDF" (`pdf.compress`).
 * Fixture con pdf-lib: PDF de N páginas con Título/Autor; el resultado debe
 * re-serializarse conservando las páginas y con la metadata ya vacía.
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { compressPdf } from './engine'
import type { EngineInput, FileKind } from '@/core/types'

/** Construye un `EngineInput` a partir de bytes puros (config vacío: sin opciones). */
function eng(bytes: Uint8Array, name: string, kind: FileKind): EngineInput {
  return { bytes, name, kind, config: {} }
}

/** Bytes del blob de un resultado (para re-abrir el PDF con pdf-lib). */
async function bytesOf(result: { blob: Blob }): Promise<Uint8Array> {
  return new Uint8Array(await result.blob.arrayBuffer())
}

/** PDF de `pages` páginas con metadata (Título 'X', Autor 'A'). */
async function makePdfBytes(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle('X')
  doc.setAuthor('A')
  for (let i = 0; i < pages; i++) doc.addPage()
  return doc.save()
}

describe('compressPdf', () => {
  it('re-escribe el PDF (2 páginas) y vacía la metadata', async () => {
    const result = await compressPdf(eng(await makePdfBytes(2), 'doc.pdf', 'pdf'))
    expect(result.kind).toBe('pdf')
    expect(result.name).toBe('doc-comprimido.pdf')

    const out = await PDFDocument.load(await bytesOf(result))
    expect(out.getPageCount()).toBe(2)
    // setTitle('') deja la clave con valor vacío en el Info dict: getTitle()=''
    expect(out.getTitle()).toBe('')
    expect(out.getAuthor()).toBe('')
  })

  it('bytes vacíos: guardia clara', async () => {
    await expect(compressPdf(eng(new Uint8Array(), 'doc.pdf', 'pdf'))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })
})