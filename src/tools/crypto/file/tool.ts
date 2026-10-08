/**
 * ADEI-ONE — Metadata de la tool "Encriptar archivo" (`crypto.file`).
 *
 * Auto-detección tipo VERNAM: el motor (`engine.ts`) decide solo si el archivo
 * subido ya es un contenedor `.adei` (lo DESENCRIPTA) o si es un archivo plano
 * (lo ENCRIPTA). Los parámetros de derivación `profile` solo afectan a la
 * encriptación; al descifrar se respetan los que vienen en la cabecera ADEI1.
 *
 * La `passphrase` se queda en el formulario local (el wizard la maneja en
 * claro dentro del navegador): nada sale de la máquina.
 */
import { Lock } from 'lucide-react'
import { z } from 'zod'
import type { Action } from '@/core/types'

/** La Action "Encriptar archivo" del catálogo (categoría principales). */
export const cryptoFileTool: Action = {
  id: 'crypto.file',
  name: 'Encriptar archivo',
  description:
    'Cifra cualquier archivo con tu contraseña (Argon2id + XChaCha20, inspirado en VERNAM). Si el archivo ya está encriptado (.adei), lo descifra con la misma contraseña.',
  category: 'principales',
  appliesTo: [],
  keywords: [
    'encriptar',
    'cifrar',
    'desencriptar',
    'descifrar',
    'contraseña',
    'privacidad',
    'xchacha20',
    'argon2',
  ],
  icon: Lock,
  schema: z.object({
    passphrase: z.string().min(1).describe('Contraseña'),
    profile: z.enum(['standard', 'high']).optional().describe('Perfil de derivación'),
  }),
}