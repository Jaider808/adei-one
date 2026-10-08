/**
 * ADEI-ONE — Contrato compartido de los runners del "Convertidor universal".
 *
 * Este módulo es la ÚNICA fuente del contrato de conversión: evita ciclos de
 * imports (engine → runners → runner-types) y mantiene juntas la metadata y el
 * runner de cada conversión. El id de cada conversión vive UNA vez aquí (RunnerDef).
 */
import type { EngineInput, FileKind, ProcessResult, ProgressEvent } from '@/core/types'

/** Una conversión posible (origen → destino), visible en la UI. */
export interface ConversionOption {
  id: string
  /** Etiqueta del destino, ej. 'JPG', 'JSON', 'HTML'. */
  label: string
  ext: string
  /** Descripción de lo que hace la conversión (se muestra al usuario). */
  description: string
  requiresCanvas?: boolean
}

/** Firma de ejecución: convierte la entrada y reporta progreso opcional. */
export type RunFn = (
  input: EngineInput,
  onProgress?: (event: ProgressEvent) => void,
) => Promise<ProcessResult>

/**
 * Única fuente por conversión: metadata + runner juntos. El id vive UNA vez.
 * `from` lista los tipos de origen a los que aplica (p. ej. 'to-sha256' vale
 * para md, txt, pdf, csv y json).
 */
export interface RunnerDef {
  id: string
  label: string
  ext: string
  description: string
  from: FileKind[]
  requiresCanvas?: boolean
  run: RunFn
}