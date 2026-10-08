/**
 * ADEI-ONE — Motor de "Redimensionar" (`image.resize`).
 *
 * Completamente local: decodifica la imagen a un canvas, calcula el tamaño
 * objetivo con `computeResize` (porcentaje prioriza; si no, width/height con
 * ratio conservado) y re-encoda reescalada.
 *
 * Decisiones:
 * - Salida MANTIENE el formato del input cuando es un formato imagen
 *   (jpg/png/webp). Si el input es gif/tiff/heic se convierte a PNG como base
 *   honesta: el API de canvas no permite re-encodear esos formatos sin los
 *   codificadores dedicados (heic2any/utif), y PNG es la base sin pérdida más
 *   aceptada. PNG/sin pérdida ignoran la calidad de `toBlob`.
 * - `requireBytes` va ANTES del guard de navegador: el error de archivo vacío
 *   es estable y no depende del entorno (los tests lo verifican).
 * - Progreso: "Leyendo"(10) → "Procesando imagen"(60) → "Generando"(90) →
 *   "Listo"(100).
 */
import { baseName } from '@/tools/common/pdf-helpers'
import {
  assertBrowser,
  canvasToBytes,
  computeResize,
  decodeToCanvas,
  formatOf,
  imageResult,
  requireBytes,
  steps,
} from '@/tools/image/shared'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/** Config del wizard: ancho/alto en px o escala % (schema en tool.ts). */
interface ResizeConfig {
  width?: number
  height?: number
  percentage?: number
}

/** Calidad de encodificado (0..1); solo afecta a formatos con pérdida (jpg/webp). */
const ENCODE_QUALITY = 0.92

/** Redimensiona una imagen a width/height/percentage y devuelve el archivo. */
export async function resizeImage(
  input: EngineInput,
  onProgress?: (e: ProgressEvent) => void,
): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const s = steps(onProgress)
  s.reading(10)
  assertBrowser()

  const { canvas, width, height } = await decodeToCanvas(input.bytes)
  const target = computeResize(width, height, input.config as ResizeConfig)

  const out = document.createElement('canvas')
  out.width = target.width
  out.height = target.height
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('No se pudo preparar el lienzo')
  ctx.drawImage(canvas, 0, 0, target.width, target.height)

  s.processing(60)
  const spec = formatOf(input.kind)
  const bytes = await canvasToBytes(out, spec.mime, ENCODE_QUALITY)
  s.generating(90)
  s.done()
  return imageResult(`${baseName(input.name)}-${target.width}x${target.height}.${spec.ext}`, bytes, spec.id)
}