/**
 * ADEI-ONE — Helper ZIP compartido de "Eliminar metadata" (`meta.strip`).
 *
 * ODF (ODT) y EPUB exigen que la entrada `mimetype` sea la PRIMERA del archivo
 * y esté ALMACENADA (método de compresión 0, sin campo extra). Un `zipSync`
 * ingenuo reordena y comprime → el documento deja de ser válido. Aquí se
 * centraliza la lectura, la reconstrucción que garantiza ese requisito y la
 * inspección de la cabecera LOCAL del ZIP para poder probarlo.
 *
 * Nunca lanza: un ZIP que no se puede interpretar devuelve `null` (o una
 * inspección `null`) para que el dominio haga passthrough byte a byte.
 */
import { unzipSync, zipSync } from 'fflate'

/** Mapa `nombre → bytes` de las entradas de un ZIP. */
export type ZipEntries = Record<string, Uint8Array>

/** Nombre de la entrada cuyo orden y almacenamiento son obligatorios en ODF/EPUB. */
export const MIMETYPE_ENTRY = 'mimetype'

/** Lee un ZIP. Devuelve `null` si no es interpretable (nunca lanza). */
export function readZip(bytes: Uint8Array): ZipEntries | null {
  try {
    return unzipSync(bytes)
  } catch {
    return null
  }
}

/**
 * Reconstruye un ZIP. La entrada `mimetype` va SIEMPRE la primera y almacenada
 * (método 0, sin campo extra); el resto conserva su orden original.
 *
 * La garantía se AUTOCONTROLA: `fflate` itera con `for...in`, que visita primero
 * las claves enteras, así que una entrada numérica (p. ej. `123`) puede adelantar
 * a `mimetype` y romper OCF/EPUB. Tras construir el ZIP se comprueba con
 * `firstLocalEntry`; si `mimetype` no es la primera entrada o no está almacenada,
 * se devuelve `null` para que el llamante haga passthrough byte a byte.
 */
export function writeZip(entries: ZipEntries): Uint8Array | null {
  const ordered: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {}
  const mimetype = entries[MIMETYPE_ENTRY]
  if (mimetype) ordered[MIMETYPE_ENTRY] = [mimetype, { level: 0 }]
  for (const [name, data] of Object.entries(entries)) {
    if (name === MIMETYPE_ENTRY) continue
    ordered[name] = data
  }
  const out = zipSync(ordered)
  // Solo hay garantía que verificar si el paquete declara `mimetype`.
  if (mimetype) {
    const first = firstLocalEntry(out)
    if (first === null || first.name !== MIMETYPE_ENTRY || first.method !== 0) return null
  }
  return out
}

/** Cabecera local del primer fichero de un ZIP. */
export interface ZipFirstEntry {
  name: string
  /** Método de compresión (0 = almacenado, 8 = deflate). */
  method: number
}

/** Firma de una cabecera local de ZIP: `PK\x03\x04`. */
const SIG_LOCAL = [0x50, 0x4b, 0x03, 0x04]

/**
 * Lee la cabecera LOCAL del primer fichero del ZIP (firma `PK\x03\x04`): el
 * método de compresión está en el offset 8, la longitud del nombre en el 26 y
 * el nombre en el 30. `null` si no hay firma o el tramo es demasiado corto
 * (nunca lanza).
 */
export function firstLocalEntry(bytes: Uint8Array): ZipFirstEntry | null {
  if (bytes.length < 30) return null
  for (let i = 0; i < SIG_LOCAL.length; i++) {
    if (bytes[i] !== SIG_LOCAL[i]) return null
  }
  const method = bytes[8] | (bytes[9] << 8)
  const nameLength = bytes[26] | (bytes[27] << 8)
  const nameStart = 30
  const nameEnd = nameStart + nameLength
  if (nameEnd > bytes.length) return null
  const name = new TextDecoder('utf-8').decode(bytes.subarray(nameStart, nameEnd))
  return { name, method }
}
