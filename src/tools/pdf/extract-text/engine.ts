/**
 * ADEI-ONE — Motor de "Extraer texto" (`pdf.extract-text`).
 *
 * Usa pdf.js para leer el texto de cada página y lo devuelve como un .txt
 * plano. pdf.js se carga de forma DIFERIDA (`import(...)` dentro de la
 * función) para que quede en su propio chunk lazy y no pese al arranque.
 *
 * Decisiones (importante, vimos cosas raras que merecen documentarse):
 * - Se importa el build `legacy` de pdfjs-dist y NO el principal: en entornos
 *   Node (los tests) el build principal crashea con
 *   `UnknownErrorException: hashOriginal.toHex is not a function` (usa
 *   WebCrypto del navegador) y el propio pdf.js imprime "Please use the
 *   `legacy` build in Node.js environments". El legacy es el mismo código,
 *   transpilado/probado para Node y navegadores modernos.
 * - El worker se configura SOLO en navegador (`typeof window`): pdf.js v6
 *   lanza 'No "GlobalWorkerOptions.workerSrc" specified.' en el navegador si
 *   no se indica; en Node (`isNodeJS`) se usa automáticamente el fake worker
 *   con `./pdf.worker.mjs` relativo, sin config extra.
 * - pdf.js v6: el proxy no expone `destroy()`; se libera vía `loadingTask`.
 * - Progreso: "Leyendo PDF"(10) → "Extrayendo texto"(30..90 por página) →
 *   "Listo"(100).
 */
import { baseName, buildStep } from '@/tools/common/pdf-helpers'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/** API tipada de pdf.js (build legacy, con sus .d.mts). */
type PdfJsApi = typeof import('pdfjs-dist/legacy/build/pdf.mjs')

/** Mínimo del proxy que necesitamos para liberar el documento. */
interface PdfDocHandle {
  loadingTask: { destroy(): Promise<void> }
}

let pdfjsPromise: Promise<PdfJsApi> | null = null

/**
 * Carga pdf.js una única vez (lazy). En navegador, si nadie configuró aún el
 * worker, apunta al worker del MISMO build legacy (asset resuelto por Vite).
 * En Node la rama no corre: entra el fake worker automático.
 */
function loadPdfjs(): Promise<PdfJsApi> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then(async (pdfjs) => {
      if (typeof window !== 'undefined' && !pdfjs.GlobalWorkerOptions.workerSrc) {
        const { default: workerUrl } = await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url')
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
      }
      return pdfjs
    })
  }
  return pdfjsPromise
}

/** Libera el documento pdf.js (best-effort; pdf.js v6 usa loadingTask). */
async function destroyDoc(doc: PdfDocHandle): Promise<void> {
  try {
    await doc.loadingTask.destroy()
  } catch {
    // ya destruido o liberación sin importancia
  }
}

/** Constituye un ProcessResult de texto plano (kind 'txt'). */
function txtResult(name: string, text: string): ProcessResult {
  const blob = new Blob([text], { type: 'text/plain' })
  return { name, kind: 'txt', blob, size: blob.size }
}

/** Extrae el texto de un PDF y lo devuelve como .txt (kind 'txt'). */
export async function extractPdfText(
  input: EngineInput,
  onProgress?: (e: ProgressEvent) => void,
): Promise<ProcessResult> {
  if (!input.bytes || input.bytes.length === 0) throw new Error('Se necesita un archivo')

  const base = baseName(input.name)
  const reading = buildStep(onProgress, 'Leyendo PDF')
  const extracting = buildStep(onProgress, 'Extrayendo texto')
  const done = buildStep(onProgress, 'Listo')

  reading(10)
  const pdfjs = await loadPdfjs()
  const doc = await pdfjs.getDocument({ data: input.bytes }).promise

  const parts: string[] = []
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      extracting(Math.round(30 + (i / doc.numPages) * 60))
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      // Items de texto (TextItem) exponen `str`; el contenido marcado no.
      const pageText = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join('\n')
      parts.push(pageText)
    }
  } finally {
    await destroyDoc(doc)
  }

  const text = parts.join('\n\n')
  if (!text.trim()) throw new Error('No se encontró texto en el PDF')

  done(100)
  return txtResult(`${base}-texto.txt`, text)
}