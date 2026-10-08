/**
 * ADEI-ONE — Tests de la tool "Dividir PDF" (`pdf.split`).
 *
 * Fixtures locales con pdf-lib; los resultados se validan reconstruyendo el
 * PDF con `PDFDocument.load` y comprobando `getPageCount()`. El ZIP del modo
 * "cada"/"separado" se inspecciona con `unzipSync` de fflate.
 *
 * Los engines comen `EngineInput` (bytes puros), así que el fixture construye
 * un `Uint8Array` directamente, sin pasar por el `File` del navegador.
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { unzipSync } from 'fflate'
import { splitPdf } from './engine'
import { completeOrder, parsePageList } from '@/tools/common/pdf-helpers'
import type { ActionConfig, EngineInput, ProgressEvent } from '@/core/types'

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

describe('parsePageList', () => {
  it('soporta rangos inclusivos y listas', () => {
    expect(parsePageList('1-3,5')).toEqual([1, 2, 3, 5])
  })

  it('descarta tokens inválidos y entradas vacías', () => {
    expect(parsePageList('2,a,4')).toEqual([2, 4])
    expect(parsePageList('')).toEqual([])
  })
})

describe('completeOrder', () => {
  it('completa órdenes parciales añadiendo las no marcadas al final', () => {
    expect(completeOrder([3, 1], 4)).toEqual([3, 1, 2, 4])
  })

  it('deduplica y descarta fuera de rango', () => {
    expect(completeOrder([2, 2, 1], 3)).toEqual([2, 1, 3])
    expect(completeOrder([9, 0], 3)).toEqual([1, 2, 3])
  })
})

describe('splitPdf (config clásica por modo)', () => {
  it('modo "cada" genera un ZIP con un PDF por página', async () => {
    const result = await splitPdf(eng(await makePdfBytes(4), { mode: 'cada' }))

    expect(result.name).toBe('doc-paginas.zip')
    expect(result.kind).toBe('zip')
    expect(result.blob.type).toBe('application/zip')

    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    const keys = Object.keys(files).sort()
    expect(keys).toHaveLength(4)
    expect(keys).toEqual(['pagina-1.pdf', 'pagina-2.pdf', 'pagina-3.pdf', 'pagina-4.pdf'])

    for (const key of keys) {
      const doc = await PDFDocument.load(files[key])
      expect(doc.getPageCount()).toBe(1)
    }
  })

  it('modo "rango" extrae solo las páginas indicadas', async () => {
    const result = await splitPdf(eng(await makePdfBytes(4), { mode: 'rango', range: '2,4' }))

    expect(result.name).toBe('doc-recortado.pdf')
    expect(result.blob.type).toBe('application/pdf')
    expect(await pageCount(result.blob)).toBe(2)
  })

  it('modo "rango" sin páginas válidas lanza un error', async () => {
    const input = eng(await makePdfBytes(4), { mode: 'rango', range: '  ' })
    await expect(splitPdf(input)).rejects.toThrow('Indica el rango de páginas')
  })
})

describe('splitPdf (config visual del selector de páginas)', () => {
  it('agrupa las páginas marcadas en un solo PDF', async () => {
    const result = await splitPdf(eng(await makePdfBytes(4), { pages: [2, 4], output: 'unido' }))
    expect(result.name).toBe('doc-recortado.pdf')
    expect(await pageCount(result.blob)).toBe(2)
  })

  it('genera un ZIP con las páginas marcadas: kind zip y claves con el nº original', async () => {
    const result = await splitPdf(eng(await makePdfBytes(4), { pages: [2, 4], output: 'separado' }))
    expect(result.name).toBe('doc-paginas.zip')
    expect(result.kind).toBe('zip')
    expect(result.blob.type).toBe('application/zip')
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    expect(Object.keys(files).sort()).toEqual(['pagina-2.pdf', 'pagina-4.pdf'])
  })

  it('recorta documentos largos completos (70 páginas) en un ZIP de 70', async () => {
    const result = await splitPdf(
      eng(
        await makePdfBytes(70),
        { pages: Array.from({ length: 70 }, (_, i) => i + 1), output: 'separado' },
      ),
    )
    expect(result.kind).toBe('zip')
    const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    expect(Object.keys(files)).toHaveLength(70)
  })

  it('ignora peticiones fuera de rango y duplicados', async () => {
    const result = await splitPdf(eng(await makePdfBytes(3), { pages: [1, 1, 9], output: 'unido' }))
    expect(await pageCount(result.blob)).toBe(1)
  })
})

describe('splitPdf (errores y progreso)', () => {
  it('lanza "Se necesita un archivo" si los bytes vienen vacíos', async () => {
    await expect(splitPdf(eng(new Uint8Array(), { mode: 'rango', range: '1' }))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })

  it('reporta progreso con las fases esperadas cuando recibe onProgress', async () => {
    const events: ProgressEvent[] = []
    const result = await splitPdf(eng(await makePdfBytes(2), { mode: 'rango', range: '1' }), (e) =>
      events.push(e),
    )

    expect(result.blob.type).toBe('application/pdf')
    expect(events.length).toBeGreaterThan(0)
    expect(events[events.length - 1]).toMatchObject({ percent: 100 })

    const phases = events.map((e) => e.phase)
    expect(phases).toContain('Leyendo PDF')
    expect(phases).toContain('Procesando páginas')
    expect(phases).toContain('Generando archivo')
  })
})