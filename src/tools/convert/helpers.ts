/**
 * ADEI-ONE — Helpers compartidos del motor de conversión (`convert.any`).
 *
 * Viven aquí para que los runners de los 5 dominios (text, data, documents,
 * images, utils) no repitan lógica y el engine quede delgado. Se re-exportan
 * SIN duplicar los helpers ya existentes de `@/tools/common/pdf-helpers`
 * (`pdfResult`, `zipResult`, `baseName`, `buildStep`).
 */
import { PDFDocument, PageSizes, StandardFonts, rgb } from 'pdf-lib'
import { baseName, buildStep, pdfResult, zipResult } from '@/tools/common/pdf-helpers'
import type { FileKind, ProcessResult, ProgressEvent } from '@/core/types'

// Re-export de pdf-helpers: los módulos de runners importan TODO desde aquí.
export { baseName, buildStep, pdfResult, zipResult }

/** Callback de progreso (igual que pdf-helpers, re-exportado para comodidad). */
export type ProgressCb = (event: ProgressEvent) => void
/** Un paso de progreso: `(percent) => onProgress?.({ phase, percent })`. */
export type Step = (percent: number) => void

/** Guarda de entrada vacía (misma frase que el resto de engines). */
export function requireBytes(bytes: Uint8Array): void {
  if (!bytes || bytes.length === 0) throw new Error('Se necesita un archivo')
}

/**
 * `Uint8Array -> Blob`. Cast tipográfico idéntico al de `pdf-helpers`:
 * en runtime los bytes vienen respaldados por ArrayBuffer propio.
 */
export function toBlobPart(bytes: Uint8Array): BlobPart {
  return bytes as unknown as BlobPart
}

/** ProcessResult genérico para salidas en texto (kind y MIME explícitos). */
export function textResult(name: string, text: string, kind: FileKind, mime: string): ProcessResult {
  const blob = new Blob([text], { type: mime })
  return { name, kind, blob, size: blob.size }
}

/** ProcessResult genérico para salidas binarias (imágenes, etc.). */
export function fileResult(name: string, bytes: Uint8Array, kind: FileKind, mime: string): ProcessResult {
  const blob = new Blob([toBlobPart(bytes)], { type: mime })
  return { name, kind, blob, size: blob.size }
}

/** Decodifica UTF-8 manteniendo el tipo Uint8Array como viene del runner. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes)
}

/** Des-escapa las entidades XML básicas (la `&amp;` va al final por orden). */
export function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Las 4 fases canónicas de progreso (no emiten si no hay callback). */
export function steps(onProgress?: ProgressCb): [Step, Step, Step, Step] {
  return [
    buildStep(onProgress, 'Leyendo archivo'),
    buildStep(onProgress, 'Convirtiendo'),
    buildStep(onProgress, 'Generando archivo'),
    buildStep(onProgress, 'Listo'),
  ]
}

/* ------------------------------------------------------------------ */
/* Paginador A4 (pdf-lib) para MD/TXT/HTML → PDF                       */
/* ------------------------------------------------------------------ */

export const WRAP_WIDTH = 90
export const LINES_PER_PAGE = 48

/** Envuelve el texto a `max` caracteres por línea (divide palabras largas). */
export function wrapText(text: string, max: number): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) {
      out.push('') // conserva párrafos en blanco
      continue
    }
    let line = ''
    for (const word of raw.split(/\s+/)) {
      let w = word
      // palabra más larga que el ancho: se trocea
      while (w.length > max) {
        if (line) {
          out.push(line)
          line = ''
        }
        out.push(w.slice(0, max))
        w = w.slice(max)
      }
      if (line.length + (line ? 1 : 0) + w.length > max) {
        out.push(line)
        line = w
      } else {
        line = line ? `${line} ${w}` : w
      }
    }
    if (line) out.push(line)
  }
  return out
}

/** Página texto plano como PDF A4 (misma plantilla que txt→pdf). */
export async function pagedPdf(text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pageHeight = PageSizes.A4[1]
  const pageWidth = PageSizes.A4[0]
  const fontSize = 11
  const lineHeight = 14.2
  const margin = 48

  let page = doc.addPage(PageSizes.A4)
  let y = pageHeight - margin
  let perPage = 0
  for (const line of wrapText(text, WRAP_WIDTH)) {
    if (perPage >= LINES_PER_PAGE) {
      page = doc.addPage(PageSizes.A4)
      y = pageHeight - margin
      perPage = 0
    }
    page.drawText(line, {
      x: margin,
      y,
      size: fontSize,
      font,
      color: rgb(0.1, 0.1, 0.1),
      maxWidth: pageWidth - margin * 2,
    })
    y -= lineHeight
    perPage++
  }
  return doc.save()
}

/* ------------------------------------------------------------------ */
/* Parser CSV y serialización de celdas                                */
/* ------------------------------------------------------------------ */

/** Parser CSV con soporte de comillas dobles; devuelve matriz de celdas. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      // \r de los CRLF se ignora; el \n siguiente cierra la fila
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Serializa un valor a celda CSV escapando comas, comillas y saltos. */
export function csvCell(value: unknown): string {
  const s =
    typeof value === 'string'
      ? value
      : value === null || value === undefined
        ? ''
        : JSON.stringify(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Texto plano de un HTML: fuera etiquetas y entidades básicas decodificadas. */
export function htmlToText(html: string): string {
  return decodeXmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/* ------------------------------------------------------------------ */
/* Base64 manual (codificación binaria, sin btoa ni Buffer)            */
/* ------------------------------------------------------------------ */

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Codifica bytes a Base64 con un bucle binario (sin btoa ni Buffer). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = i + 1 < bytes.length ? bytes[i + 1] ?? 0 : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] ?? 0 : 0
    out += BASE64_ALPHABET[b0 >> 2]
    out += BASE64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)]
    out += i + 1 < bytes.length ? BASE64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '='
    out += i + 2 < bytes.length ? BASE64_ALPHABET[b2 & 63] : '='
  }
  return out
}

/** Índice de un carácter Base64 (o -1 si no es válido). */
export function base64Index(ch: string): number {
  const code = ch.charCodeAt(0)
  if (code >= 65 && code <= 90) return code - 65
  if (code >= 97 && code <= 122) return code - 97 + 26
  if (code >= 48 && code <= 57) return code - 48 + 52
  if (ch === '+') return 62
  if (ch === '/') return 63
  return -1
}

/** Decodifica una cadena Base64 a bytes (ignora espacios; valida padding). */
export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '')
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error('El texto no es Base64 válido')
  }
  const out: number[] = []
  for (let i = 0; i < clean.length; i += 4) {
    const a = base64Index(clean[i] ?? '')
    const b = base64Index(clean[i + 1] ?? '')
    const c = clean[i + 2] === '=' ? 0 : base64Index(clean[i + 2] ?? '')
    const d = clean[i + 3] === '=' ? 0 : base64Index(clean[i + 3] ?? '')
    if (a < 0 || b < 0) throw new Error('El texto no es Base64 válido')
    out.push((a << 2) | (b >> 4))
    if (clean[i + 2] !== '=') out.push(((b & 15) << 4) | (c >> 2))
    if (clean[i + 3] !== '=') out.push(((c & 3) << 6) | d)
  }
  return Uint8Array.from(out)
}

/* ------------------------------------------------------------------ */
/* Criptografía y normalización de módulos                             */
/* ------------------------------------------------------------------ */

/** Convierte el digest a su representación hexadecimal en minúsculas. */
export function toHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** Normaliza el namespace CJS/ESM de una dependencia sin tipos (default o módulo). */
export function moduleDefault<T>(mod: { default?: T } | T): T {
  return (mod as { default?: T }).default ?? (mod as T)
}

/* ------------------------------------------------------------------ */
/* Canvas → bytes                                                      */
/* ------------------------------------------------------------------ */

/** toBlob a Uint8Array (promesa; el callback async no bloquea el evento). */
export function canvasToBytes(
  canvas: HTMLCanvasElement,
  mime: string,
  quality: number | undefined,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      async (blob) => {
        if (!blob) {
          reject(new Error('No se pudo generar la imagen'))
          return
        }
        resolve(new Uint8Array(await blob.arrayBuffer()))
      },
      mime,
      quality,
    )
  })
}