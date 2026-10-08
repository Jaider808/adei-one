/**
 * ADEI-ONE — Metadata de la tool "Recortar PDF" (`pdf.split`).
 * Solo declara la Action del catálogo; el motor vive lazy en `engine.ts`.
 */
import { Scissors } from 'lucide-react'
import type { Action } from '@/core/types'

export const splitTool: Action = {
  id: 'pdf.split',
  name: 'Recortar PDF',
  description: 'Selecciona las páginas que quieres conservar y descarga solo esas páginas (en un solo PDF o cada una por separado en ZIP).',
  category: 'pdf',
  appliesTo: ['pdf'],
  keywords: ['recortar', 'seleccionar', 'dividir', 'split', 'páginas', 'separar'],
  icon: Scissors,
}