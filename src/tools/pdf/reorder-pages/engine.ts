/**
 * ADEI-ONE — Motor de "Reordenar páginas" (`pdf.rearrange`).
 *
 * `config.order` llega como array 1-indexed (selector visual) o como string
 * "3,1,2". El orden parcial se completa con `completeOrder`: las páginas no
 * marcadas se añaden al final en orden natural.
 */
import {
  baseName,
  buildPdf,
  buildStep,
  completeOrder,
  loadSource,
  parsePageList,
  pdfResult,
} from '@/tools/common/pdf-helpers'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/** Reordena las páginas según el orden marcado (1-indexed). */
export async function rearrangePages(
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

  const rawOrder = Array.isArray(config.order)
    ? (config.order as number[])
    : parsePageList(String(config.order ?? ''))
  const pages = completeOrder(rawOrder, total)

  processing(55)
  const bytes = await buildPdf(src, pages)
  generating(90)
  done(100)
  return pdfResult(`${base}-reordenado.pdf`, bytes)
}