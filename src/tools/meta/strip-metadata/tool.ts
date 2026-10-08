/**
 * ADEI-ONE — Tool "Eliminar metadata" (`meta.strip`): declaración de la Action.
 *
 * Es la tool ÚNICA y transversal (`appliesTo: []`): limpia la metadata de
 * cualquier formato (imágenes, PDF, Office, audio, video, texto…). Tiene vista
 * custom (`view.tsx`) que escanea y muestra TODA la metadata, deja elegir los
 * bloques a borrar y el modo: 'light' (lossless, no toca tu contenido) o
 * 'deep' (máxima limpieza, puede regenerar el archivo).
 */
import { ShieldCheck } from 'lucide-react'
import { z } from 'zod'
import type { Action } from '@/core/types'

/** La Action "Eliminar metadata" del catálogo (Principales, transversal). */
export const stripMetadataTool: Action = {
  id: 'meta.strip',
  name: 'Eliminar metadata',
  description: 'Mira y borra autor, fechas, GPS, EXIF y demás metadata de tus archivos.',
  category: 'principales',
  appliesTo: [],
  keywords: ['metadata', 'privacidad', 'gps', 'exif', 'oculto', 'limpiar'],
  icon: ShieldCheck,
  schema: z.object({
    mode: z.enum(['light', 'deep']).default('light').describe('Modo (ligero = sin tocar; profundo = máxima limpieza)'),
    blocks: z.array(z.string()).default([]).describe('Bloques de metadata a eliminar'),
  }),
}