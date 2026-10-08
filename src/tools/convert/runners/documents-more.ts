/**
 * ADEI-ONE — Runners "documentos (más)" del "Convertidor universal".
 * Dominio separado de `documents.ts` para no pisar sus defs: conversiones a
 * texto/PDF desde el contenedor ZIP de Office/EPUB (PPTX, EPUB, ODT) y un
 * parser básico de RTF. El orquestador agrega `docMoreRunners` al índice.
 *
 * Todos los archivos ZIP se leen con fflate lazy (misma receta que docx→txt),
 * y el texto se extrae como texto plano + paginador A4 (`pagedPdf`).
 */
import {
  baseName,
  buildStep,
  decodeXmlEntities,
  pagedPdf,
  pdfResult,
  requireBytes,
  textResult,
} from '../helpers'
import type { ProgressCb, Step } from '../helpers'
import type { RunnerDef } from '../runner-types'
import type { EngineInput, ProcessResult } from '@/core/types'

/* ------------------------------------------------------------------ */
/* Progreso común (fases de esta familia)                              */
/* ------------------------------------------------------------------ */

/**
 * Fases canónicas: lectura del archivo → extracción del texto → generación.
 * Reemplaza la fase genérica "Convirtiendo" por "Extrayendo texto".
 */
function docSteps(onProgress?: ProgressCb): [Step, Step, Step, Step] {
  return [
    buildStep(onProgress, 'Leyendo archivo'),
    buildStep(onProgress, 'Extrayendo texto'),
    buildStep(onProgress, 'Generando archivo'),
    buildStep(onProgress, 'Listo'),
  ]
}

/* ------------------------------------------------------------------ */
/* PPTX → TXT / PDF (ppt/slides/slideN.xml, runs <a:t>)                */
/* ------------------------------------------------------------------ */

/** Número de la diapositiva a partir del nombre de entrada del ZIP. */
function pptxSlideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/i.exec(name)?.[1] ?? 0)
}

/** Texto plano de una diapositiva: une el contenido de los runs `<a:t>…</a:t>`. */
function pptxSlideText(xml: string): string {
  // `(?:\s[^>]*)?` evita confundir `<a:tbl>` (tabla) con un run de texto.
  const runs = [...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)]
  return decodeXmlEntities(runs.map((m) => m[1] ?? '').join(' ')).replace(/\s+/g, ' ').trim()
}

/**
 * Extrae el texto de todas las diapositivas en orden de número (1, 2, …).
 * Si no hay `slideN.xml` por patrón, intenta el camino canónico slide1.xml.
 */
function pptxSlidesText(
  entries: Record<string, Uint8Array>,
  decode: (bytes: Uint8Array) => string,
): string {
  const slideRe = /^ppt\/slides\/slide(\d+)\.xml$/i
  let names = Object.keys(entries).filter((key) => slideRe.test(key))
  if (names.length === 0 && entries['ppt/slides/slide1.xml']) {
    names = ['ppt/slides/slide1.xml']
  }
  if (names.length === 0) {
    throw new Error('La presentación no contiene diapositivas (ppt/slides/slideN.xml)')
  }
  names.sort((a, b) => pptxSlideNumber(a) - pptxSlideNumber(b))
  return names
    .map((name) => `— Slide ${pptxSlideNumber(name)} —\n\n${pptxSlideText(decode(entries[name]!))}`)
    .join('\n\n')
    .trim()
}

async function pptxToTxt(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, extracting, generating, done] = docSteps(onProgress)
  reading(10)
  const { unzipSync, strFromU8 } = await import('fflate')
  const entries = unzipSync(input.bytes)
  extracting(50)
  const text = pptxSlidesText(entries, strFromU8)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, text, 'txt', 'text/plain')
}

async function pptxToPdf(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, extracting, generating, done] = docSteps(onProgress)
  reading(10)
  const { unzipSync, strFromU8 } = await import('fflate')
  const entries = unzipSync(input.bytes)
  extracting(50)
  const text = pptxSlidesText(entries, strFromU8)
  const bytes = await pagedPdf(text)
  generating(90)
  done(100)
  return pdfResult(`${baseName(input.name)}.pdf`, bytes)
}

/* ------------------------------------------------------------------ */
/* EPUB → TXT (capítulos *.xhtml / *.html, raíz + OEBPS/)              */
/* ------------------------------------------------------------------ */

/**
 * Texto del EPUB: cada capítulo HTML/XHTML separado; `<br>` y cierres de
 * bloque → salto de línea, luego fuera etiquetas y entidades des-escaped.
 */
function epubText(
  entries: Record<string, Uint8Array>,
  decode: (bytes: Uint8Array) => string,
): string {
  const names = Object.keys(entries)
    .filter((key) => /\.(xhtml|html)$/i.test(key))
    .sort()
  if (names.length === 0) {
    throw new Error('El libro electrónico no contiene capítulos HTML (OEBPS/*.xhtml)')
  }
  return names
    .map((name) => {
      const raw = decode(entries[name]!)
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
      const text = decodeXmlEntities(raw).replace(/\n{3,}/g, '\n\n').trim()
      return `— ${name} —\n\n${text}`
    })
    .join('\n\n')
    .trim()
}

async function epubToTxt(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, extracting, generating, done] = docSteps(onProgress)
  reading(10)
  const { unzipSync, strFromU8 } = await import('fflate')
  const entries = unzipSync(input.bytes)
  extracting(50)
  const text = epubText(entries, strFromU8)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, text, 'txt', 'text/plain')
}

/* ------------------------------------------------------------------ */
/* ODT → TXT (content.xml, <text:p>/<text:h> → líneas)                 */
/* ------------------------------------------------------------------ */

/** Texto plano de un content.xml de ODT: parágrafos y encabezados → líneas. */
function odtText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<\/text:(p|h\d?)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function odtToTxt(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, extracting, generating, done] = docSteps(onProgress)
  reading(10)
  const { unzipSync, strFromU8 } = await import('fflate')
  const entries = unzipSync(input.bytes)
  const contentXml = entries['content.xml']
  if (!contentXml) throw new Error('El documento ODT no contiene content.xml')
  extracting(50)
  const text = odtText(strFromU8(contentXml))
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, text, 'txt', 'text/plain')
}

/* ------------------------------------------------------------------ */
/* RTF → TXT (parser básico de control words y grupos)                 */
/* ------------------------------------------------------------------ */

/**
 * Parser RTF mínimo y legible: saltos (`\par`/`\line`) y tabuladores antes
 * de limpiar, hex `\'hh` → carácter, fuera llaves de grupo y palabras de
 * control (`\word`, `\wordN` más su espacio delimitador).
 */
function rtfToPlainText(raw: string): string {
  return raw
    .replace(/\\par\b/gi, '\n') // fin de párrafo
    .replace(/\\line\b/gi, '\n') // salto de línea
    .replace(/\\tab\b/gi, '\t') // tabulador
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\*/g, '') // marcadores de grupo ignorado (\*)
    .replace(/[{}]/g, '') // llaves de agrupación
    .replace(/\\~/g, ' ') // espacio no rompible
    .replace(/\\-/g, '') // guión opcional
    .replace(/\\[a-z]+-?[0-9]* ?/gi, '') // palabras de control (+ espaciador)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function rtfToTxt(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, extracting, generating, done] = docSteps(onProgress)
  reading(10)
  extracting(50)
  const text = rtfToPlainText(new TextDecoder('utf-8').decode(input.bytes))
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, text, 'txt', 'text/plain')
}

/* ------------------------------------------------------------------ */
/* Defs del dominio                                                     */
/* ------------------------------------------------------------------ */

/** Runners de documentos adicionales (PPTX, EPUB, ODT, RTF). */
export const docMoreRunners: RunnerDef[] = [
  {
    id: 'pptx-to-txt',
    label: 'TXT',
    ext: 'txt',
    description: 'Extrae el texto de las diapositivas de PowerPoint a texto plano.',
    from: ['pptx'],
    run: pptxToTxt,
  },
  {
    id: 'pptx-to-pdf',
    label: 'PDF',
    ext: 'pdf',
    description: 'Convierte el texto de las diapositivas de PowerPoint a un PDF A4.',
    from: ['pptx'],
    run: pptxToPdf,
  },
  {
    id: 'epub-to-txt',
    label: 'TXT',
    ext: 'txt',
    description: 'Extrae el texto de los capítulos de un libro EPUB a texto plano.',
    from: ['epub'],
    run: epubToTxt,
  },
  {
    id: 'odt-to-txt',
    label: 'TXT',
    ext: 'txt',
    description: 'Extrae el texto de un documento ODT (LibreOffice) a texto plano.',
    from: ['odt'],
    run: odtToTxt,
  },
  {
    id: 'rtf-to-txt',
    label: 'TXT',
    ext: 'txt',
    description: 'Convierte un documento RTF (Rich Text Format) a texto plano.',
    from: ['rtf'],
    run: rtfToTxt,
  },
]