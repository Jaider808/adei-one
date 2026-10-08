/**
 * ADEI-ONE — Metadata de la tool "Reordenar páginas" (`pdf.rearrange`).
 * Solo declara la Action del catálogo; el motor vive lazy en `engine.ts`.
 */
import { LayoutGrid } from 'lucide-react'
import type { Action } from '@/core/types'

export const reorderPagesTool: Action = {
  id: 'pdf.rearrange',
  name: 'Reordenar páginas',
  description: 'Toca las páginas en el orden deseado; las que no marques van al final.',
  category: 'pdf',
  appliesTo: ['pdf'],
  keywords: ['ordenar', 'mover', 'reordenar', 'rearrange'],
  icon: LayoutGrid,
}