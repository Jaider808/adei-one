/**
 * ADEI-ONE — Metadata de la tool "Texto desde imagen" (`image.to-text`).
 * Solo declara la Action del catálogo; el motor (tesseract.js) vive lazy en
 * `engine.ts`. Sin vista custom ni schema: el wizard genérico arranca la
 * acción directamente (no hay opciones).
 */
import { ScanText } from 'lucide-react'
import type { Action } from '@/core/types'

/** La Action "Texto desde imagen" del catálogo (categoría image). */
export const toTextTool: Action = {
  id: 'image.to-text',
  name: 'Texto desde imagen',
  description: 'OCR local: extrae el texto que aparece en la foto (tesseract.js, todo en tu equipo).',
  category: 'image',
  appliesTo: ['jpg', 'png', 'webp', 'gif', 'tiff', 'heic'],
  keywords: ['ocr', 'texto', 'extraer', 'imagen'],
  icon: ScanText,
}