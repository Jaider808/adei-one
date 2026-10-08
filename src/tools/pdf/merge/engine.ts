/**
 * ADEI-ONE — Motor de "Unir PDFs" (`pdf.merge`).
 *
 * Tool multiarchivo: el orquestador entrega el archivo principal en
 * `input.bytes` y el resto en `input.extras`. Se copian TODAS las páginas de
 * cada PDF, en el orden de la lista, a un documento nuevo. Con un único
 * documento se devuelve una copia íntegra (mismo número de páginas).
 */
import { PDFDocument } from 'pdf-lib'
import {
  baseName,
  buildPdf,
  buildStep,
  loadSource,
  pdfResult,
} from '@/tools/common/pdf-helpers'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/**
 * Escala el progreso por archivo dentro del tramo 30..80:
 * el primero queda en 30 y el último en 80 (evita saltos con N=1).
 */
function joinStepPercent(index: number, total: number): number {
  const span = Math.max(total - 1, 1)
  return Math.round(30 + ((index - 1) / span) * 50)
}

/** Carga un PDF crudo y propaga un error estable que incluye el nombre. */
async function loadDoc(bytes: Uint8Array, name: string): Promise<PDFDocument> {
  try {
    return await loadSource(bytes)
  } catch {
    throw new Error(`No se pudo leer el PDF: ${name}`)
  }
}

/** Une todos los PDFs (principal + extras) en uno solo, en el orden marcado. */
export async function mergePdf(
  input: EngineInput,
  onProgress?: (e: ProgressEvent) => void,
): Promise<ProcessResult> {
  if (!input.bytes || input.bytes.length === 0) throw new Error('Se necesita un archivo')

  const reading = buildStep(onProgress, 'Leyendo PDFs')
  const generating = buildStep(onProgress, 'Generando archivo')
  const done = buildStep(onProgress, 'Listo')

  // Emite el paso "Uniendo (i/N)" de cada archivo; no emite si no hay callback.
  const joining = (i: number, n: number) =>
    buildStep(onProgress, 'Uniendo', `(${i}/${n})`)(joinStepPercent(i, n))

  const docs = [
    { name: input.name, bytes: input.bytes },
    ...(input.extras ?? []),
  ]

  reading(10)

  // Un solo documento: devolver ese PDF tal cual (copia íntegra).
  if (docs.length === 1) {
    const { name, bytes } = docs[0]!
    joining(1, 1)
    const src = await loadDoc(bytes, name)
    const pages = Array.from({ length: src.getPageCount() }, (_, i) => i + 1)
    const outBytes = await buildPdf(src, pages)
    generating(95)
    done(100)
    return pdfResult(`${baseName(name)}-unido.pdf`, outBytes)
  }

  // 2+ archivos: copiar todas las páginas de cada uno, en orden, al resultado.
  const out = await PDFDocument.create()
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!
    joining(i + 1, docs.length)
    const src = await loadDoc(doc.bytes, doc.name)
    const indices = Array.from({ length: src.getPageCount() }, (_, k) => k)
    const copied = await out.copyPages(src, indices)
    for (const page of copied) out.addPage(page)
  }
  generating(95)
  const outBytes = await out.save()
  done(100)
  return pdfResult(`${baseName(docs[0]!.name)}-unido.pdf`, outBytes)
}