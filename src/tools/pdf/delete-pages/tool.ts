/**
 * ADEI-ONE — Metadata de la tool "Eliminar páginas" (`pdf.delete-pages`).
 * Solo declara la Action del catálogo; el motor vive lazy en `engine.ts`.
 */
import { Trash2 } from 'lucide-react'
import type { Action } from '@/core/types'

export const deletePagesTool: Action = {
  id: 'pdf.delete-pages',
  name: 'Eliminar páginas',
  description: 'Marca las páginas que quieres ELIMINAR. El resto se conserva.',
  category: 'pdf',
  appliesTo: ['pdf'],
  keywords: ['eliminar', 'quitar', 'borrar', 'delete', 'páginas'],
  icon: Trash2,
}