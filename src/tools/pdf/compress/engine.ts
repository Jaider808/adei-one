/**
 * ADEI-ONE — Motor de "Comprimir PDF" (`pdf.compress`).
 *
 * "Compresión" en un entorno 100% local y sin re-encodeo de las imágenes:
 * re-serializa el PDF con pdf-lib usando object streams (`useObjectStreams`)
 * y vacía la metadata del diccionario Info (título, autor, fechas…), lo que
 * en la práctica reduce el peso del archivo (y de paso elimina metadatos).
 *
 * Decisiones:
 * - Se usa `loadSource` (helper común): errores de parseo → mensaje estable.
 * - Las fechas se BORRAN del Info dict en lugar de "vaciar" con setters:
 *   pdf-lib 1.17 rechaza `undefined` en `setCreationDate`/`setModificationDate`.
 * - Progreso: "Leyendo PDF"(10) → "Optimizando"(60) → "Generando archivo"(95)
 *   → "Listo"(100).
 */
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { baseName, buildStep, loadSource, pdfResult } from '@/tools/common/pdf-helpers'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/**
 * Elimina `CreationDate`/`ModDate` del diccionario Info del PDF de forma
 * directa (lossless: la clave desaparece). pdf-lib 1.17 no acepta `undefined`
 * en los setters de fechas, así que borramos las claves vía trailerInfo.
 */
function removeInfoDates(doc: PDFDocument): void {
  const info = doc.context.lookup(doc.context.trailerInfo.Info)
  if (info instanceof PDFDict) {
    info.delete(PDFName.of('CreationDate'))
    info.delete(PDFName.of('ModDate'))
  }
}

/** Comprime un PDF: re-serializa optimizado y limpia su metadata. */
export async function compressPdf(
  input: EngineInput,
  onProgress?: (e: ProgressEvent) => void,
): Promise<ProcessResult> {
  if (!input.bytes || input.bytes.length === 0) throw new Error('Se necesita un archivo')

  const base = baseName(input.name)
  const reading = buildStep(onProgress, 'Leyendo PDF')
  const optimizing = buildStep(onProgress, 'Optimizando')
  const generating = buildStep(onProgress, 'Generando archivo')
  const done = buildStep(onProgress, 'Listo')

  reading(10)
  const doc = await loadSource(input.bytes)

  optimizing(60)
  doc.setTitle('')
  doc.setAuthor('')
  doc.setSubject('')
  doc.setKeywords([])
  doc.setCreator('')
  doc.setProducer('')
  removeInfoDates(doc)

  const bytes = await doc.save({ useObjectStreams: true })
  generating(95)
  done(100)
  return pdfResult(`${base}-comprimido.pdf`, bytes)
}