/**
 * ADEI-ONE — Motor de "Comprimir imagen" (`image.compress`).
 *
 * Completamente local: decodifica la imagen a un canvas y la re-encoda con un
 * factor de calidad más agresivo (default 75) para reducir el peso. Mantiene
 * el MISMO formato del input; la calidad de `toBlob` solo reduce peso en
 * formatos con pérdida (jpg/webp) — en PNG se re-encoda igual (mismo peso
 * aproximado) y es la alternativa honesta disponible sin herramientas de
 * cuantización.
 *
 * Decisiones:
 * - Formato de salida: el del input si es jpg/png/webp; si el input es
 *   gif/tiff/heic se convierte a PNG como base honesta (el API de canvas no
 *   re-encoda esos formatos sin sus codificadores dedicados).
 * - `requireBytes` va ANTES del guard de navegador: el error de archivo vacío
 *   es estable y no depende del entorno (los tests lo verifican).
 * - Progreso: "Leyendo"(10) → "Procesando imagen"(60) → "Generando"(90) →
 *   "Listo"(100).
 */
import { baseName } from '@/tools/common/pdf-helpers'
import {
  assertBrowser,
  canvasToBytes,
  decodeToCanvas,
  formatOf,
  imageResult,
  requireBytes,
  steps,
} from '@/tools/image/shared'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/** Config del wizard: calidad (schema en tool.ts). */
interface CompressConfig {
  quality?: number
}

/** Calidad 0..1 desde `config.quality` (porcentaje) o el fallback si no llega. */
function quality01(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value / 100 : fallback
}

/** Compresión por defecto: 75% (más bajo = menos peso). */
const DEFAULT_QUALITY = 0.75

/** Comprime una imagen re-encodándola con menos calidad (mismo formato). */
export async function compressImage(
  input: EngineInput,
  onProgress?: (e: ProgressEvent) => void,
): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const s = steps(onProgress)
  s.reading(10)
  assertBrowser()

  const config = input.config as CompressConfig
  const spec = formatOf(input.kind)

  const { canvas } = await decodeToCanvas(input.bytes)
  s.processing(60)
  const bytes = await canvasToBytes(canvas, spec.mime, quality01(config.quality, DEFAULT_QUALITY))
  s.generating(90)
  s.done()
  return imageResult(`${baseName(input.name)}-comprimido.${spec.ext}`, bytes, spec.id)
}