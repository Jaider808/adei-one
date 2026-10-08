/**
 * ADEI-ONE — Motor de "Recortar PDF" (`pdf.split`).
 *
 * Acepta dos formas de config:
 *  - Visual (selector de páginas): `{ pages: number[], output: 'unido' | 'separado' }`
 *  - Clásica por modo (texto): `{ mode: 'cada' | 'pares' | 'impares' | 'rango', range? }`
 *
 * Todo corre 100% local; el ZIP lo arma `zipPagedPdfs` (fflate) con claves = nº de
 * página ORIGINAL del documento, y el resultado es kind 'zip'.
 */
import {
  baseName,
  buildPdf,
  buildStep,
  loadSource,
  parsePageList,
  pdfResult,
  zipPagedPdfs,
  zipResult,
} from '@/tools/common/pdf-helpers'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/** Recorta un PDF: extrae las páginas pedidas en un PDF o ZIP por página. */
export async function splitPdf(
  input: EngineInput,
  onProgress?: (e: ProgressEvent) => void,
): Promise<ProcessResult> {
  const { config } = input
  if (!input.bytes || input.bytes.length === 0) throw new Error('Se necesita un archivo')

  const base = baseName(input.name)

  const reading = buildStep(onProgress, 'Leyendo PDF')
  const processing = buildStep(onProgress, 'Procesando páginas')
  const generating = buildStep(onProgress, 'Generando archivo')
  const done = buildStep(onProgress, 'Listo')

  reading(10)
  const src = await loadSource(input.bytes)
  const total = src.getPageCount()

  const visualPages = Array.isArray(config.pages) ? (config.pages as number[]) : null
  const output = String(config.output ?? 'unido')

  let pages: number[]
  let separate: boolean
  let suffix: string

  if (visualPages) {
    // Config del selector visual: páginas marcadas, sin duplicados, en orden.
    const valid = visualPages.filter((p) => Number.isInteger(p) && p >= 1 && p <= total)
    pages = [...new Set(valid)]
    separate = output === 'separado'
    suffix = separate ? '-paginas.zip' : '-recortado.pdf'
  } else {
    // Config clásica por modo (texto).
    const mode = String(config.mode ?? 'rango')
    separate = mode === 'cada'
    suffix = separate
      ? '-paginas.zip'
      : mode === 'pares' || mode === 'impares'
        ? `-${mode}.pdf`
        : '-recortado.pdf'

    if (mode === 'cada') {
      pages = Array.from({ length: total }, (_, i) => i + 1)
    } else if (mode === 'pares' || mode === 'impares') {
      const keepEven = mode === 'pares'
      pages = Array.from({ length: total }, (_, i) => i + 1).filter((p) => (p % 2 === 0) === keepEven)
    } else {
      pages = parsePageList(String(config.range ?? '')).filter((p) => p >= 1 && p <= total)
    }
  }

  if (pages.length === 0) throw new Error('Indica el rango de páginas')

  if (separate) {
    const pdfs: Uint8Array[] = []
    for (let i = 0; i < pages.length; i++) {
      processing(Math.round(55 + (i / Math.max(pages.length, 1)) * 30))
      pdfs.push(await buildPdf(src, [pages[i]]))
    }
    generating(90)
    done(100)
    return zipResult(`${base}${suffix}`, zipPagedPdfs(pdfs, pages))
  }

  processing(55)
  const bytes = await buildPdf(src, pages)
  generating(90)
  done(100)
  return pdfResult(`${base}${suffix}`, bytes)
}