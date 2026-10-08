/**
 * ADEI-ONE — Runners de documentos del "Convertidor universal".
 * Dominio: PDF → TXT/DOCX/CSV/imágenes (ZIP) y DOCX → TXT/HTML/PDF.
 * Librerías pesadas (pdfjs-dist, docx, mammoth, fflate) vía `import()` dinámico.
 * pdf→txt reutiliza el engine hermano `pdf/extract-text`.
 */
import {
  baseName,
  buildStep,
  canvasToBytes,
  csvCell,
  decodeXmlEntities,
  fileResult,
  moduleDefault,
  pagedPdf,
  pdfResult,
  requireBytes,
  steps,
  textResult,
  zipResult,
} from '../helpers'
import type { ProgressCb } from '../helpers'
import type { RunnerDef } from '../runner-types'
import type { EngineInput, ProcessResult } from '@/core/types'

/** MIME del formato DOCX que generamos. */
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

/* PDF → TXT (reutiliza el engine hermano pdf/extract-text) */ /* ------ */

async function pdfToTxt(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  const { extractPdfText } = await import('@/tools/pdf/extract-text/engine')
  // El engine hermano valida bytes vacíos ("Se necesita un archivo") y
  // devuelve un .txt ya coherente (`{base}-texto.txt`).
  return extractPdfText(input, onProgress)
}

type PdfImageFormat = 'jpg' | 'png' | 'webp'

/**
 * Render de cada página del PDF (pdf.js legacy, lazy) a imágenes del formato
 * elegido y empaquetadas en ZIP. Necesita navegador (canvas).
 */
async function pdfToImages(
  input: EngineInput,
  onProgress: ProgressCb | undefined,
  format: PdfImageFormat,
): Promise<ProcessResult> {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('Esta conversión requiere el navegador')
  }

  const base = baseName(input.name)
  const mime = format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'
  const reading = buildStep(onProgress, 'Leyendo PDF')
  const processing = buildStep(onProgress, 'Renderizando páginas')
  const generating = buildStep(onProgress, 'Generando ZIP')

  reading(10)
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (typeof window !== 'undefined' && !pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  }

  const doc = await pdfjs.getDocument({ data: input.bytes }).promise
  const entries: Record<string, Uint8Array> = {}
  try {
    const total = doc.numPages
    for (let i = 1; i <= total; i++) {
      processing(Math.round(20 + (i / total) * 70))
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale: 1.5 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      await page.render({ canvas, viewport }).promise

      entries[`pagina-${i}.${format}`] = await canvasToBytes(canvas, mime, 0.9)
      page.cleanup()
    }
  } finally {
    try {
      await doc.loadingTask.destroy()
    } catch {
      /* ya liberado */
    }
  }

  const { zipSync } = await import('fflate')
  generating(95)
  return zipResult(`${base}-${format}.zip`, zipSync(entries))
}

/* PDF → DOCX (texto en párrafos) */ /* ------------------------------- */

async function pdfToDocx(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const { extractPdfText } = await import('@/tools/pdf/extract-text/engine')
  const txt = await extractPdfText(input, onProgress)
  const text = await txt.blob.text()
  const { Document, Packer, Paragraph } = await import('docx')
  converting(55)
  const children = text.split(/\r?\n/).map((line) => new Paragraph({ text: line }))
  const doc = new Document({ sections: [{ children }] })
  const ab = await Packer.toArrayBuffer(doc)
  generating(90)
  done(100)
  return fileResult(`${baseName(input.name)}.docx`, new Uint8Array(ab), 'docx', DOCX_MIME)
}

/* PDF → CSV (una columna por línea de texto) */ /* -------------------- */

async function pdfToCsv(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const { extractPdfText } = await import('@/tools/pdf/extract-text/engine')
  const txt = await extractPdfText(input, onProgress)
  const text = await txt.blob.text()
  converting(55)
  const csv = text.split(/\r?\n/).map((line) => csvCell(line)).join('\n')
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.csv`, csv, 'csv', 'text/csv')
}

/* DOCX → TXT (parsing directo del XML) */ /* ------------------------- */

async function docxToTxt(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const { unzipSync, strFromU8 } = await import('fflate')
  const entries = unzipSync(input.bytes)
  const documentXml = entries['word/document.xml']
  if (!documentXml) throw new Error('El documento Word no contiene texto (word/document.xml)')
  converting(55)
  // Cada </w:p> = fin de párrafo → salto de línea; luego se quitan las etiquetas.
  const text = decodeXmlEntities(
    strFromU8(documentXml).replace(/<\/w:p>/gi, '\n').replace(/<[^>]+>/g, ''),
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, text, 'txt', 'text/plain')
}

/* DOCX → HTML (mammoth) */ /* ---------------------------------------- */

async function docxToHtml(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const mod = await import('mammoth')
  const mammoth = moduleDefault<{ convertToHtml(input: object): Promise<{ value: string }> }>(mod)
  converting(55)
  // En Node mammoth lee `buffer`; en el navegador lee `arrayBuffer`.
  const ab = input.bytes.slice().buffer as ArrayBuffer
  const result = await mammoth.convertToHtml({ buffer: ab, arrayBuffer: ab })
  const title = baseName(input.name)
  const html = [
    '<!doctype html>',
    '<html lang="es">',
    '<head>',
    '  <meta charset="utf-8">',
    `  <title>${title}</title>`,
    '</head>',
    '<body>',
    result.value,
    '</body>',
    '</html>',
  ].join('\n')
  generating(90)
  done(100)
  return textResult(`${title}.html`, html, 'txt', 'text/html')
}

/* DOCX → PDF (texto plano paginado, reutiliza el runner docx→txt) */ /* - */

async function docxToPdf(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  // Reutiliza la extracción de texto del DOCX (misma lógica que docx→txt).
  const txt = await docxToTxt(input, onProgress)
  const text = await txt.blob.text()
  converting(55)
  const bytes = await pagedPdf(text)
  generating(90)
  done(100)
  return pdfResult(`${baseName(input.name)}.pdf`, bytes)
}

/** Runners del dominio documentos (PDF/DOCX). */
export const docRunners: RunnerDef[] = [
  {
    id: 'pdf-to-txt',
    label: 'TXT',
    ext: 'txt',
    description: 'Extrae el texto del PDF a un archivo de texto plano.',
    from: ['pdf'],
    run: pdfToTxt,
  },
  {
    id: 'pdf-to-docx',
    label: 'DOCX',
    ext: 'docx',
    description: 'Convierte el texto del PDF a un documento Word editable (DOCX).',
    from: ['pdf'],
    run: pdfToDocx,
  },
  {
    id: 'pdf-to-csv',
    label: 'CSV',
    ext: 'csv',
    description: 'Extracción básica de líneas del PDF a una tabla CSV de una columna.',
    from: ['pdf'],
    run: pdfToCsv,
  },
  {
    id: 'pdf-to-jpg',
    label: 'JPG',
    ext: 'jpg',
    description: 'Convierte cada página del PDF a una imagen JPG (descarga un ZIP).',
    from: ['pdf'],
    requiresCanvas: true,
    run: (input, onProgress) => pdfToImages(input, onProgress, 'jpg'),
  },
  {
    id: 'pdf-to-png',
    label: 'PNG',
    ext: 'png',
    description: 'Convierte cada página del PDF a una imagen PNG nítida (descarga un ZIP).',
    from: ['pdf'],
    requiresCanvas: true,
    run: (input, onProgress) => pdfToImages(input, onProgress, 'png'),
  },
  {
    id: 'pdf-to-webp',
    label: 'WebP',
    ext: 'webp',
    description: 'Convierte cada página del PDF a WebP, ligero para la web (descarga un ZIP).',
    from: ['pdf'],
    requiresCanvas: true,
    run: (input, onProgress) => pdfToImages(input, onProgress, 'webp'),
  },
  {
    id: 'docx-to-txt',
    label: 'TXT',
    ext: 'txt',
    description: 'Extrae el texto del documento Word a texto plano.',
    from: ['docx'],
    run: docxToTxt,
  },
  {
    id: 'docx-to-html',
    label: 'HTML',
    ext: 'html',
    description: 'Convierte el documento Word a una página HTML con su contenido.',
    from: ['docx'],
    run: docxToHtml,
  },
  {
    id: 'docx-to-pdf',
    label: 'PDF',
    ext: 'pdf',
    description: 'Convierte el texto del documento Word a un PDF A4.',
    from: ['docx'],
    run: docxToPdf,
  },
]