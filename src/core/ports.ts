/**
 * ADEI-ONE — Puertos (hexagonal-lite).
 *
 * La arquitectura es "slices por herramienta" (FSD) + ports & adapters solo en
 * las suturas que lo ameritan. Estos puertos aíslan el DOMINIO (engines) del
 * navegador:
 *
 *  - `getBytes`:    el engine nunca toca un `File`; accede a `Uint8Array`.
 *  - `saveResult`:  guardado con `showSaveFilePicker` (fallback a <a download>).
 *  - `Runner`:      CÓMO se ejecuta un engine. Hoy main-thread; mañana un adapter
 *                   de Web Worker con las mismas firmas (cero cambios en engines).
 */
import type {
  Artifact,
  EngineInput,
  ProcessResult,
  ProgressEvent,
  ProcessorFn,
} from '@/core/types'

/* ────────────────────────────────────────────────────────────
 * Puerto: acceso a bytes del archivo
 * ──────────────────────────────────────────────────────────── */
export async function getBytes(source: Artifact & { bytes?: Uint8Array }): Promise<Uint8Array> {
  if (source.bytes) return source.bytes
  const blob = source.file ?? source.blob
  if (!blob) throw new Error('Se necesita un archivo')
  return new Uint8Array(await blob.arrayBuffer())
}

/* ────────────────────────────────────────────────────────────
 * Puerto: guardar un resultado en disco
 * ──────────────────────────────────────────────────────────── */
export const SUPPORTS_PICKER =
  typeof window !== 'undefined' && 'showSaveFilePicker' in window

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName?: string
    types?: Array<{ description: string; accept: Record<string, string[]> }>
  }) => Promise<{
    createWritable: () => Promise<{
      write: (blob: Blob) => Promise<void>
      close: () => Promise<void>
    }>
  }>
}

export async function saveResult(blob: Blob, filename: string): Promise<void> {
  // Ruta principal: diálogo nativo del navegador (elige dónde guardar).
  try {
    const picker = (window as SaveFilePickerWindow).showSaveFilePicker
    if (picker) {
      const ext = filename.includes('.') ? filename.split('.').pop()! : ''
      const handle = await picker({
        suggestedName: filename,
        types: [
          {
            description: 'Archivo',
            accept: { 'application/octet-stream': ext ? [ext] : [] },
          },
        ],
      })
      const writable = await handle.createWritable()
      await writable.write(blob)
      await writable.close()
      return
    }
  } catch {
    /* usuario canceló o falló → fallback silencioso a descarga clásica */
  }

  // Fallback: <a download>.
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/* ────────────────────────────────────────────────────────────
 * Puerto: Runner (ejecución de engines)
 * ──────────────────────────────────────────────────────────── */
export interface RunContext {
  onProgress: (event: ProgressEvent) => void
}

export interface Runner {
  run(engine: ProcessorFn, input: EngineInput, ctx: RunContext): Promise<ProcessResult>
}

/** Runner actual: ejecución en el hilo principal (await no bloquea la UI). */
export const mainThreadRunner: Runner = {
  run: (engine, input, ctx) => engine(input, ctx.onProgress),
}