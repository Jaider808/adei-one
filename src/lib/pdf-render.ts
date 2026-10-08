import { useEffect, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// Worker de pdf.js (Vite lo resuelve como asset URL; carga diferida).
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

export type PdfPagesStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface PdfPagesResult {
  /** Páginas visibles (topado a maxPages, 0 = ninguna). */
  pageCount: number | null
  /** Total de páginas del PDF (sin topar). */
  totalPages: number | null
  /** Miniaturas (dataURL JPEG) por página; null mientras no esté lista. */
  thumbs: (string | null)[]
  status: PdfPagesStatus
}

const THUMB_SCALE = 0.5

/**
 * Lee un PDF (pdf.js) y expone el nº de páginas + miniaturas.
 * - El nº de páginas llega rápido (parseo ligero) y siempre se muestran tiles
 *   numeradas interactivas aunque las miniaturas falle.
 * - Las miniaturas se renderizan page-by-page (best-effort): si canvas falla
 *   (sin ctx) o el render falla, la tile queda numerada.
 * - PDFs con más de `maxPages` páginas se topan (la nota se deriva de totalPages).
 */
export function usePdfPages(file: File | undefined, maxPages = 60): PdfPagesResult {
  const [pageCount, setPageCount] = useState<number | null>(null)
  const [totalPages, setTotalPages] = useState<number | null>(null)
  const [thumbs, setThumbs] = useState<(string | null)[]>([])
  const [status, setStatus] = useState<PdfPagesStatus>('idle')

  useEffect(() => {
    let cancelled = false

    setStatus('idle')
    setPageCount(null)
    setTotalPages(null)
    setThumbs([])

    if (!file) return

    let doc: pdfjsLib.PDFDocumentProxy | null = null

    void (async () => {
      setStatus('loading')
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        doc = await pdfjsLib.getDocument({
          data,
          useWorkerFetch: false,
          disableStream: true,
          disableAutoFetch: true,
        }).promise
        if (cancelled) return

        const shown = Math.max(0, Math.min(doc.numPages, maxPages))
        setTotalPages(doc.numPages)
        setPageCount(shown)
        const nextThumbs: (string | null)[] = Array.from({ length: shown }, () => null)
        setThumbs(nextThumbs)
        setStatus('ready')

        // Miniaturas best-effort, página a página.
        for (let i = 1; i <= shown && !cancelled; i++) {
          try {
            const page = await doc.getPage(i)
            const viewport = page.getViewport({ scale: THUMB_SCALE })
            const canvas = document.createElement('canvas')
            canvas.width = Math.max(1, Math.floor(viewport.width))
            canvas.height = Math.max(1, Math.floor(viewport.height))
            // API pdf.js v6: render({ canvas, viewport }) sobre el propio canvas.
            await page.render({ canvas, viewport }).promise
            let url: string | null = null
            try {
              url = canvas.toDataURL('image/jpeg', 0.82)
            } catch {
              url = null
            }
            if (!cancelled) {
              nextThumbs[i - 1] = url
              setThumbs([...nextThumbs])
            }
          } catch {
            // tile numerada: sin thumbnail
          }
        }
      } catch {
        if (!cancelled) setStatus('error')
      } finally {
        if (!cancelled && doc) {
          // pdf.js v6: el proxy no tiene destroy(); se libera vía loadingTask.
          try {
            await doc.loadingTask.destroy()
          } catch {
            /* ya destruido */
          }
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [file, maxPages])

  return { pageCount, totalPages, thumbs, status }
}