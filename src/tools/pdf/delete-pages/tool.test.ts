/**
 * ADEI-ONE — Tests de la tool "Eliminar páginas" (`pdf.delete-pages`).
 *
 * Acepta `config.pages` como array 1-indexed (selector visual) o como string
 * "2,5-7" que se parsea con `parsePageList`. Fixtures locales con pdf-lib.
 *
 * Los engines comen `EngineInput` (bytes puros), así que el fixture construye
 * un `Uint8Array` directamente, sin pasar por el `File` del navegador.
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { deletePages } from './engine'
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

describe('deletePages', () => {
  it('quita las páginas indicadas y conserva el resto (array visual)', async () => {
    const result = await deletePages(eng(await makePdfBytes(4), { pages: [2] }))

    expect(result.name).toBe('doc-editado.pdf')
    expect(result.blob.type).toBe('application/pdf')
    expect(await pageCount(result.blob)).toBe(3)
  })

  it('parsea la config en string "1,4" con parsePageList y borra las dos', async () => {
    const result = await deletePages(eng(await makePdfBytes(4), { pages: '1,4' }))

    expect(result.blob.type).toBe('application/pdf')
    expect(await pageCount(result.blob)).toBe(2)
  })

  it('lanza "Se necesita un archivo" si los bytes vienen vacíos', async () => {
    await expect(deletePages(eng(new Uint8Array(), { pages: [1] }))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })

  it('nunca deja un PDF vacío: eliminar todas las páginas lanza un error', async () => {
    await expect(deletePages(eng(await makePdfBytes(4), { pages: [1, 2, 3, 4] }))).rejects.toThrow(
      'No puedes eliminar todas las páginas',
    )
  })

  it('ignora páginas fuera de rango y conserva íntegro el documento', async () => {
    const result = await deletePages(eng(await makePdfBytes(4), { pages: [99] }))
    expect(await pageCount(result.blob)).toBe(4)
  })
})