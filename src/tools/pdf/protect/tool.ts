/**
 * ADEI-ONE — Metadata de la tool "Proteger PDF" (`pdf.protect`).
 * El wizard genérico genera el formulario desde `schema`:
 * status (Añadir/Eliminar contraseña) + contraseña. Sin vista custom.
 */
import { Lock } from 'lucide-react'
import { z } from 'zod'
import type { Action } from '@/core/types'

/** La Action "Proteger PDF" del catálogo (categoría pdf). */
export const protectTool: Action = {
  id: 'pdf.protect',
  name: 'Proteger PDF',
  description: 'Añade o elimina una contraseña del PDF.',
  category: 'pdf',
  appliesTo: ['pdf'],
  keywords: ['contraseña', 'password', 'proteger', 'desbloquear', 'encriptar'],
  icon: Lock,
  schema: z.object({
    status: z.enum(['add', 'unlock']).describe('Acción'),
    password: z.string().min(1).describe('Contraseña'),
  }),
}