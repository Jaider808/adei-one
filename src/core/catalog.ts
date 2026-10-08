/**
 * Catálogo declarativo de Actions.
 * Las tools IMPLEMENTADAS viven en `src/tools/<categoria>/<tool>/` (metadata +
 * engine + vista + tests). Aquí solo se importan (TOOLS) y se definen las
 * PENDIENTES (sin motor → la card se muestra gris "Próximamente").
 */
import {
  FileArchive,
  FileText,
  FileType2,
  Languages,
  LockOpen,
  PenLine,
  RefreshCcw,
  Scissors,
  Sparkles,
  Split,
  Stamp,
  Type,
  Wand2,
} from 'lucide-react'
import { z } from 'zod'
import { TOOLS } from '@/tools'
import type { Action, FileKind } from '@/core/types'

export const CATEGORY_LABELS: Record<Action['category'], string> = {
  principales: 'Principales',
  pdf: 'PDF',
  image: 'Imagen',
  av: 'Video y audio',
  convert: 'Convertidores',
  write: 'Texto e IA',
  meta: 'Privacidad',
}

/** Subtítulo breve por categoría (se muestra al desplegar el acordeón). */
export const CATEGORY_SUBTITLES: Record<Action['category'], string> = {
  principales: 'Tus herramientas esenciales, siempre a mano.',
  pdf: 'Recorta, une, firma, convierte y limpia documentos PDF.',
  image: 'Recorta, redimensiona, convierte y optimiza tus imágenes.',
  av: 'Recorta, convierte y transcribe video y audio.',
  convert: 'Convierte y limpia datos: CSV, Excel, XML, JSON y más.',
  write: 'IA local: traduce, resume y reescribe texto.',
  meta: 'Borra la metadata que delata a tus archivos.',
}

export const CATEGORY_ORDER: Action['category'][] = [
  'principales',
  'pdf',
  'image',
  'av',
  'convert',
  'write',
  'meta',
]

/** Cómo funciona cada categoría: qué hace, pasos cortos + tecnologías (transparencia local). */
export interface CategoryHowItWorks {
  /** Qué hace esta categoría (qué esperar). */
  what: string
  steps: string[]
  tools: string[]
}

export const CATEGORY_HOW_IT_WORKS: Record<Action['category'], CategoryHowItWorks> = {
  principales: {
    what: 'Tus herramientas de cabecera: convierte a muchos formatos, limpia la metadata que delata y encripta/desencripta cualquier archivo con tu contraseña.',
    steps: [
      'Sube tu archivo.',
      'Elige la herramienta esencial: convertir, limpiar metadata o encriptar.',
      'Configúrala (formato, contraseña…).',
      'Pulsa "Procesar".',
      'Descarga el resultado: todo se hace en tu navegador.',
    ],
    tools: ['convertidor universal', 'borrado de metadata', 'XChaCha20 + Argon2id (encriptado)'],
  },
  pdf: {
    what: 'Edita y organiza tus documentos PDF: recorta solo las páginas que quieres, une varios archivos, elimina o reordena páginas, extrae el texto y protégelos con contraseña.',
    steps: [
      'Sube tu PDF.',
      'Elige la herramienta: recortar, unir, eliminar páginas, extraer texto…',
      'Marca las páginas o configura las opciones.',
      'Pulsa "Procesar".',
      'Descarga el resultado: aquí no se sube nada, todo se hace en tu navegador.',
    ],
    tools: ['pdf-lib (estructura y edición)', 'pdf.js (páginas y texto)', 'fflate (archivos ZIP)'],
  },
  image: {
    what: 'Convierte y optimiza tus imágenes: recorta, redimensiona, cambia de formato, comprime y extrae su texto.',
    steps: [
      'Sube la imagen.',
      'Elige la acción: recortar, convertir, comprimir, OCR…',
      'Ajusta las opciones.',
      'Pulsa "Procesar".',
      'Descarga el resultado — procesado 100% local.',
    ],
    tools: ['Canvas + WebGPU', 'sharp-wasm (formatos)', 'tesseract.js (OCR)'],
  },
  av: {
    what: 'Trabaja con video y audio: recorta, convierte de formato, extrae el audio y transcribe con IA local.',
    steps: [
      'Sube el video o audio.',
      'Elige la acción: recortar, convertir, extraer audio, transcribir…',
      'Configura la operación.',
      'Pulsa "Procesar".',
      'Descarga el archivo — nunca sale de tu navegador.',
    ],
    tools: ['ffmpeg.wasm (conversión)', 'WebCodecs (recorte nativo)', 'Whisper local (transcripción)'],
  },
  convert: {
    what: 'Convierte y organiza datos: transforma CSV, Excel, XML y JSON entre formatos.',
    steps: [
      'Sube el archivo de datos (CSV, XML…).',
      'Elige el formato de salida.',
      'Pulsa "Procesar".',
      'Descarga el archivo convertido.',
    ],
    tools: ['SheetJS (Excel)', 'papaparse (CSV)', 'fflate (ZIP/XML)'],
  },
  write: {
    what: 'Procesa texto con IA local: traduce, resume y reescribe sin enviar tu contenido a ningún servidor.',
    steps: [
      'Pega un texto o sube el archivo.',
      'Elige la tarea: traducir, resumir, reescribir…',
      'La IA local genera el resultado.',
      'Copia o descarga el texto.',
    ],
    tools: ['transformers.js', 'WebGPU (aceleración)', 'WASM (fallback CPU)'],
  },
  meta: {
    what: 'Limpia la información oculta de tus archivos: autor, fechas, GPS y demás metadata que te delata.',
    steps: [
      'Sube el archivo.',
      'Escaneamos qué metadata contiene (autor, fechas, GPS…).',
      'Revisa lo que quieres eliminar.',
      'Pulsa "Procesar".',
      'El archivo limpio se queda contigo — sin subidas.',
    ],
    tools: ['pdf-lib', 'fflate (ZIP)', 'análisis de metadata local'],
  },
}

/**
 * Tools pendientes (sin motor aún): aparecen en el catálogo gris/bloqueadas.
 * Cuando una tool se implemente, se mueve a `src/tools/…` y se quita de aquí.
 */
const PENDING: Action[] = [
  // ---------- Video y audio ----------
  {
    id: 'av.trim',
    name: 'Recortar video',
    description: 'Selecciona inicio y fin y conserva solo ese tramo.',
    category: 'av',
    appliesTo: ['mp4', 'mov', 'mkv', 'avi', 'webm'],
    keywords: ['recortar', 'trim', 'video', 'cortar'],
    icon: Scissors,
  },
  {
    id: 'av.convert',
    name: 'Convertir video',
    description: 'MP4, MOV, MKV, WebM, GIF… cambia de formato.',
    category: 'av',
    appliesTo: ['mp4', 'mov', 'mkv', 'avi', 'webm'],
    keywords: ['convertir', 'formato', 'video'],
    icon: RefreshCcw,
  },
  {
    id: 'av.extract-audio',
    name: 'Extraer audio',
    description: 'Saca el audio del video a MP3 o M4A.',
    category: 'av',
    appliesTo: ['mp4', 'mov', 'mkv', 'avi', 'webm'],
    keywords: ['audio', 'mp3', 'extraer', 'banda sonora'],
    icon: FileText,
    schema: z.object({
      format: z.enum(['mp3', 'm4a', 'wav']).describe('Formato de audio'),
      keepVideo: z.boolean().describe('Conservar el video sin sonido'),
    }),
  },
  {
    id: 'av.to-text',
    name: 'Audio a texto',
    description: 'Transcribe con Whisper local (WebGPU/CPU).',
    category: 'av',
    appliesTo: ['mp3', 'flac', 'm4a', 'wav', 'mp4', 'webm'],
    keywords: ['transcribir', 'subtítulos', 'whisper', 'texto'],
    icon: Type,
    needsGpu: true,
  },
  {
    id: 'av.compress',
    name: 'Comprimir video',
    description: 'Menos peso manteniendo una calidad razonable.',
    category: 'av',
    appliesTo: ['mp4', 'mov', 'mkv', 'avi', 'webm'],
    keywords: ['comprimir', 'peso', 'reducir'],
    icon: FileArchive,
  },

  // ---------- Convertidores ----------
  {
    id: 'convert.csv-excel',
    name: 'CSV a Excel',
    description: 'Convierte CSV a XLSX con columnas limpias.',
    category: 'convert',
    appliesTo: ['csv'],
    keywords: ['csv', 'excel', 'xlsx', 'tabla'],
    icon: FileType2,
  },
  {
    id: 'convert.xml-json',
    name: 'XML a JSON',
    description: 'Transforma cualquier XML a JSON legible.',
    category: 'convert',
    appliesTo: ['xml'],
    keywords: ['xml', 'json', 'convertir'],
    icon: RefreshCcw,
  },
  {
    id: 'convert.split-csv',
    name: 'Dividir CSV',
    description: 'Parte un CSV grande en varios archivos.',
    category: 'convert',
    appliesTo: ['csv'],
    keywords: ['dividir', 'csv', 'split', 'partes'],
    icon: Split,
  },
  {
    id: 'convert.qr',
    name: 'Generar QR',
    description: 'Crea un código QR desde texto o enlace.',
    category: 'convert',
    appliesTo: ['txt'],
    keywords: ['qr', 'código', 'enlace'],
    icon: Stamp,
  },
  {
    id: 'convert.meme',
    name: 'Creador de memes',
    description: 'Añade texto arriba y abajo a tu imagen.',
    category: 'convert',
    appliesTo: ['jpg', 'png', 'webp'],
    keywords: ['meme', 'texto', 'humor'],
    icon: Wand2,
  },

  // ---------- Texto e IA ----------
  {
    id: 'write.translate',
    name: 'Traducir texto',
    description: 'Traducción local con NLLB (WebGPU/CPU).',
    category: 'write',
    appliesTo: ['txt', 'md'],
    keywords: ['traducir', 'idioma', 'nllb'],
    icon: Languages,
    needsGpu: true,
  },
  {
    id: 'write.summarize',
    name: 'Resumir texto',
    description: 'Resumen conciso y por puntos con modelo local.',
    category: 'write',
    appliesTo: ['txt', 'md', 'pdf'],
    keywords: ['resumir', 'summary', 'ideas', 'puntos'],
    icon: Sparkles,
    needsGpu: true,
  },
  {
    id: 'write.rewrite',
    name: 'Reescribir',
    description: 'Reformula el texto con otro tono o estilo.',
    category: 'write',
    appliesTo: ['txt', 'md'],
    keywords: ['reescribir', 'parafrasear', 'tono'],
    icon: PenLine,
    needsGpu: true,
  },
]

/** Catálogo completo: tools implementadas + pendientes. */
export const CATALOG: Action[] = [...TOOLS, ...PENDING]

/** Devuelve las Actions que aplican a un FileKind (vacío = transversal). */
export function actionsForKind(kind: FileKind): Action[] {
  return CATALOG.filter((a) => a.appliesTo.length === 0 || a.appliesTo.includes(kind))
}

/** Agrupa Actions por categoría manteniendo el orden del catálogo. */
export function groupByCategory(actions: Action[]): Map<Action['category'], Action[]> {
  const map = new Map<Action['category'], Action[]>()
  for (const action of actions) {
    const bucket = map.get(action.category) ?? []
    bucket.push(action)
    map.set(action.category, bucket)
  }
  return map
}

/** Icono de bloqueo de privacidad: reutiliza el de "meta". */
export { LockOpen }