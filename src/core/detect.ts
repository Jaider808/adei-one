/**
 * Detección de FileKind.
 * - Fallback síncrono y ligero: extensión → MIME.
 * - Fase 1: detección real por magic-bytes con file-type (cabecera del archivo).
 */
import type { FileKind } from '@/core/types'
import { extOf } from '@/lib/utils'

const EXT_TO_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
  md: 'md',
  txt: 'txt',
  csv: 'csv',
  xml: 'xml',
  json: 'json',
  jpg: 'jpg',
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif',
  svg: 'svg',
  tiff: 'tiff',
  tif: 'tiff',
  heic: 'heic',
  heif: 'heic',
  mp3: 'mp3',
  flac: 'flac',
  m4a: 'm4a',
  wav: 'wav',
  mp4: 'mp4',
  mov: 'mov',
  mkv: 'mkv',
  avi: 'avi',
  webm: 'webm',
  epub: 'epub',
  zip: 'zip',
  html: 'html',
  htm: 'html',
  odt: 'odt',
  rtf: 'rtf',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  adei: 'adei',
}

const MIME_FALLBACK: Record<string, FileKind> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
}

/**
 * MIME → FileKind para la detección por magic-bytes (file-type).
 * Extiende el fallback MIME con los MIME que devuelve file-type.
 */
export const MIME_TO_KIND: Record<string, FileKind> = {
  ...MIME_FALLBACK,
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/heif': 'heic',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'audio/flac': 'flac',
  'application/zip': 'zip',
  'application/epub+zip': 'epub',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/rtf': 'rtf',
  'text/html': 'html',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}

/** Detecta el FileKind de un File (extensión → fallback MIME → unknown). */
export function detectKind(file: File): FileKind {
  const fromExt = EXT_TO_KIND[extOf(file.name)]
  if (fromExt) return fromExt
  if (file.type) {
    const normalized = file.type.toLowerCase()
    if (normalized === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx'
    if (normalized === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx'
    if (normalized === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx'
    const fromMime = MIME_FALLBACK[normalized]
    if (fromMime) return fromMime
  }
  return 'unknown'
}

/**
 * Detecta el FileKind por magic-bytes reales (file-type): lee solo los
 * primeros 4100 bytes del archivo y compara su cabecera con los formatos
 * conocidos. Devuelve 'unknown' si no hay coincidencia.
 * file-type se importa de forma diferida (solo se descarga al soltar un archivo).
 */
export async function detectKindByMagic(file: File): Promise<FileKind> {
  const head = new Uint8Array(await file.slice(0, 4100).arrayBuffer())
  // Magic propio de ADEI-ONE: contenedor encriptado `.adei` (cabecera "ADEI")
  if (head.length >= 4 && head[0] === 0x41 && head[1] === 0x44 && head[2] === 0x45 && head[3] === 0x49) {
    return 'adei'
  }
  const { fileTypeFromBuffer } = await import('file-type')
  const ft = await fileTypeFromBuffer(head)
  if (!ft) return 'unknown'
  return MIME_TO_KIND[ft.mime] ?? 'unknown'
}