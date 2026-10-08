/**
 * ADEI-ONE — Metadata de la tool "Redimensionar" (`image.resize`).
 * El wizard genérico genera el formulario desde `schema` (zod v4):
 * ancho/alto en píxeles (opcionales) o escala porcentual (1-400%).
 * Sin vista custom: el motor vive lazy en `engine.ts`.
 */
import { FileType2 } from 'lucide-react'
import { z } from 'zod'
import type { Action } from '@/core/types'

/** La Action "Redimensionar" del catálogo (categoría image). */
export const resizeTool: Action = {
  id: 'image.resize',
  name: 'Redimensionar',
  description: 'Cambia el tamaño en píxeles o porcentaje.',
  category: 'image',
  appliesTo: ['jpg', 'png', 'webp', 'gif', 'tiff', 'heic'],
  keywords: ['tamaño', 'resize', 'dimensiones'],
  icon: FileType2,
  schema: z.object({
    width: z.number().int().positive().optional().describe('Ancho (px)'),
    height: z.number().int().positive().optional().describe('Alto (px)'),
    percentage: z.number().min(1).max(400).optional().describe('Escala (%)'),
  }),
}