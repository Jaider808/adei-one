/**
 * ADEI-ONE — Tests de la tool "Reordenar páginas" (`pdf.rearrange`).
 *
 * Acepta `config.order` como array 1-indexed (selector visual) o como string
 * "4,1,3,2". El orden parcial se completa con `completeOrder`; el resultado
 * siempre conserva el total de páginas. Fixtures locales con pdf-lib.
 *
 * Los engines comen `EngineInput` (bytes puros), así que el fixture construye
 * un `Uint8Array` directamente, sin pasar por el `File` del navegador.
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { rearrangePages } from './engine'
import type { ActionConfig, EngineInput } from '@/core/types'

/** Crea un PDF real con `count` páginas; cada una dibuja su número (p1, p2, ...). */
async function makePdfBytes(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 1; i <= count; i++) {
    const page = doc.addPage([240, 320])
    page.drawText(`p${i}`, { x: 40, y: 160, size: 28 })
  }
  return doc.save()
}

/** Construye el EngineInput mínimo para un engine de pdf. */
function eng(bytes: Uint8Array, config: unknown): EngineInput {
  return { bytes, name: 'doc.pdf', kind: 'pdf', config: config as ActionConfig }
}

/** Reconstruye un blob de resultado y devuelve cuántas páginas trae. */
async function pageCount(blob: Blob): Promise<number> {
  const doc = await PDFDocument.load(await blob.arrayBuffer())
  return doc.getPageCount()
}

describe('rearrangePages', () => {
  it('completa el orden parcial (array) con las no marcadas al final', async () => {
    const result = await rearrangePages(eng(await makePdfBytes(4), { order: [3, 1] }))

    expect(result.name).toBe('doc-reordenado.pdf')
    expect(result.blob.type).toBe('application/pdf')
    expect(await pageCount(result.blob)).toBe(4)
  })

  it('conserva el total de páginas con orden en string', async () => {
    const result = await rearrangePages(eng(await makePdfBytes(4), { order: '4,1,3,2' }))

    expect(result.blob.type).toBe('application/pdf')
    expect(await pageCount(result.blob)).toBe(4)
  })

  it('lanza "Se necesita un archivo" si los bytes vienen vacíos', async () => {
    await expect(rearrangePages(eng(new Uint8Array(), { order: [1] }))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })
})