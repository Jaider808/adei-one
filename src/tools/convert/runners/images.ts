/**
 * ADEI-ONE — Runners de imágenes del "Convertidor universal".
 * Dominio: imagen → imagen (canvas), imagen → PDF (pdf-lib, sin canvas),
 * imagen → SVG (canvas), HEIC/HEIF → JPG/PNG y TIFF → PNG/JPG (navegador).
 * Librerías pesadas (imagetracerjs, heic2any, utif) vía `import()` dinámico.
 */
import { PDFDocument, PageSizes } from 'pdf-lib'
import {
  baseName,
  canvasToBytes,
  fileResult,
  moduleDefault,
  pdfResult,
  requireBytes,
  steps,
  textResult,
  toBlobPart,
} from '../helpers'
import type { ProgressCb } from '../helpers'
import type { RunnerDef } from '../runner-types'
import type { EngineInput, ProcessResult } from '@/core/types'

const IMAGE_FORMATS: Record<'jpg' | 'png' | 'webp', { mime: string; quality?: number }> = {
  jpg: { mime: 'image/jpeg', quality: 0.92 },
  png: { mime: 'image/png' },
  webp: { mime: 'image/webp', quality: 0.9 },
}

/** Decodifica los bytes con `Image` + objectURL (fallback cuando no hay createImageBitmap). */
function imageFromUrl(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('No se pudo decodificar la imagen'))
    }
    img.src = url
  })
}

/** Re-convierte la imagen al formato pedido vía canvas (solo navegador). */
async function imageToImage(
  input: EngineInput,
  onProgress: ProgressCb | undefined,
  format: 'jpg' | 'png' | 'webp',
): Promise<ProcessResult> {
  requireBytes(input.bytes)
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('Esta conversión requiere el navegador')
  }
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const fmt = IMAGE_FORMATS[format]

  const blob = new Blob([toBlobPart(input.bytes)], { type: 'image/*' })
  converting(50)
  const source =
    typeof createImageBitmap === 'function'
      ? await createImageBitmap(blob)
      : await imageFromUrl(blob)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No se pudo preparar el lienzo')
  const isHtmlImage = source instanceof HTMLImageElement
  const width = isHtmlImage ? source.naturalWidth : source.width
  const height = isHtmlImage ? source.naturalHeight : source.height
  canvas.width = Math.max(1, width)
  canvas.height = Math.max(1, height)
  ctx.drawImage(source, 0, 0)

  const bytes = await canvasToBytes(canvas, fmt.mime, fmt.quality)
  generating(90)
  done(100)
  return fileResult(`${baseName(input.name)}.${format}`, bytes, format, fmt.mime)
}

/* Imagen → PDF (pdf-lib, centrada en A4) */ /* ------------------------ */

async function imgToPdf(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const doc = await PDFDocument.create()
  const [pageWidth, pageHeight] = PageSizes.A4
  converting(50)
  const image =
    input.kind === 'png'
      ? await doc.embedPng(input.bytes)
      : await doc.embedJpg(input.bytes)
  const margin = 40
  const maxWidth = pageWidth - margin * 2
  const maxHeight = pageHeight - margin * 2
  const scale = Math.min(maxWidth / image.width, maxHeight / image.height, 1)
  const width = image.width * scale
  const height = image.height * scale
  const page = doc.addPage(PageSizes.A4)
  page.drawImage(image, {
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
  })
  generating(90)
  const bytes = await doc.save()
  done(100)
  return pdfResult(`${baseName(input.name)}.pdf`, bytes)
}

/* Imagen → SVG (vectoriza en el navegador) */ /* ----------------------- */

async function imgToSvg(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('Esta conversión requiere el navegador')
  }
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)

  const blob = new Blob([toBlobPart(input.bytes)], { type: 'image/*' })
  const source =
    typeof createImageBitmap === 'function'
      ? await createImageBitmap(blob)
      : await imageFromUrl(blob)

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No se pudo preparar el lienzo')
  const isHtmlImage = source instanceof HTMLImageElement
  canvas.width = Math.max(1, isHtmlImage ? source.naturalWidth : source.width)
  canvas.height = Math.max(1, isHtmlImage ? source.naturalHeight : source.height)
  ctx.drawImage(source, 0, 0)
  converting(50)

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const tracer = moduleDefault<{ imagedataToSVG(imgd: object, options?: object): string }>(
    await import('imagetracerjs'),
  )
  const svg = tracer.imagedataToSVG(
    { width: imageData.width, height: imageData.height, data: imageData.data },
    {},
  )
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.svg`, svg, 'svg', 'image/svg+xml')
}

/* HEIC/HEIF → JPG/PNG (navegador) */ /* ------------------------------- */

/**
 * Descarga el primer fotograma de una foto HEIC/HEIF y lo re-encodea con
 * heic2any (solo navegador). El API real de heic2any recibe un `blob`, no
 * un `buffer`.
 */
async function heicToImage(
  input: EngineInput,
  onProgress: ProgressCb | undefined,
  mime: 'image/jpeg' | 'image/png',
  ext: 'jpg' | 'png',
): Promise<ProcessResult> {
  requireBytes(input.bytes)
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('Esta conversión requiere el navegador')
  }
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const { default: heic2any } = await import('heic2any')
  converting(50)
  const blob = new Blob([toBlobPart(input.bytes)], { type: 'image/heic' })
  const output = await heic2any({ blob, toType: mime, quality: 0.9 })
  const first = Array.isArray(output) ? output[0] : output
  if (!first) throw new Error('No se pudo descodificar la imagen HEIC')
  const bytes = new Uint8Array(await first.arrayBuffer())
  generating(90)
  done(100)
  return fileResult(`${baseName(input.name)}.${ext}`, bytes, ext, mime)
}

/* TIFF → JPG/PNG (navegador) */ /* ------------------------------------ */

async function tiffToImage(
  input: EngineInput,
  onProgress: ProgressCb | undefined,
  mime: 'image/png' | 'image/jpeg',
  ext: 'png' | 'jpg',
): Promise<ProcessResult> {
  requireBytes(input.bytes)
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('Esta conversión requiere el navegador')
  }
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const UTIF = moduleDefault<{
    decode(buffer: Uint8Array): Array<{ width: number; height: number }>
    decodeImage(buffer: Uint8Array, ifd: { width: number; height: number }): void
    toRGBA8(ifd: { width: number; height: number }): Uint8Array
  }>(await import('utif'))
  converting(50)
  const ifds = UTIF.decode(input.bytes)
  const ifd = ifds[0]
  if (!ifd) throw new Error('El archivo TIFF no contiene imágenes')
  UTIF.decodeImage(input.bytes, ifd)
  const rgba = UTIF.toRGBA8(ifd)

  const canvas = document.createElement('canvas')
  canvas.width = ifd.width
  canvas.height = ifd.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No se pudo preparar el lienzo')
  const imageData = ctx.createImageData(ifd.width, ifd.height)
  imageData.data.set(rgba)
  ctx.putImageData(imageData, 0, 0)

  const bytes = await canvasToBytes(canvas, mime, mime === 'image/jpeg' ? 0.92 : undefined)
  generating(90)
  done(100)
  return fileResult(`${baseName(input.name)}.${ext}`, bytes, ext, mime)
}

/**
 * Runners del dominio imágenes.
 * Un mismo set de tres destinos (to-jpg/png/webp) vale para jpg/png/webp/gif;
 * jpg/png suman → PDF (pdf-lib, sin canvas) y → SVG (canvas). heic y tiff
 * tienen sus propias conversiones (solo navegador).
 */
export const imageRunners: RunnerDef[] = [
  {
    id: 'to-jpg',
    label: 'JPG',
    ext: 'jpg',
    description: 'Re-convierte la imagen a JPG: más ligera y lista para compartir (sin transparencia).',
    from: ['jpg', 'png', 'webp', 'gif'],
    requiresCanvas: true,
    run: (input, onProgress) => imageToImage(input, onProgress, 'jpg'),
  },
  {
    id: 'to-png',
    label: 'PNG',
    ext: 'png',
    description: 'Re-convierte la imagen a PNG, sin pérdida de calidad ni transparencia.',
    from: ['jpg', 'png', 'webp', 'gif'],
    requiresCanvas: true,
    run: (input, onProgress) => imageToImage(input, onProgress, 'png'),
  },
  {
    id: 'to-webp',
    label: 'WebP',
    ext: 'webp',
    description: 'Re-convierte la imagen a WebP: formato moderno, ligero y con buena calidad.',
    from: ['jpg', 'png', 'webp', 'gif'],
    requiresCanvas: true,
    run: (input, onProgress) => imageToImage(input, onProgress, 'webp'),
  },
  {
    id: 'img-to-pdf',
    label: 'PDF',
    ext: 'pdf',
    description: 'Convierte la imagen a una página PDF (A4) con la imagen centrada.',
    from: ['jpg', 'png'],
    run: imgToPdf,
  },
  {
    id: 'img-to-svg',
    label: 'SVG',
    ext: 'svg',
    description: 'Vectoriza la imagen a SVG trazando sus colores y formas.',
    from: ['jpg', 'png'],
    requiresCanvas: true,
    run: imgToSvg,
  },
  {
    id: 'heic-to-jpg',
    label: 'JPG',
    ext: 'jpg',
    description: 'Convierte la foto HEIC/HEIF a JPG, compatible con casi todo.',
    from: ['heic'],
    requiresCanvas: true,
    run: (input, onProgress) => heicToImage(input, onProgress, 'image/jpeg', 'jpg'),
  },
  {
    id: 'heic-to-png',
    label: 'PNG',
    ext: 'png',
    description: 'Convierte la foto HEIC/HEIF a PNG, con calidad y transparencia.',
    from: ['heic'],
    requiresCanvas: true,
    run: (input, onProgress) => heicToImage(input, onProgress, 'image/png', 'png'),
  },
  {
    id: 'tiff-to-png',
    label: 'PNG',
    ext: 'png',
    description: 'Convierte el TIFF a PNG, conservando calidad y transparencia.',
    from: ['tiff'],
    requiresCanvas: true,
    run: (input, onProgress) => tiffToImage(input, onProgress, 'image/png', 'png'),
  },
  {
    id: 'tiff-to-jpg',
    label: 'JPG',
    ext: 'jpg',
    description: 'Convierte el TIFF a JPG, más ligero y listo para compartir.',
    from: ['tiff'],
    requiresCanvas: true,
    run: (input, onProgress) => tiffToImage(input, onProgress, 'image/jpeg', 'jpg'),
  },
]