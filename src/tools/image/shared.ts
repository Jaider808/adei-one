/**
 * ADEI-ONE — Compartido de la categoría Imagen.
 * - Matemática PURA (computeResize / clampCrop) → testeable en Node.
 * - Helpers de canvas (decodeToCanvas / canvasToBytes) → solo navegador.
 * Las tools de imagen usan estos helpers para no duplicar código.
 */
import type { ProcessResult, ProgressEvent } from '@/core/types'

/* ── Formato de imágenes ── */
export interface ImageFormatSpec {
  id: 'jpg' | 'png' | 'webp'
  mime: string
  ext: string
  label: string
}

export const IMAGE_FORMATS: ImageFormatSpec[] = [
  { id: 'jpg', mime: 'image/jpeg', ext: 'jpg', label: 'JPG' },
  { id: 'png', mime: 'image/png', ext: 'png', label: 'PNG' },
  { id: 'webp', mime: 'image/webp', ext: 'webp', label: 'WebP' },
]

export function formatOf(id: string): ImageFormatSpec {
  return IMAGE_FORMATS.find((f) => f.id === id) ?? IMAGE_FORMATS[1] // png fallback
}

/* ── Guards ── */
export function assertBrowser(): void {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('Esta herramienta requiere el navegador')
  }
}

/* ── Matemática pura (Node-testable) ── */
export interface ResizeTarget {
  width: number
  height: number
}

/** Calcula el tamaño objetivo de un redimensionado (porcentaje prioriza; luego width/height con ratio). */
export function computeResize(
  srcWidth: number,
  srcHeight: number,
  cfg: { width?: number; height?: number; percentage?: number },
): ResizeTarget {
  if (cfg.percentage && cfg.percentage > 0 && Math.abs(cfg.percentage - 100) > 0.0001) {
    const ratio = cfg.percentage / 100
    return {
      width: Math.max(1, Math.round(srcWidth * ratio)),
      height: Math.max(1, Math.round(srcHeight * ratio)),
    }
  }
  if (cfg.width && cfg.width > 0) {
    if (cfg.height && cfg.height > 0) return { width: cfg.width, height: cfg.height }
    return { width: cfg.width, height: Math.max(1, Math.round((srcHeight * cfg.width) / srcWidth)) }
  }
  if (cfg.height && cfg.height > 0) {
    return { width: Math.max(1, Math.round((srcWidth * cfg.height) / srcHeight)), height: cfg.height }
  }
  return { width: srcWidth, height: srcHeight }
}

export interface CropRect {
  x: number
  y: number
  width: number
  height: number
}

/** Recorte dentro de los límites: recorta/ajusta x,y,w,h para caber en src (entero). */
export function clampCrop(
  x: number,
  y: number,
  width: number,
  height: number,
  srcWidth: number,
  srcHeight: number,
): CropRect {
  const w = Math.max(1, Math.min(Math.round(width), srcWidth))
  const h = Math.max(1, Math.min(Math.round(height), srcHeight))
  const cx = Math.max(0, Math.min(Math.round(x), srcWidth - w))
  const cy = Math.max(0, Math.min(Math.round(y), srcHeight - h))
  return { x: cx, y: cy, width: w, height: h }
}

/* ── Canvas (solo navegador) ── */

/** Opciones de decodificación de `decodeToCanvas` (todas opcionales). */
export interface DecodeOptions {
  /**
   * Cómo trata `createImageBitmap` la orientación EXIF: `'none'` devuelve los
   * píxeles TAL CUAL están almacenados; `'from-image'` los endereza según el
   * tag. Si se omite, se usa el comportamiento por defecto del navegador
   * (que hoy es `'from-image'`), idéntico al de siempre.
   */
  imageOrientation?: 'none' | 'from-image'
}

/**
 * Decodifica bytes de imagen a un canvas (drawImage). Lanza si no hay navegador.
 * `opts` es opcional: sin él el comportamiento es EXACTAMENTE el de siempre
 * (las tools de imagen lo llaman así); con `opts.imageOrientation` se pasa a
 * `createImageBitmap` para controlar la orientación EXIF de forma explícita.
 */
export async function decodeToCanvas(
  bytes: Uint8Array,
  opts?: DecodeOptions,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  assertBrowser()
  const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
    type: 'application/octet-stream',
  })
  const source = opts?.imageOrientation
    ? await createImageBitmap(blob, { imageOrientation: opts.imageOrientation })
    : await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = source.width
  canvas.height = source.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No se pudo preparar el lienzo')
  ctx.drawImage(source, 0, 0)
  source.close()
  return { canvas, width: source.width, height: source.height }
}

/** Convierte un canvas a Uint8Array en un MIME y calidad dados. */
export function canvasToBytes(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error('No se pudo generar la imagen'))
          return
        }
        resolve(new Uint8Array(await blob.arrayBuffer()))
      },
      mime,
      quality,
    )
  })
}

/** Envuelve bytes de imagen como ProcessResult (kind = formato imagen). */
export function imageResult(name: string, bytes: Uint8Array, kind: 'jpg' | 'png' | 'webp'): ProcessResult {
  const spec = formatOf(kind)
  const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], {
    type: spec.mime,
  })
  return { name, kind, blob, size: blob.size }
}

/** Verifica bytes vacíos (error estable). */
export function requireBytes(bytes: Uint8Array): void {
  if (!bytes || bytes.length === 0) throw new Error('Se necesita un archivo')
}

/** Progreso de imagen: fases cortas "Leyendo"/"Procesando"/"Generando"/"Listo". */
export function steps(onProgress?: (e: ProgressEvent) => void) {
  const emit = (phase: string, percent: number) => onProgress?.({ phase, percent })
  return {
    reading: (p: number) => emit('Leyendo archivo', p),
    processing: (p: number) => emit('Procesando imagen', p),
    generating: (p: number) => emit('Generando archivo', p),
    done: () => emit('Listo', 100),
  }
}