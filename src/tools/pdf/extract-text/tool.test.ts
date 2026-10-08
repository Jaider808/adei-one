/**
 * ADEI-ONE — Tests de "Extraer texto" (`pdf.extract-text`).
 * Fixture con pdf-lib: una página con `drawText('Hola mundo')`; el engine debe
 * devolver un .txt cuyo contenido contiene esa frase (pdf.js lo lee).
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { extractPdfText } from './engine'
import type { EngineInput, FileKind } from '@/core/types'

/** Construye un `EngineInput` a partir de bytes puros (config vacío: sin opciones). */
function eng(bytes: Uint8Array, name: string, kind: FileKind): EngineInput {
  return { bytes, name, kind, config: {} }
}

/** PDF de una página con el texto indicado dibujado (fuente estándar). */
async function pdfWithText(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([300, 300])
  page.drawText(text, { x: 50, y: 250, size: 24 })
  return doc.save()
}

describe('extractPdfText', () => {
  it('extrae el texto a un .txt plano', async () => {
    const result = await extractPdfText(eng(await pdfWithText('Hola mundo'), 'doc.pdf', 'pdf'))
    expect(result.kind).toBe('txt')
    expect(result.name).toBe('doc-texto.txt')

    const text = new TextDecoder().decode(await result.blob.arrayBuffer())
    expect(text).toContain('Hola mundo')
  })

  it('bytes vacíos: guardia clara', async () => {
    await expect(extractPdfText(eng(new Uint8Array(), 'doc.pdf', 'pdf'))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })
})