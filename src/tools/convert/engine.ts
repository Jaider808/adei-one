/**
 * ADEI-ONE — Motor del "Convertidor universal de archivos" (`convert.any`).
 *
 * ENGINE DELGADO: la lógica vive en los runners de `runners/` (5 dominios) y
 * en `helpers.ts`; aquí solo se agrega y se despacha. La única fuente por
 * conversión es `RunnerDef` (`runner-types.ts`): el id, la metadata y el runner
 * viven juntos UNA vez; este archivo deriva de ahí `CONVERSIONS` (agrupado por
 * tipo de origen) e `OPTIONS_BY_ID` sin duplicar nada.
 *
 * Contrato público inalterado:
 * - `ConversionOption` (tipo, re-exportado desde runner-types).
 * - `CONVERSIONS` (origen → destinos, mismos ids/labels/descripciones).
 * - `conversionsFor(kind)` → solo las conversiones posibles para el tipo.
 * - `convertAny(input, onProgress?)` → ejecuta el runner del `config.to`.
 *
 * Decisiones (spec + criterio):
 * - CLASIFICACION SINCRONA: `CONVERSIONS`/`conversionsFor` son puros, así la
 *   vista pinta las tarjetas sin cargar ningún motor pesado.
 * - REUTILIZACIÓN de engines hermanos (lazy): pdf→txt usa
 *   `extract-text/engine`; pdf→imágenes se implementa en el runner (pdf.js
 *   legacy + canvas → ZIP).
 * - Dependencias pesadas con `import()` dinámico dentro del runner que las
 *   usa (regla bundle-dynamic-imports); los helpers comunes (parseCsv,
 *   paginador A4, base64, canvas) están centralizados en `helpers.ts`.
 * - Entrada vacía → error estable "Se necesita un archivo". Sin canvas en
 *   Node → "Esta conversión requiere el navegador".
 * - image→image admite jpg→jpg, png→png, etc. (re-encodificado): el contrato
 *   define las tres opciones por tipo de imagen.
 */
import type { ConversionOption, RunnerDef, RunFn } from './runner-types'
import { ALL_RUNNER_DEFS } from './runners'
import type { FileKind, EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

export type { ConversionOption } from './runner-types'

/** Todos los runners (agregados en runners/index.ts, en orden de dominio). */
const ALL_DEFS: RunnerDef[] = ALL_RUNNER_DEFS

/** Orden de grupos por tipo de origen (para mantener la UI estable). */
const GROUP_ORDER: FileKind[] = [
  'md',
  'txt',
  'html',
  'yaml',
  'toml',
  'pdf',
  'pptx',
  'epub',
  'odt',
  'rtf',
  'csv',
  'json',
  'xml',
  'docx',
  'xlsx',
  'jpg',
  'png',
  'webp',
  'gif',
  'heic',
  'tiff',
  'zip',
]

/** Convierte un RunnerDef en su ConversionOption visible en la UI. */
function toOption(def: RunnerDef): ConversionOption {
  return {
    id: def.id,
    label: def.label,
    ext: def.ext,
    description: def.description,
    ...(def.requiresCanvas ? { requiresCanvas: true } : {}),
  }
}

/** Agrupa los runners por tipo de origen, respetando el orden de GROUP_ORDER. */
function buildConversions(): Array<{ from: FileKind; options: ConversionOption[] }> {
  const byFrom = new Map<FileKind, ConversionOption[]>()
  for (const def of ALL_DEFS) {
    for (const from of def.from) {
      let options = byFrom.get(from)
      if (!options) {
        options = []
        byFrom.set(from, options)
      }
      options.push(toOption(def))
    }
  }
  return GROUP_ORDER.map((from) => ({ from, options: byFrom.get(from) ?? [] }))
}

/** Todas las conversiones disponibles (origen → destinos). */
export const CONVERSIONS: Array<{ from: FileKind; options: ConversionOption[] }> = buildConversions()

/** Índice id → runner (única fuente: los RunnerDef). */
const RUNNERS: Record<string, RunFn> = {}
/** Índice id → opción (metadata para validar requiresCanvas y descripcion). */
const OPTIONS_BY_ID: Record<string, ConversionOption> = {}
for (const def of ALL_DEFS) {
  RUNNERS[def.id] = def.run
  OPTIONS_BY_ID[def.id] = toOption(def)
}

/** Solo las conversiones posibles para el tipo del archivo subido. */
export function conversionsFor(kind: FileKind): ConversionOption[] {
  return CONVERSIONS.find((group) => group.from === kind)?.options ?? []
}

/**
 * Convierte el archivo al destino indicado en `input.config.to`.
 * Valida: id conocido → runner; canvas requerido → navegador; y despacha.
 */
export async function convertAny(
  input: EngineInput,
  onProgress?: (event: ProgressEvent) => void,
): Promise<ProcessResult> {
  const to = (input.config as { to?: string }).to
  const option = to ? OPTIONS_BY_ID[to] : undefined
  if (!to || !option || !RUNNERS[to]) throw new Error('Conversión no disponible')
  if (
    option.requiresCanvas &&
    (typeof document === 'undefined' || typeof document.createElement !== 'function')
  ) {
    throw new Error('Esta conversión requiere el navegador')
  }
  return RUNNERS[to]!(input, onProgress)
}