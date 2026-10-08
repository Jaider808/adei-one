/**
 * ADEI-ONE — Contrato de los dominios de "Eliminar metadata" (`meta.strip`).
 *
 * Los módulos por dominio (audio, image-plus, video) son cirugía binaria PURA:
 * comen `Uint8Array` → devuelven `Uint8Array` limpio. Eso los hace testeables
 * en Node sin DOM (mismo patrón que `chunks.ts`). El engine solo orquesta.
 *
 * Semántica del modo:
 * - `light` = lossless estricto: se eliminan SOLO los bloques de `blocks` (si
 *   la lista está vacía, no se elimina nada y los bytes pasan tal cual).
 * - `deep`  = máxima limpieza: se eliminan TODOS los bloques del formato y los
 *   restos (padding, basura final…) independientemente de `blocks`. Para
 *   formatos que admiten regeneración (imagen canvas / PDF rasterizado) es el
 *   engine quien re-genera; para audio/video/office la cirugía sigue lossless.
 */
import type { FileKind, MetadataBlock, MetadataReport, MetaEntry, MetaRemoval } from '@/core/types'

export type Reporter = (phase: string, percent: number) => void

/** Configuración de limpieza que llega del wizard (vía `EngineInput.config`). */
export interface StripConfig {
  mode: 'light' | 'deep'
  /** IDs de bloques a eliminar (los del scan). Vacío = ninguno (light) / todos (deep). */
  blocks: string[]
}

export type DomainScan = (bytes: Uint8Array) => Promise<MetadataReport>

export type DomainStrip = (
  bytes: Uint8Array,
  kind: FileKind,
  config: StripConfig,
  report: Reporter,
) => Promise<Uint8Array>

/** Un dominio = familia de formatos con su escaneo y su strip. */
export interface MetaDomain {
  kinds: readonly FileKind[]
  scan: DomainScan
  strip: DomainStrip
}

/** Report vacío reutilizable (escaneos sin metadata). */
export const EMPTY_REPORT: MetadataReport = { fields: [], count: 0, blocks: [], entries: [] }

/** Modo de borrado físico derivado de la marca de un bloque (`removableIn`). */
export function removalOf(removableIn: MetadataBlock['removableIn']): MetaRemoval {
  return removableIn === 'never' ? 'never' : 'with-container'
}

/**
 * Entradas genéricas derivadas de los bloques. Se usa en los dominios que aún
 * no enumeran de forma exhaustiva (PDF, Office, Markdown, imagen-extra): el
 * visor recibe `entries` no vacío y cae a `blocks` solo si viene vacío.
 */
export function entriesFromBlocks(blocks: MetadataBlock[]): MetaEntry[] {
  const entries: MetaEntry[] = []
  for (const block of blocks) {
    const removal = removalOf(block.removableIn)
    for (const field of block.fields) {
      entries.push({
        where: block.label,
        key: field.name,
        label: field.name,
        value: field.value,
        sensitivity: field.sensitivity,
        removal,
      })
    }
  }
  return entries
}

/** Hex corto (máx. 32 bytes por defecto) para valores binarios del inventario. */
export function shortHex(bytes: Uint8Array, max = 32): string {
  const slice = bytes.slice(0, Math.max(0, max))
  const out = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ')
  return bytes.length > slice.length ? `${out}…` : out
}

/** Fotografía el progreso solo si el caller pasó callback. */
export function makeReporter(onProgress?: (e: { phase: string; percent: number }) => void): Reporter {
  return (phase, percent) => onProgress?.({ phase, percent })
}