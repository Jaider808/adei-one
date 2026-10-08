/**
 * ADEI-ONE — Metadata de la tool "Extraer texto" (`pdf.extract-text`).
 * Solo declara la Action del catálogo; el motor vive lazy en `engine.ts`.
 * Sin vista custom: no tiene opciones (schema vacío), el wizard genérico
 * arranca la acción directamente.
 */
import { ScanText } from 'lucide-react'
import type { Action } from '@/core/types'

/** La Action "Extraer texto" del catálogo (categoría pdf). */
export const extractTextTool: Action = {
  id: 'pdf.extract-text',
  name: 'Extraer texto',
  description: 'Extrae el texto del PDF y lo devuelve como un archivo .txt listo para copiar o editar.',
  category: 'pdf',
  appliesTo: ['pdf'],
  keywords: ['texto', 'extraer', 'ocr', 'copiar'],
  icon: ScanText,
}