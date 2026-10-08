/**
 * ADEI-ONE — Metadata de la tool "Unir PDFs" (`pdf.merge`).
 * Solo declara la Action del catálogo (sin schema: la configuración la aporta
 * la vista multiarchivo); el motor vive lazy en `engine.ts`.
 */
import { Combine } from 'lucide-react'
import type { Action } from '@/core/types'

export const mergeTool: Action = {
  id: 'pdf.merge',
  name: 'Unir PDFs',
  description: 'Fusiona varios PDFs en un único documento, en el orden que marques.',
  category: 'pdf',
  appliesTo: ['pdf'],
  keywords: ['unir', 'merge', 'fusionar', 'combinar'],
  icon: Combine,
}