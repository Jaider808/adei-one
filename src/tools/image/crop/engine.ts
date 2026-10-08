/**
 * ADEI-ONE — Motor de "Recortar imagen" (`image.crop`).
 *
 * Cadena de proceso (solo navegador):
 *   requireBytes → steps → assertBrowser → decodeToCanvas → clampCrop
 *   (matemática pura de shared) → canvas nuevo + drawImage → canvasToBytes.
 *
 * Decisiones:
 * - El recorte NUNCA amplía: `clampCrop` ajusta x/y y medidas a los límites
 *   de la fuente (si pides 500×300 de una 200×100, sale la imagen completa).
 * - x/y por defecto es (0, 0): se recorta desde la esquina superior izquierda.
 * - El formato de salida hereda el kind del input cuando es jpg/png/webp; si
 *   el origen es gif/tiff/heic (sin re-encode fiel vía canvas) se emite PNG.
 */
import { baseName } from '@/tools/common/pdf-helpers'
import {
  assertBrowser,
  canvasToBytes,
  clampCrop,
  decodeToCanvas,
  formatOf,
  imageResult,
  requireBytes,
  steps,
} from '@/tools/image/shared'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/** Config tipada del recorte (los campos llegan validados por el schema zod). */
export interface CropConfig {
  width: number
  height: number
  x?: number
  y?: number
}

/** Recorta la imagen a las medidas pedidas, desde la posición (x, y) opcional. */
export async function cropImage(
  input: EngineInput,
  onProgress?: (e: ProgressEvent) => void,
): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const s = steps(onProgress)
  assertBrowser()

  const cfg = input.config as unknown as CropConfig
  s.reading(20)

  const { canvas: src, width, height } = await decodeToCanvas(input.bytes)
  s.processing(55)

  // Área de recorte ajustada a los límites reales de la imagen.
  const rect = clampCrop(cfg.x ?? 0, cfg.y ?? 0, cfg.width, cfg.height, width, height)

  const out = document.createElement('canvas')
  out.width = rect.width
  out.height = rect.height
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('No se pudo preparar el lienzo')
  ctx.drawImage(src, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)

  s.generating(85)
  // gif/tiff/heic no tienen re-encode fiel por canvas → salida PNG.
  const outKind: 'jpg' | 'png' | 'webp' =
    input.kind === 'jpg' || input.kind === 'png' || input.kind === 'webp' ? input.kind : 'png'
  const spec = formatOf(outKind)
  const bytes = await canvasToBytes(out, spec.mime, 0.92)
  s.done()
  return imageResult(`${baseName(input.name)}-recortado.${spec.ext}`, bytes, outKind)
}