/**
 * ADEI-ONE — Tool "Recortar imagen" (`image.crop`): declaración de la Action.
 *
 * El motor vive lazy en `engine.ts` (canvas, solo navegador). Aquí solo se
 * declara qué opciones pide el wizard: ancho/alto obligatorios y posición
 * inicial (x, y) opcional, todo en píxeles.
 */
import { Crop } from 'lucide-react'
import { z } from 'zod'
import type { Action } from '@/core/types'

/** La Action "Recortar imagen" del catálogo (categoría image). */
export const cropTool: Action = {
  id: 'image.crop',
  name: 'Recortar imagen',
  description: 'Recorta a tus medidas exactas: ancho, alto y posición inicial.',
  category: 'image',
  appliesTo: ['jpg', 'png', 'webp', 'gif', 'tiff', 'heic'],
  keywords: ['recortar', 'crop', 'dimensiones'],
  icon: Crop,
  schema: z.object({
    width: z.number().int().positive().describe('Ancho del recorte (px)'),
    height: z.number().int().positive().describe('Alto del recorte (px)'),
    x: z.number().int().min(0).optional().describe('Posición X (px)'),
    y: z.number().int().min(0).optional().describe('Posición Y (px)'),
  }),
}