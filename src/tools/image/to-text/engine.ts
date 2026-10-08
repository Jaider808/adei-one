/**
 * ADEI-ONE — Motor de "Texto desde imagen" (`image.to-text`).
 *
 * OCR 100 % local con tesseract.js v7: se carga el modelo `eng` y se reconoce
 * el texto de la imagen, devolviéndolo como un .txt plano.
 *
 * Decisiones:
 * - Solo navegador (`assertBrowser`): tesseract.js necesita Web Worker y
 *   fetch del modelo; en Node (los tests) se corta antes de cargarlo.
 * - Carga diferida de tesseract.js (`import()`): queda en su propio chunk
 *   lazy y no pesa al arranque de la app.
 * - El texto se devuelve SIEMPRE, aunque venga vacío (imagen sin texto
 *   legible): un .txt vacío honesto es mejor que un error confuso; el
 *   usuario ve que la tool corrió y el resultado no tiene contenido.
 * - El worker se termina en `finally` (best-effort) para no dejar hilos
 *   huérfanos si el reconocimiento falla a mitad.
 */
import { baseName, textResult } from '@/tools/convert/helpers'
import { assertBrowser, requireBytes, steps } from '@/tools/image/shared'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/** OCR de una imagen con tesseract.js → .txt plano (kind 'txt'). */
export async function extractImageText(
  input: EngineInput,
  onProgress?: (e: ProgressEvent) => void,
): Promise<ProcessResult> {
  // Guardias: entrada válida primero, navegador después (tesseract no corre en Node).
  requireBytes(input.bytes)
  assertBrowser()

  const s = steps(onProgress)
  s.reading(10)

  // Carga diferida: tesseract.js es pesado y queda en un chunk aparte.
  const { createWorker } = await import('tesseract.js')
  s.processing(60)

  const worker = await createWorker('eng')
  try {
    // Copia el ArrayBuffer exacto de la imagen: los bytes del input pueden ser
    // una vista de un buffer mayor (p. ej. el de File.arrayBuffer()).
    const ab = input.bytes.buffer.slice(
      input.bytes.byteOffset,
      input.bytes.byteOffset + input.bytes.byteLength,
    ) as ArrayBuffer

    const { data } = await worker.recognize(ab as unknown as Parameters<typeof worker.recognize>[0])
    s.generating(90)

    s.done()
    return textResult(`${baseName(input.name)}-texto.txt`, data.text, 'txt', 'text/plain')
  } finally {
    // Libera el worker pase lo que pase (reconocimiento ok o error).
    try {
      await worker.terminate()
    } catch {
      // ya terminado o liberación sin importancia
    }
  }
}