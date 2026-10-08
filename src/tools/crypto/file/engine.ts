/**
 * ADEI-ONE — Motor de "Encriptar archivo" (`crypto.file`).
 *
 * Auto-detección tipo VERNAM: si los primeros bytes son el magic `ADEI`
 * (contenedor ADEI1) se DESENCRIPTA; si no, se ENCRIPTA. 100% local: la
 * contraseña nunca sale del navegador.
 *
 * Cripto (auditada en el engine de VERNAM):
 *  - KDF  = Argon2id (`crypto_pwhash` con `crypto_pwhash_ALG_ARGON2ID13`).
 *  - AEAD = secretstream XChaCha20-Poly1305 (libsodium): cifra por chunks y
 *    cada `push`/`pull` autentica el estado del stream, así que una clave
 *    errónea o un byte alterado fallan en el `pull` correspondiente.
 *
 * Contenedor ADEI1 (formato propio, versión 1):
 *   magic 'ADEI' | version=1 | alg=ALG_ARGON2ID13 | opslimit u32le
 *   | memlimit u32le | salt(16) | header secretstream(24)
 *   | body: [len u32le][ciphertext]…
 *   El mensaje 0 del body es la metadata JSON `{n: nombre, s: size}` y el
 *   último chunk lleva TAG_FINAL.
 *
 * Decisiones:
 *  - Se usa `libsodium-wrappers-sumo` (misma API y versión que
 *    `libsodium-wrappers`): el build estándar de libsodium.js 0.8.x NO incluye
 *    Argon2 (excluido del wasm estándar), así que el sumo es el único build
 *    con `crypto_pwhash`. El import es dinámico (lazy) para no inflar el
 *    bundle inicial.
 *  - La cabecera se valida ANTES de derivar la clave (anti-DoS): alg debe ser
 *    Argon2id, opslimit 1..10 y memlimit 8MiB..1GiB; si no → error estable
 *    'No es un archivo ADEI-ONE válido' (sin derivar).
 *  - Errores estables: 'No es un archivo ADEI-ONE válido' (cabecera mala),
 *    'Archivo truncado o corrupto' (stream sin TAG_FINAL o longitud inválida)
 *    y 'Contraseña incorrecta o archivo corrupto' (fallo AEAD del pull).
 *  - Las constantes de TAG se toman SIEMPRE del wrapper: libsodium.js mapea
 *    TAG_MESSAGE=0 / TAG_FINAL=3 (el mapeo nativo es 3/2) y solo importa
 *    ser consistentes entre push y pull.
 *  - Progreso: "Leyendo archivo"(10) → "Derivando clave"(35) →
 *    "Encriptando/Desencriptando"(60..90) → "Listo"(100).
 */
import { baseName, buildStep, fileResult } from '@/tools/convert/helpers'
import type * as Sodium from 'libsodium-wrappers-sumo'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/** Config del wizard: contraseña + perfil de derivación (schema en tool.ts). */
interface CryptoConfig {
  passphrase?: string
  profile?: 'standard' | 'high'
}

/** Metadata del mensaje 0 del contenedor ADEI1. */
interface CryptoMeta {
  n: string
  s: number
}

/** Perfil de derivación Argon2id (un miembro de `PROFILES`). */
type Profile = (typeof PROFILES)[keyof typeof PROFILES]

/** Cabecera ADEI1 ya validada (offsets resueltos). */
interface AdeiHeader {
  alg: number
  opslimit: number
  memlimit: number
  salt: Uint8Array
  header: Uint8Array
}

/** Pasos de progreso de las fases 2-4 (la fase 1 la emite el engine). */
interface Steps {
  deriving: (value: number) => void
  processing: (value: number) => void
  done: (value: number) => void
}

const MAGIC = 'ADEI'
const VERSION = 1
const SALTBYTES = 16
const HEADERBYTES = 24
/** Tamaño fijo de la cabecera ADEI1 (4+1+1+4+4+16+24). */
const HEADER_SIZE = 4 + 1 + 1 + 4 + 4 + SALTBYTES + HEADERBYTES
/** Límite de memoria del KDF: 8 MiB..1 GiB (anti-DoS al descifrar). */
const OPS_MIN = 1
const OPS_MAX = 10
const MEM_MIN = 8 * 1024 * 1024
const MEM_MAX = 1024 * 1024 * 1024
/** Chunk de lectura/escritura del stream: 1 MiB. */
const CHUNK = 1 << 20
/** Clave de 32 bytes (secretstream xchacha20poly1305). */
const KEYBYTES = 32

/** Perfiles de derivación Argon2id (t = opslimit, m = memlimit). */
const PROFILES = {
  standard: { opslimit: 3, memlimit: 256 * 1024 * 1024 },
  high: { opslimit: 4, memlimit: 1 << 30 },
} as const

/** `n -> 4 bytes` en little-endian (uint32). */
function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4)
  out[0] = n & 0xff
  out[1] = (n >>> 8) & 0xff
  out[2] = (n >>> 16) & 0xff
  out[3] = (n >>> 24) & 0xff
  return out
}

/** Lee un uint32 little-endian en `off` (bytes inexistentes = 0). */
function rdU32le(buf: Uint8Array, off: number): number {
  return (
    (buf[off] ?? 0) +
    ((buf[off + 1] ?? 0) << 8) +
    ((buf[off + 2] ?? 0) << 16) +
    ((buf[off + 3] ?? 0) << 24)
  )
}

/** Concatena fragmentos en un único Uint8Array (copias contiguas). */
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((acc, p) => acc + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/** Detecta el magic 'ADEI' en los primeros 4 bytes (4 bytes mínimo). */
function isAdei(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  return bytes[0] === 0x41 && bytes[1] === 0x44 && bytes[2] === 0x45 && bytes[3] === 0x49
}

/**
 * Sanitiza el nombre original antes de devolverlo: quita rutas y backslashes,
 * caracteres de control y override bidireccional (U+202A-U+202E), puntos
 * iniciales ('.', '..', '.git'), recorta a 200 caracteres y garantiza un
 * nombre no vacío.
 */
export function sanitizeName(path: string): string {
  let base = path.replace(/\\/g, '/').split('/').pop() ?? ''
  // Filtra caracteres de control (U+0000-U+001F, U+007F) y override
  // bidireccional (U+202A-U+202E) por código, sin regex con controles.
  let clean = ''
  for (const ch of base) {
    const code = ch.charCodeAt(0)
    if (code >= 0x20 && code !== 0x7f && (code < 0x202a || code > 0x202e)) clean += ch
  }
  base = clean.replace(/^\.+/, '')
  base = base.slice(0, 200)
  return base.trim() || 'archivo'
}

/** Carga libsodium (sumo) de forma lazy y espera a que esté listo. */
async function loadSodium(): Promise<typeof Sodium> {
  const mod = await import('libsodium-wrappers-sumo')
  // En runtime (Node y navegador) toda la API vive en el export default; los
  // tipos declaran named exports, así que el objeto real coincide con el tipo
  // del namespace. Fallback al namespace por si un bundler aplana el default.
  const api =
    (mod as unknown as { default: typeof Sodium | undefined }).default ??
    (mod as unknown as typeof Sodium)
  await api.ready
  return api
}

/** Valida la cabecera ADEI1 ANTES de derivar la clave (anti-DoS). */
function parseAdeiHeader(bytes: Uint8Array, sodium: typeof Sodium): AdeiHeader {
  if (bytes.length < HEADER_SIZE) throw new Error('No es un archivo ADEI-ONE válido')
  if (!isAdei(bytes)) throw new Error('No es un archivo ADEI-ONE válido')
  if (bytes[4] !== VERSION) throw new Error('No es un archivo ADEI-ONE válido')
  const alg = bytes[5]
  if (alg !== sodium.crypto_pwhash_ALG_ARGON2ID13) throw new Error('No es un archivo ADEI-ONE válido')
  const opslimit = rdU32le(bytes, 6)
  const memlimit = rdU32le(bytes, 10)
  if (opslimit < OPS_MIN || opslimit > OPS_MAX) throw new Error('No es un archivo ADEI-ONE válido')
  if (memlimit < MEM_MIN || memlimit > MEM_MAX) throw new Error('No es un archivo ADEI-ONE válido')
  return {
    alg,
    opslimit,
    memlimit,
    salt: bytes.slice(14, 14 + SALTBYTES),
    header: bytes.slice(14 + SALTBYTES, 14 + SALTBYTES + HEADERBYTES),
  }
}

/** Construye los 54 bytes de cabecera ADEI1 para un cifrado nuevo. */
function buildAdeiHeader(
  sodium: typeof Sodium,
  opslimit: number,
  memlimit: number,
  salt: Uint8Array,
  header: Uint8Array,
): Uint8Array {
  const out = new Uint8Array(HEADER_SIZE)
  out.set(new TextEncoder().encode(MAGIC), 0)
  out[4] = VERSION
  out[5] = sodium.crypto_pwhash_ALG_ARGON2ID13
  out.set(u32le(opslimit), 6)
  out.set(u32le(memlimit), 10)
  out.set(salt, 14)
  out.set(header, 14 + SALTBYTES)
  return out
}

/** Parsea la metadata JSON del mensaje 0 (nombre + tamaño original). */
function parseMetadata(bytes: Uint8Array): CryptoMeta {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new Error('No es un archivo ADEI-ONE válido')
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('No es un archivo ADEI-ONE válido')
  const meta = parsed as Record<string, unknown>
  if (typeof meta.n !== 'string') throw new Error('No es un archivo ADEI-ONE válido')
  return { n: meta.n, s: typeof meta.s === 'number' ? meta.s : 0 }
}

/** ENCRYPT: cifra `input.bytes` → contenedor ADEI1 (`{base}.adei`). */
async function encryptFile(
  input: EngineInput,
  passphrase: string,
  profile: Profile,
  sodium: typeof Sodium,
  steps: Steps,
): Promise<ProcessResult> {
  const salt = sodium.randombytes_buf(SALTBYTES)
  steps.deriving(35)
  const key = sodium.crypto_pwhash(
    KEYBYTES,
    passphrase,
    salt,
    profile.opslimit,
    profile.memlimit,
    sodium.crypto_pwhash_ALG_ARGON2ID13,
  )
  try {
    const { state, header } = sodium.crypto_secretstream_xchacha20poly1305_init_push(key)
    const parts: Uint8Array[] = [
      buildAdeiHeader(sodium, profile.opslimit, profile.memlimit, salt, header),
    ]
    const meta = JSON.stringify({ n: input.name, s: input.bytes.length })
    const metaCipher = sodium.crypto_secretstream_xchacha20poly1305_push(
      state,
      meta,
      null,
      sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
    )
    parts.push(u32le(metaCipher.length))
    parts.push(metaCipher)

    const total = input.bytes.length
    let off = 0
    steps.processing(60)
    while (off < total) {
      const end = Math.min(off + CHUNK, total)
      const last = end === total
      const tag = last
        ? sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
        : sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
      const cipher = sodium.crypto_secretstream_xchacha20poly1305_push(
        state,
        input.bytes.subarray(off, end),
        null,
        tag,
      )
      parts.push(u32le(cipher.length))
      parts.push(cipher)
      off = end
      steps.processing(60 + Math.floor((30 * off) / total))
    }
    steps.done(100)
    return fileResult(`${baseName(input.name)}.adei`, concat(parts), 'txt', 'application/octet-stream')
  } finally {
    sodium.memzero(key)
  }
}

/** DECRYPT: abre el contenedor ADEI1 y devuelve los bytes originales. */
async function decryptFile(
  input: EngineInput,
  passphrase: string,
  sodium: typeof Sodium,
  steps: Steps,
): Promise<ProcessResult> {
  const bytes = input.bytes
  const head = parseAdeiHeader(bytes, sodium)
  steps.deriving(35)
  const key = sodium.crypto_pwhash(
    KEYBYTES,
    passphrase,
    head.salt,
    head.opslimit,
    head.memlimit,
    head.alg,
  )
  try {
    const state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(head.header, key)
    const chunks: Uint8Array[] = []
    let meta: CryptoMeta | null = null
    let off = HEADER_SIZE
    let finalTag = false
    steps.processing(60)
    while (off < bytes.length) {
      if (off + 4 > bytes.length) throw new Error('Archivo truncado o corrupto')
      const len = rdU32le(bytes, off)
      off += 4
      if (len < 0 || off + len > bytes.length) throw new Error('Archivo truncado o corrupto')
      const pull = sodium.crypto_secretstream_xchacha20poly1305_pull(
        state,
        bytes.subarray(off, off + len),
        null,
      )
      off += len
      if (pull === false) throw new Error('Contraseña incorrecta o archivo corrupto')
      const isFinal = pull.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      if (!isFinal && pull.tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE) {
        throw new Error('Archivo truncado o corrupto')
      }
      if (!meta) {
        meta = parseMetadata(pull.message)
        if (isFinal) throw new Error('Archivo truncado o corrupto')
        continue
      }
      chunks.push(pull.message)
      if (isFinal) {
        finalTag = true
        steps.processing(90)
        break
      }
      steps.processing(60 + Math.floor((30 * off) / bytes.length))
    }
    if (!meta || !finalTag) throw new Error('Archivo truncado o corrupto')
    steps.done(100)
    return fileResult(sanitizeName(meta.n), concat(chunks), 'txt', 'application/octet-stream')
  } finally {
    sodium.memzero(key)
  }
}

/** Encripta o desencripta según el magic del archivo (como VERNAM). */
export async function cryptoFile(
  input: EngineInput,
  onProgress?: (event: ProgressEvent) => void,
): Promise<ProcessResult> {
  if (!input.bytes || input.bytes.length === 0) throw new Error('Se necesita un archivo')

  const config = input.config as CryptoConfig
  const passphrase = config.passphrase ?? ''
  if (!passphrase) throw new Error('La contraseña no puede estar vacía')

  const reading = buildStep(onProgress, 'Leyendo archivo')
  const deriving = buildStep(onProgress, 'Derivando clave')
  const processing = buildStep(onProgress, 'Encriptando/Desencriptando')
  const done = buildStep(onProgress, 'Listo')
  reading(10)

  const sodium = await loadSodium()
  const steps: Steps = { deriving, processing, done }
  const profile: Profile = config.profile === 'high' ? PROFILES.high : PROFILES.standard
  return isAdei(input.bytes)
    ? decryptFile(input, passphrase, sodium, steps)
    : encryptFile(input, passphrase, profile, sodium, steps)
}