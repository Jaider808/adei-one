/**
 * ADEI-ONE — Metadata de la tool "Comprimir PDF" (`pdf.compress`).
 * Solo declara la Action del catálogo; el motor vive lazy en `engine.ts`.
 * Sin vista custom: no tiene opciones (schema vacío), el wizard genérico
 * arranca la acción directamente.
 */
import { FileArchive } from 'lucide-react'
import type { Action } from '@/core/types'

/** La Action "Comprimir PDF" del catálogo (categoría pdf). */
export const compressTool: Action = {
  id: 'pdf.compress',
  name: 'Comprimir PDF',
  description: 'Reduce el peso del PDF reescribiéndolo optimizado y limpiando su metadata.',
  category: 'pdf',
  appliesTo: ['pdf'],
  keywords: ['comprimir', 'compress', 'peso', 'reducir'],
  icon: FileArchive,
}