/**
 * ADEI-ONE — Metadata de la tool "Convertir archivo" (`convert.any`).
 * Convertidor universal: la vista (`view.tsx`) muestra las conversiones
 * posibles según el tipo de archivo subido y el engine (`engine.ts`) las
 * ejecuta 100 % local. Sin schema: la vista custom toma el control.
 */
import { RefreshCcw } from 'lucide-react'
import type { Action } from '@/core/types'

export const convertAnyTool: Action = {
  id: 'convert.any',
  name: 'Convertir archivo',
  description:
    'Convierte tu archivo a muchos formatos (imágenes, texto, datos…). Solo se muestran las conversiones posibles para el tipo que subiste.',
  category: 'principales',
  appliesTo: ['pdf', 'jpg', 'png', 'webp', 'gif', 'md', 'txt', 'csv', 'json', 'xml', 'docx', 'xlsx'],
  keywords: ['convertir', 'formato', 'cambiar', 'reutilizar', 'todo', 'universal', 'conversor'],
  icon: RefreshCcw,
}