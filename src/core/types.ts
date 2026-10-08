/**
 * ADEI-ONE — Tipos de dominio (vocabulario canónico, ver .agents/agents.md)
 * Términos: Artifact, FileKind, Action, ActionConfig, Processor, Workflow,
 *          MetadataReport, ProgressEvent.
 */
import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'

/** Categorías del catálogo (coinciden con el mapa de tinywow que replicamos). */
export type Category =
  | 'principales'
  | 'pdf'
  | 'image'
  | 'av'
  | 'convert'
  | 'write'
  | 'meta'

/** Tipo detectado por magic-bytes (en la shell inicial: por extensión; Fase 1 = magic-bytes). */
export type FileKind =
  | 'pdf'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'md'
  | 'txt'
  | 'csv'
  | 'xml'
  | 'json'
  | 'jpg'
  | 'png'
  | 'webp'
  | 'gif'
  | 'svg'
  | 'tiff'
  | 'heic'
  | 'mp3'
  | 'flac'
  | 'm4a'
  | 'wav'
  | 'mp4'
  | 'mov'
  | 'mkv'
  | 'avi'
  | 'webm'
  | 'epub'
  | 'zip'
  | 'html'
  | 'odt'
  | 'rtf'
  | 'yaml'
  | 'toml'
  | 'adei'
  | 'unknown'

/** Entrada cruda que entra al sistema: archivo o texto pegado. */
export interface Artifact {
  id: string
  name: string
  kind: FileKind
  size: number // bytes
  source: 'file' | 'text'
  file?: File
  text?: string
  /** Blob de resultado generado por un procesador (Fase 1+). */
  blob?: Blob
}

/** Configuración tipada que produce el wizard a partir de un schema Zod. */
export type ActionConfig = Record<string, unknown>

/** Evento de progreso que emiten los Processors (UI nunca se bloquea). */
export interface ProgressEvent {
  phase: string
  percent: number
  detail?: string
}

/** Resultado material de un procesador (blob real, listo para descargar). */
export interface ProcessResult {
  name: string
  kind: FileKind
  blob: Blob
  size: number
  /** Verificación posterior a la limpieza (solo `meta.strip` la rellena). */
  verification?: VerificationResult
}

/**
 * Resultado de comprobar que el archivo limpio no conserva metadata eliminable.
 * Se calcula re-escaneando los bytes de salida (no bloquea la descarga).
 */
export interface VerificationResult {
  /** 'clean' = no quedó nada eliminable · 'remaining' = quedan restos · 'unverifiable' = no se pudo comprobar */
  status: 'clean' | 'remaining' | 'unverifiable'
  /** Nº de entradas eliminables que siguen presentes (solo con status 'remaining') */
  remaining?: number
  /** Muestra corta de etiquetas/claves de esos restos */
  sample?: string[]
}

/** Archivo extra que acompaña a una tool multiarchivo (p. ej. Unir PDFs). */
export interface ExtraFile {
  name: string
  bytes: Uint8Array
}

/**
 * Entrada de un engine: bytes puros, sin depender del `File` del navegador
 * (worker-safe). El puerto `getBytes` la construye desde el Artifact.
 * `extras` alimenta herramientas multiarchivo (merge).
 */
export interface EngineInput {
  bytes: Uint8Array
  name: string
  kind: FileKind
  config: ActionConfig
  extras?: ExtraFile[]
}

/**
 * Firmar principal de un procesador (engine) de Fase 1+.
 * Corre de forma asíncrona y reporta progreso; devuelve un blob real.
 * (Los procesados pesados futuros se moverán a Web Workers; este contrato lo permite.)
 */
export type ProcessorFn = (
  input: EngineInput,
  onProgress: (event: ProgressEvent) => void,
) => Promise<ProcessResult>

/** Props de una vista custom de tool (UI especial, opcional). */
export interface ToolViewProps {
  action: Action
  artifact: Artifact
  /** (config, files?) — `files` lo usan las tools multiarchivo (Unir PDFs). */
  onSubmit: (config: ActionConfig, files?: Artifact[]) => void
}

export type ToolViewComponent = ComponentType<ToolViewProps>

/** Campo de metadata detectado (para la tool "Eliminar metadata"). */
export interface MetadataField {
  name: string
  value: string
  sensitivity: 'high' | 'medium' | 'low'
  /**
   * Cuándo se puede eliminar este campo (el visor lo resalta por modo):
   * - `'light'` → el modo Ligero lo borra (lossless)
   * - `'deep'`  → solo el modo Profundo (regenera/re-codifica el archivo)
   * - `'never'` → estructural/técnico: se conserva siempre
   * Ausente = hereda el valor del BLOQUE padre (`MetadataBlock.removableIn`).
   */
  removableIn?: 'light' | 'deep' | 'never'
}

/**
 * Bloque de metadata agrupado por procedencia (EXIF/GPS, XMP, docProps…).
 * `id` es la clave que el wizard envía en `config.blocks` para pedir su borrado.
 * `removableIn` indica en qué modo se elimina el bloque ENTERO; el visor lo usa
 * para iluminar lo que se puede quitar (Ligero / solo Profundo / se conserva).
 */
export interface MetadataBlock {
  id: string
  label: string
  fields: MetadataField[]
  removableIn?: 'light' | 'deep' | 'never'
}

/**
 * Cómo se puede eliminar físicamente una entrada del inventario:
 * - `'individual'`     → el strip borra SOLO esa entrada (p. ej. un `©xyz` de ilst).
 * - `'with-container'` → borrarla arrastra su contenedor (p. ej. todos los frames ID3v2).
 * - `'never'`          → dato técnico/estructural: se conserva siempre.
 */
export type MetaRemoval = 'individual' | 'with-container' | 'never'

/**
 * Entrada EXHAUSTIVA del inventario de metadata: una por cada elemento físico
 * que el archivo realmente contiene, incluidos los desconocidos. Nunca se
 * oculta nada: si no conocemos la clave, va su valor crudo.
 */
export interface MetaEntry {
  /** Ruta legible del contenedor: 'moov > udta > meta > ilst > ©xyz' */
  where: string
  /** Clave cruda tal como está en el archivo: '©xyz', 'TXXX', 'TIT2', 'IDIT'… */
  key: string
  /** Nombre legible si lo conocemos (Título, GPS…); ausente = desconocida */
  label?: string
  /** Valor legible (recortado) */
  value: string
  /** Tamaño en bytes del dato, si se conoce */
  size?: number
  /** Hex corto (máx. 32 bytes) para valores binarios */
  hex?: string
  sensitivity: 'high' | 'medium' | 'low'
  /** individual = borrable solo; with-container = arrastra su contenedor; never = técnico */
  removal: MetaRemoval
}

/**
 * Aviso de pérdida CONCRETA al regenerar el archivo en el modo elegido.
 * `affects` indica en qué modo se produce la pérdida ('deep' re-genera/rasteriza,
 * 'light' re-codifica). El visor lo muestra inline en la tarjeta del modo.
 */
export type RegenerationRisk = {
  /** Identificador estable (p. ej. 'pdf-forms'). */
  id: string
  /** Etiqueta corta para el usuario (español). */
  label: string
  /** Qué se pierde exactamente (español). */
  detail: string
  severity: 'high' | 'medium'
  /** Modo en el que se produce la pérdida. */
  affects: 'deep' | 'light'
}

/** Resultado del scan de metadata (el visor usa `entries`; `blocks`/`fields` son el legado). */
export interface MetadataReport {
  fields: MetadataField[]
  count: number
  blocks: MetadataBlock[]
  /** Inventario exhaustivo: TODO lo que el archivo contiene (incluido lo desconocido). */
  entries: MetaEntry[]
  /**
   * Avisos de pérdida al limpiar ESTE archivo (opcional: los productores que no
   * los detectan siguen siendo válidos). Vacío o ausente = sin avisos.
   */
  risks?: RegenerationRisk[]
}

/**
 * Una Action = capability declarada del catálogo.
 * El wizard se genera del `schema`; las tarjetas se filtran por `appliesTo`.
 */
export interface Action {
  id: string
  name: string
  description: string
  category: Category
  /** FileKinds sobre los que aplica (vacío = aplica a todos). */
  appliesTo: FileKind[]
  keywords: string[]
  icon: LucideIcon
  /** Schema Zod de su configuración (wizard auto-generado). null = sin opciones. */
  schema?: unknown // ZodSchema<ActionConfig> — se tipa al integrar Zod v4
  needsGpu?: boolean
}

/** Contract de Processor (deep module, se ejecuta en su Web Worker). */
export interface Processor<C extends ActionConfig = ActionConfig> {
  run(input: { artifact: Artifact; config: C }): AsyncIterable<ProgressEvent>
}