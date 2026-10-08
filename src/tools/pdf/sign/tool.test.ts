/**
 * ADEI-ONE — Tests de "Firmar PDF" (`pdf.sign`).
 * Se valida que el sello realmente quedó en el PDF extrayendo el texto con
 * pdf.js (getTextContent funciona en Node sin canvas).
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { signPdf } from './engine'
import type { ActionConfig, EngineInput } from '@/core/types'

async function makePdfBytes(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 1; i <= count; i++) {
    const page = doc.addPage([400, 500])
    page.drawText(`pagina ${i}`, { x: 40, y: 240, size: 24 })
  }
  return doc.save()
}

function eng(bytes: Uint8Array, config: unknown): EngineInput {
  return { bytes, name: 'contrato.pdf', kind: 'pdf', config: config as ActionConfig }
}

/** Extrae el texto de un PDF con pdf.js (build legacy, funciona en Node). */
async function extractText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({ data: bytes }).promise
  const page = await doc.getPage(1)
  const content = await page.getTextContent()
  await doc.loadingTask.destroy()
  return content.items
    .map((item) => (item as { str?: string }).str ?? '')
    .join(' ')
}

describe('signPdf', () => {
  it('añade el texto de la firma en todas las páginas y conserva el total', async () => {
    const result = await signPdf(
      eng(await makePdfBytes(3), { text: 'Aprobado', pages: 'todas', position: 'abajo' }),
    )

    expect(result.name).toBe('contrato-firmado.pdf')
    expect(result.kind).toBe('pdf')
    const doc = await PDFDocument.load(await result.blob.arrayBuffer())
    expect(doc.getPageCount()).toBe(3)

    const texto = await extractText(new Uint8Array(await result.blob.arrayBuffer()))
    expect(texto).toContain('Aprobado')
  })

  it('si solo se firma la primera página, el sello aparece solo ahí', async () => {
    const result = await signPdf(
      eng(await makePdfBytes(3), { text: 'Firmado', pages: 'primera', position: 'arriba' }),
    )
    const texto = await extractText(new Uint8Array(await result.blob.arrayBuffer()))
    expect(texto).toContain('Firmado')
  })

  it('usa un texto por defecto y no rompe con config vacía', async () => {
    const result = await signPdf(eng(await makePdfBytes(1), {}))
    const texto = await extractText(new Uint8Array(await result.blob.arrayBuffer()))
    expect(texto.length).toBeGreaterThan(0)
  })

  it('lanza "Se necesita un archivo" con bytes vacíos', async () => {
    await expect(signPdf(eng(new Uint8Array(), { text: 'x' }))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })
})