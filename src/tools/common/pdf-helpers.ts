/**
 * ADEI-ONE — Helpers PDF compartidos por las herramientas de la categoría 'pdf'.
 * Viven en `tools/common/` para no repetir lógica entre tools; NO importan
 * pdf-lib salvo donde hace falta (buildPdf/loadSource) para mantener lazy.
 */
import { PDFDocument } from 'pdf-lib'
import { zipSync } from 'fflate'
import type { FileKind, ProcessResult, ProgressEvent } from '@/core/types'

/** Wrapper opcional de `onProgress`: recibe el porcentaje y emite un evento. */
export type Step = (value: number) => void

export type ProgressCb = (event: ProgressEvent) => void

/** Devuelve un `Step` ligado a una fase; no emite nada si no hay callback. */
export function buildStep(
  onProgress: ProgressCb | undefined,
  phase: string,
  detail?: string,
): Step {
  return (percent: number) => onProgress?.({ phase, percent, detail })
}

/** Base del archivo de salida: `name` sin extensión, con fallback 'documento'. */
export function baseName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '')
  return base || 'documento'
}

/** Carga un PDF desde bytes crudos; ante cualquier fallo lanza un error estable. */
export async function loadSource(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes)
  } catch {
    throw new Error('No se pudo leer el PDF')
  }
}

/**
 * Construye un PDF nuevo con las páginas 1-indexed indicadas.
 * `pages` ya llega filtrado al rango válido del documento fuente.
 */
export async function buildPdf(src: PDFDocument, pages: number[]): Promise<Uint8Array> {
  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, pages.map((p) => p - 1))
  for (const page of copied) out.addPage(page)
  return out.save()
}

/** Empaqueta un set de PDFs en un ZIP con claves `pagina-N.pdf` (N = página original). */
export function zipPagedPdfs(pdfs: Uint8Array[], pageNumbers?: number[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  pdfs.forEach((bytes, i) => {
    const n = pageNumbers?.[i] ?? i + 1
    entries[`pagina-${n}.pdf`] = bytes
  })
  return zipSync(entries)
}

/**
 * Los tipos de TS generizan los TypedArrays (`Uint8Array<ArrayBufferLike>`) y
 * `BlobPart` exige `Uint8Array<ArrayBuffer>`; en runtime pdf-lib/fflate devuelven
 * arrays respaldados por `ArrayBuffer`, así que un cast tipográfico basta.
 */
function toBlobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart
}

/** Envuelve un Uint8Array como ProcessResult, calculando size del blob. */
export function pdfResult(
  name: string,
  bytes: Uint8Array,
  type = 'application/pdf',
  kind: FileKind = 'pdf',
): ProcessResult {
  const blob = new Blob([toBlobPart(bytes)], { type })
  return { name, kind, blob, size: blob.size }
}

/** ProcessResult para un ZIP (kind 'zip'). */
export function zipResult(name: string, bytes: Uint8Array): ProcessResult {
  return pdfResult(name, bytes, 'application/zip', 'zip')
}

/**
 * Parsea una lista de páginas como "2,5-7" → [2,5,6,7] (1-indexed).
 * Rango `a-b` inclusive; ignora espacios; descarta tokens inválidos.
 * Devuelve [] si la entrada vacía.
 */
export function parsePageList(list: string): number[] {
  const pages: number[] = []
  if (!list) return pages

  for (const raw of list.split(',')) {
    const token = raw.trim()
    if (!token) continue

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (end < start) continue
      if (end - start > 100_000) continue
      for (let p = start; p <= end; p++) pages.push(p)
      continue
    }

    if (/^\d+$/.test(token)) {
      const n = Number(token)
      if (n >= 1) pages.push(n)
    }
  }

  return pages
}

/**
 * Completa un orden parcial de páginas (1-indexed): respeta la secuencia marcada
 * (sin duplicados) y añade al final las páginas que no se tocaron, en orden natural.
 * Ej: `completeOrder([3, 1], 4)` → `[3, 1, 2, 4]`.
 */
export function completeOrder(order: number[], total: number): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const p of order) {
    if (Number.isInteger(p) && p >= 1 && p <= total && !seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  for (let p = 1; p <= total; p++) {
    if (!seen.has(p)) out.push(p)
  }
  return out
}