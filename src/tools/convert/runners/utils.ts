/**
 * ADEI-ONE — Runners de utilidades del "Convertidor universal".
 * Dominio: ZIP → manifest y SHA-256 (huella hexadecimal del archivo).
 */
import {
  baseName,
  requireBytes,
  steps,
  textResult,
  toHex,
} from '../helpers'
import type { ProgressCb } from '../helpers'
import type { RunnerDef } from '../runner-types'
import type { EngineInput, ProcessResult } from '@/core/types'

/* ZIP → manifest (nombre | tamaño) */ /* ------------------------------ */

async function zipToManifest(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const { unzipSync } = await import('fflate')
  const entries = unzipSync(input.bytes)
  converting(55)
  const lines = Object.entries(entries).map(([name, bytes]) => `${name} | ${bytes.length}`)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, lines.join('\n'), 'txt', 'text/plain')
}

/* SHA-256 */ /* -------------------------------------------------------- */

async function toSha256(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  converting(55)
  const source = input.bytes.buffer.slice(
    input.bytes.byteOffset,
    input.bytes.byteOffset + input.bytes.byteLength,
  ) as ArrayBuffer
  const digest = await crypto.subtle.digest('SHA-256', source)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.sha256.txt`, toHex(digest), 'txt', 'text/plain')
}

/**
 * Runners del dominio utilidades.
 * `to-sha256` vale para varios orígenes (md, txt, pdf, csv, json); su
 * metadata es la misma en todos, así que el id vive una sola vez aquí.
 */
export const utilRunners: RunnerDef[] = [
  {
    id: 'zip-to-manifest',
    label: 'Listado',
    ext: 'txt',
    description: 'Lista el contenido del ZIP: cada archivo con su nombre y tamaño.',
    from: ['zip'],
    run: zipToManifest,
  },
  {
    id: 'to-sha256',
    label: 'SHA-256',
    ext: 'txt',
    description: 'Calcula el hash SHA-256 del archivo (huella hexadecimal de 64 caracteres).',
    from: ['md', 'txt', 'pdf', 'csv', 'json'],
    run: toSha256,
  },
]