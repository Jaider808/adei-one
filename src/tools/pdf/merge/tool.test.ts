/**
 * ADEI-ONE — Tests de la tool "Unir PDFs" (`pdf.merge`).
 *
 * El engine come `EngineInput` y el orquestador ya construyó `extras` con los
 * archivos adicionales (bytes puros). Fixtures locales con pdf-lib que dibujan
 * p1, p2, ... en cada página para verificar el recuento tras la unión.
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { mergePdf } from './engine'
import type { EngineInput, ProgressEvent } from '@/core/types'

/** Crea un PDF real con `count` páginas; cada una dibuja su número (p1, p2, ...). */
async function makePdfBytes(count: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  for (let i = 1; i <= count; i++) {
    const page = doc.addPage([240, 320])
    page.drawText(`p${i}`, { x: 40, y: 160, size: 28 })
  }
  return doc.save()
}

/** Construye el EngineInput mínimo para un engine de pdf (principal + extras). */
function eng(bytes: Uint8Array, extras?: EngineInput['extras']): EngineInput {
  return { bytes, name: 'doc.pdf', kind: 'pdf', config: {}, extras }
}

/** Reconstruye un blob de resultado y devuelve cuántas páginas trae. */
async function pageCount(blob: Blob): Promise<number> {
  const doc = await PDFDocument.load(await blob.arrayBuffer())
  return doc.getPageCount()
}

describe('mergePdf', () => {
  it('une 2 PDFs (3 + 2 páginas) en uno de 5 con el nombre esperado', async () => {
    const result = await mergePdf(
      eng(await makePdfBytes(3), [{ name: 'otro.pdf', bytes: await makePdfBytes(2) }]),
    )

    expect(result.kind).toBe('pdf')
    expect(result.name).toBe('doc-unido.pdf')
    expect(result.blob.type).toBe('application/pdf')
    expect(await pageCount(result.blob)).toBe(5)
  })

  it('une 3 PDFs de 1 página cada uno', async () => {
    const result = await mergePdf(
      eng(await makePdfBytes(1), [
        { name: 'b.pdf', bytes: await makePdfBytes(1) },
        { name: 'c.pdf', bytes: await makePdfBytes(1) },
      ]),
    )

    expect(result.name).toBe('doc-unido.pdf')
    expect(await pageCount(result.blob)).toBe(3)
  })

  it('lanza con nombre si un extra no es un PDF válido', async () => {
    await expect(
      mergePdf(eng(await makePdfBytes(1), [{ name: 'x.pdf', bytes: new Uint8Array([0, 1]) }])),
    ).rejects.toThrow(/No se pudo leer el PDF/)
  })

  it('lanza "Se necesita un archivo" si los bytes vienen vacíos', async () => {
    await expect(mergePdf(eng(new Uint8Array()))).rejects.toThrow('Se necesita un archivo')
  })

  it('con un solo documento devuelve un PDF con el mismo número de páginas', async () => {
    const result = await mergePdf(eng(await makePdfBytes(4)))

    expect(result.name).toBe('doc-unido.pdf')
    expect(await pageCount(result.blob)).toBe(4)
  })

  it('onProgress opcional emite la fase final con percent 100', async () => {
    const events: ProgressEvent[] = []
    const onProgress = (e: ProgressEvent) => events.push(e)
    const result = await mergePdf(
      eng(await makePdfBytes(1), [{ name: 'b.pdf', bytes: await makePdfBytes(1) }]),
      onProgress,
    )

    expect(result.kind).toBe('pdf')
    const last = events[events.length - 1]
    expect(last?.phase).toBe('Listo')
    expect(last?.percent).toBe(100)
  })
})