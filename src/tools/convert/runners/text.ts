/**
 * ADEI-ONE — Runners de texto del "Convertidor universal".
 * Dominio: Markdown/TXT → TXT, HTML, PDF, Base64 (y Base64 → bytes).
 * El Markdown se renderiza con un mini-render honesto (sin CommonMark completo).
 */
import { PDFDocument, PageSizes, StandardFonts, rgb } from 'pdf-lib'
import {
  baseName,
  base64ToBytes,
  bytesToBase64,
  decodeUtf8,
  fileResult,
  htmlToText,
  LINES_PER_PAGE,
  pagedPdf,
  pdfResult,
  requireBytes,
  steps,
  textResult,
  WRAP_WIDTH,
  wrapText,
} from '../helpers'
import type { ProgressCb } from '../helpers'
import type { RunnerDef } from '../runner-types'
import type { EngineInput, ProcessResult } from '@/core/types'

/** Quita el frontmatter YAML `---\n…\n---` del inicio (si existe). */
function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

/** Limpia los marcadores Markdown básicos dejando solo texto legible. */
function cleanMarkdown(text: string): string {
  return (
    text
      // delimitadores de bloques de código (el contenido se conserva)
      .replace(/```/g, '')
      // headings
      .replace(/^#{1,6}\s+/gm, '')
      // negritas
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      // cursivas *texto* y _texto_
      .replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2')
      .replace(/(^|\s)_([^_\n]+)_/g, '$1$2')
      // citas en bloque
      .replace(/^\s*>\s?/gm, '')
      // marcadores de listas
      .replace(/^\s*[-*+]\s+/gm, '')
      // código inline
      .replace(/`([^`]+)`/g, '$1')
      // normaliza saltos de línea triples → dobles
      .replace(/\n{3,}/g, '\n\n')
  )
}

async function mdToTxt(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  converting(55)
  const text = cleanMarkdown(stripFrontmatter(decodeUtf8(input.bytes)))
  generating(90)
  done(100)
  return Promise.resolve(textResult(`${baseName(input.name)}.txt`, text, 'txt', 'text/plain'))
}

/** Escapa HTML ANTES de aplicar el mini-render (contenido nunca se interpreta). */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Da formato inline honesto (negrita, cursiva, código) sobre texto ya escapado. */
function inlineFormat(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

/**
 * Rendering Markdown mínimo y HONESTO: headings, listas (agrupadas en `<ul>`),
 * citas, párrafos y bloques de código. No promete CommonMark completo.
 */
function renderMarkdownToHtml(text: string): string {
  const out: string[] = []
  let inCode = false
  const codeLines: string[] = []
  const listItems: string[] = []

  function flushList(): void {
    if (listItems.length === 0) return
    out.push(`<ul>\n${listItems.map((li) => `  <li>${li}</li>`).join('\n')}\n</ul>`)
    listItems.length = 0
  }
  function flushCode(): void {
    if (codeLines.length === 0) return
    out.push(`<pre><code>${codeLines.join('\n')}</code></pre>`)
    codeLines.length = 0
  }

  for (const raw of text.split(/\r?\n/)) {
    if (raw.trimStart().startsWith('```')) {
      if (inCode) {
        flushCode()
        inCode = false
      } else {
        flushList()
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeLines.push(raw)
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (heading) {
      flushList()
      const level = heading[1]!.length
      out.push(`<h${level}>${heading[2] ?? ''}</h${level}>`)
      continue
    }

    const item = /^\s*[-*+]\s+(.*)$/.exec(raw)
    if (item) {
      listItems.push(inlineFormat(item[1] ?? ''))
      continue
    }

    flushList()
    if (/^\s*>\s?/.test(raw)) {
      out.push(`<blockquote>${inlineFormat(raw.replace(/^\s*>\s?/, ''))}</blockquote>`)
      continue
    }
    if (!raw.trim()) continue
    out.push(`<p>${inlineFormat(raw)}</p>`)
  }
  flushList()
  if (inCode) flushCode()
  return out.join('\n')
}

/** Título del HTML: primer heading de nivel 1-6, si hay. */
function titleOf(md: string): string {
  return /^#{1,6}\s+(.+)$/m.exec(md)?.[1]?.trim() ?? ''
}

async function mdToHtml(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  converting(55)
  const md = stripFrontmatter(decodeUtf8(input.bytes))
  const body = renderMarkdownToHtml(escapeHtml(md))
  const title = titleOf(md) || baseName(input.name)
  const html = [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${title}</title>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n')
  generating(90)
  done(100)
  // kind 'txt' con MIME text/html (contrato de la spec).
  return Promise.resolve(textResult(`${baseName(input.name)}.html`, html, 'txt', 'text/html'))
}

async function txtToPdf(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const lines = wrapText(decodeUtf8(input.bytes), WRAP_WIDTH)
  converting(45)

  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const pageHeight = PageSizes.A4[1]
  const fontSize = 11
  const lineHeight = 14.2
  const margin = 48
  const pageWidth = PageSizes.A4[0]

  let page = doc.addPage(PageSizes.A4)
  let y = pageHeight - margin
  let perPage = 0
  for (const line of lines) {
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

  generating(90)
  const bytes = await doc.save()
  done(100)
  return pdfResult(`${baseName(input.name)}.pdf`, bytes)
}

async function mdToPdf(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const text = cleanMarkdown(stripFrontmatter(decodeUtf8(input.bytes)))
  converting(55)
  const bytes = await pagedPdf(text)
  generating(90)
  done(100)
  return pdfResult(`${baseName(input.name)}.pdf`, bytes)
}

async function htmlToPdf(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const text = htmlToText(decodeUtf8(input.bytes))
  converting(55)
  const bytes = await pagedPdf(text)
  generating(90)
  done(100)
  return pdfResult(`${baseName(input.name)}.pdf`, bytes)
}

async function txtToBase64(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const b64 = bytesToBase64(input.bytes)
  converting(55)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.base64.txt`, b64, 'txt', 'text/plain')
}

async function base64ToTxt(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const bytes = base64ToBytes(decodeUtf8(input.bytes))
  converting(55)
  generating(90)
  done(100)
  return fileResult(`${baseName(input.name)}.bin`, bytes, 'txt', 'application/octet-stream')
}

/** Runners del dominio texto (Markdown/TXT). */
export const textRunners: RunnerDef[] = [
  {
    id: 'md-to-txt',
    label: 'TXT',
    ext: 'txt',
    description: 'Convierte el Markdown a texto plano, sin marcadores ni formato.',
    from: ['md'],
    run: mdToTxt,
  },
  {
    id: 'md-to-html',
    label: 'HTML',
    ext: 'html',
    description: 'Renderiza el Markdown como una página HTML simple y legible.',
    from: ['md'],
    run: mdToHtml,
  },
  {
    id: 'txt-to-pdf',
    label: 'PDF',
    ext: 'pdf',
    description: 'Convierte el texto a un documento PDF (A4), listo para imprimir o compartir.',
    from: ['txt'],
    run: txtToPdf,
  },
  {
    id: 'md-to-pdf',
    label: 'PDF',
    ext: 'pdf',
    description: 'Convierte el Markdown a un PDF A4, con el texto limpio y paginado.',
    from: ['md'],
    run: mdToPdf,
  },
  {
    id: 'html-to-pdf',
    label: 'PDF (HTML)',
    ext: 'pdf',
    description: 'Extrae el texto de un archivo HTML y lo convierte a un PDF A4.',
    from: ['txt'],
    run: htmlToPdf,
  },
  {
    id: 'txt-to-base64',
    label: 'Base64',
    ext: 'txt',
    description: 'Codifica el archivo como texto Base64, útil para incrustarlo o transferirlo.',
    from: ['txt'],
    run: txtToBase64,
  },
  {
    id: 'base64-to-txt',
    label: 'Datos',
    ext: 'bin',
    description: 'Decodifica un texto Base64 de vuelta a bytes binarios (.bin).',
    from: ['txt'],
    run: base64ToTxt,
  },
]