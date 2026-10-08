/**
 * ADEI-ONE — Metadata de la tool "Comprimir imagen" (`image.compress`).
 * El wizard genérico genera el formulario desde `schema` (zod v4):
 * calidad opcional (10-100%); más baja = menos peso. Sin vista custom:
 * el motor vive lazy en `engine.ts`.
 */
import { FileArchive } from 'lucide-react'
import { z } from 'zod'
import type { Action } from '@/core/types'

/** La Action "Comprimir imagen" del catálogo (categoría image). */
export const compressTool: Action = {
  id: 'image.compress',
  name: 'Comprimir imagen',
  description: 'Reduce el peso optimizando la compresión (mismo formato).',
  category: 'image',
  appliesTo: ['jpg', 'png', 'webp', 'gif', 'tiff', 'heic'],
  keywords: ['comprimir', 'peso', 'reducir'],
  icon: FileArchive,
  schema: z.object({
    quality: z.number().int().min(10).max(100).optional().describe('Calidad (%) — más bajo = menos peso'),
  }),
}