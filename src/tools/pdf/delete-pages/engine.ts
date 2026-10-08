/**
 * ADEI-ONE — Motor de "Eliminar páginas" (`pdf.delete-pages`).
 *
 * `config.pages` llega como array 1-indexed (selector visual) o como string
 * "2,5-7" (se parsea con `parsePageList`). Se eliminan esas páginas y se
 * conserva el resto en orden natural.
 */
import { baseName, buildPdf, buildStep, loadSource, parsePageList, pdfResult } from '@/tools/common/pdf-helpers'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/** Elimina las páginas indicadas en `config.pages` y conserva el resto. */
export async function deletePages(
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

  const raw = Array.isArray(config.pages)
    ? (config.pages as number[])
    : parsePageList(String(config.pages ?? ''))
  const remove = new Set(raw.filter((p) => Number.isInteger(p) && p >= 1))
  const keep: number[] = []
  for (let i = 1; i <= total; i++) {
    if (!remove.has(i)) keep.push(i)
  }

  // Defensa en profundidad: nunca terminar con un PDF vacío (la UI ya lo impide,
  // pero el engine no debe poder producir 0 páginas por una llamada directa).
  if (keep.length === 0) throw new Error('No puedes eliminar todas las páginas')

  processing(55)
  const bytes = await buildPdf(src, keep)
  generating(90)
  done(100)
  return pdfResult(`${base}-editado.pdf`, bytes)
}