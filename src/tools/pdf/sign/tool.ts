/**
 * ADEI-ONE — Metadata de "Firmar PDF" (`pdf.sign`).
 * Sello de texto sobre las páginas elegidas (solo texto; la firma dibujada a
 * mano queda para una evolución con canvas).
 */
import { z } from 'zod'
import { PenLine } from 'lucide-react'
import type { Action } from '@/core/types'

export const signTool: Action = {
  id: 'pdf.sign',
  name: 'Firmar PDF',
  description:
    'Añade un sello de texto (firma, "Aprobado", fecha…) sobre las páginas del PDF.',
  category: 'pdf',
  appliesTo: ['pdf'],
  keywords: ['firma', 'sign', 'sello', 'texto', 'aprobado'],
  icon: PenLine,
  schema: z.object({
    text: z.string().min(1).describe('Texto del sello'),
    pages: z.enum(['todas', 'primera']).describe('Dónde firmar'),
    position: z.enum(['arriba', 'centro', 'abajo']).describe('Posición'),
  }),
}