/**
 * ADEI-ONE — Motor de "Proteger PDF" (`pdf.protect`).
 *
 * Dos operaciones según `config.status`:
 *  - `add`: carga el PDF, lo cifra con contraseña de usuario=propietario y
 *    permisos restrictivos, y guarda `-protegido.pdf`.
 *  - `unlock`: carga el PDF CON la contraseña y re-guarda el documento sin
 *    cifrar como `-desbloqueado.pdf`.
 *
 * Decisiones importantes (adelante: pdf-lib 1.17 NO soporta cifrado):
 * - El contrato pedía `doc.encrypt(...)` sobre pdf-lib; ese método NO existe en
 *   pdf-lib 1.17.1 (cero soporte de cifrado: ni encrypt ni password en load).
 *   Lo cubre el fork `pdf-lib-with-encrypt@1.2.1` (drop-in del API de pdf-lib,
 *   única tool que lo usa). `EncryptedDocument.load(bytes, { password })` es la
 *   firma del contrato, y `doc.encrypt({ userPassword, ownerPassword, permissions })`
 *   existe con los mismos flags (printing 'lowResolution', modifying, copying,
 *   annotating).
 * - El build ESM del fork importa `import * as pako from 'pako'`; bajo Node puro
 *   (deps externalizadas) el namespace CJS de pako no expone `deflate` y crashea
 *   cualquier save. Por eso vitest lo procesa inline (ver vite.config.ts →
 *   `test.server.deps.inline`); en el navegador el interop lo hace Vite igual.
 * - El fork crashea al combinar cifrado con object streams, así que aquí el save
 *   SIEMPRE usa `useObjectStreams: false` (add y unlock).
 * - Contraseña incorrecta: pdf-lib-with-encrypt lanza `Error('Password
 *   incorrect')`; lo traducimos a `Error('Contraseña incorrecta')` para la UI.
 *   Cualquier otro fallo de parseo (PDF corrupto/u opcionalmente ya cifrado
 *   al hacer add) se traduce al error estable 'No se pudo leer el PDF'.
 * - Progreso: "Leyendo PDF"(10) → "Aplicando cifrado"(60) → "Generando
 *   archivo"(95) → "Listo"(100).
 */
import { PDFDocument } from 'pdf-lib-with-encrypt'
import { baseName, buildStep, pdfResult } from '@/tools/common/pdf-helpers'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/** Config del wizard: acción + contraseña (schema en tool.ts). */
interface ProtectConfig {
  status?: 'add' | 'unlock'
  password?: string
}

/** Permisos restrictivos por defecto: solo impresión en baja resolución. */
const RESTRICTIVE_PERMISSIONS: {
  printing: 'lowResolution'
  modifying: false
  copying: false
  annotating: false
} = {
  printing: 'lowResolution',
  modifying: false,
  copying: false,
  annotating: false,
}

/** Carga con el fork y mensaje estable si el PDF no se puede leer. */
async function loadPdf(bytes: Uint8Array, password?: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, password ? { password } : undefined)
  } catch (cause) {
    // Contraseña incorrecta: el fork lanza Error('Password incorrect').
    const message = cause instanceof Error ? cause.message : ''
    if (/password/i.test(message)) throw new Error('Contraseña incorrecta')
    throw new Error('No se pudo leer el PDF')
  }
}

/** Cifra el PDF con la contraseña y devuelve el ProcessResult `-protegido.pdf`. */
async function addPassword(
  input: EngineInput,
  password: string,
  base: string,
  applying: (p: number) => void,
  generating: (p: number) => void,
  done: (p: number) => void,
): Promise<ProcessResult> {
  if (!password) throw new Error('La contraseña no puede estar vacía')

  applying(60)
  const doc = await loadPdf(input.bytes)
  await doc.encrypt({
    userPassword: password,
    ownerPassword: password,
    permissions: RESTRICTIVE_PERMISSIONS,
  })
  const bytes = await doc.save({ useObjectStreams: false })
  generating(95)
  done(100)
  return pdfResult(`${base}-protegido.pdf`, bytes)
}

/** Descifra el PDF con la contraseña y devuelve el ProcessResult `-desbloqueado.pdf`. */
async function unlockPassword(
  input: EngineInput,
  password: string,
  base: string,
  applying: (p: number) => void,
  generating: (p: number) => void,
  done: (p: number) => void,
): Promise<ProcessResult> {
  applying(60)
  const doc = await loadPdf(input.bytes, password)
  const bytes = await doc.save({ useObjectStreams: false })
  generating(95)
  done(100)
  return pdfResult(`${base}-desbloqueado.pdf`, bytes)
}

/** Protege/desprotege un PDF según `config.status` (por defecto 'add'). */
export async function protectPdf(
  input: EngineInput,
  onProgress?: (e: ProgressEvent) => void,
): Promise<ProcessResult> {
  if (!input.bytes || input.bytes.length === 0) throw new Error('Se necesita un archivo')

  const config = input.config as ProtectConfig
  const status = config.status ?? 'add'
  const password = config.password ?? ''

  const base = baseName(input.name)
  const reading = buildStep(onProgress, 'Leyendo PDF')
  const applying = buildStep(onProgress, 'Aplicando cifrado')
  const generating = buildStep(onProgress, 'Generando archivo')
  const done = buildStep(onProgress, 'Listo')

  reading(10)
  return status === 'unlock'
    ? unlockPassword(input, password, base, applying, generating, done)
    : addPassword(input, password, base, applying, generating, done)
}