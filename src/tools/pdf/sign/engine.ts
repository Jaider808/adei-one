/**
 * ADEI-ONE — Motor de "Firmar PDF" (`pdf.sign`).
 * Añade un sello de texto centrado en las páginas elegidas (todas o la primera)
 * con pdf-lib (fuente base Helvetica). La posición es vertical (arriba/centro/
 * abajo); se centra horizontalmente según el ancho real del texto.
 */
import { StandardFonts, rgb } from 'pdf-lib'
import { baseName, buildStep, loadSource, pdfResult } from '@/tools/common/pdf-helpers'
import type { EngineInput, ProcessResult, ProgressEvent } from '@/core/types'

/** Config del wizard (schema en tool.ts). */
interface SignConfig {
  text?: string
  pages?: 'todas' | 'primera'
  position?: 'arriba' | 'centro' | 'abajo'
}

const FONT_SIZE = 20
const PAD = 60

/** Firma un PDF añadiendo el sello de texto en las páginas indicadas. */
export async function signPdf(
  input: EngineInput,
  onProgress?: (e: ProgressEvent) => void,
): Promise<ProcessResult> {
  if (!input.bytes || input.bytes.length === 0) throw new Error('Se necesita un archivo')

  const config = input.config as SignConfig
  const text = config.text?.trim() || 'Firmado'
  const position = config.position ?? 'abajo'
  const pages: 'todas' | 'primera' = config.pages ?? 'todas'

  const base = baseName(input.name)
  const reading = buildStep(onProgress, 'Leyendo PDF')
  const processing = buildStep(onProgress, 'Añadiendo firma')
  const generating = buildStep(onProgress, 'Generando archivo')
  const done = buildStep(onProgress, 'Listo')

  reading(10)
  const doc = await loadSource(input.bytes)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontColor = rgb(0.16, 0.2, 0.28)
  const total = doc.getPageCount()

  const targets = pages === 'primera' ? [0] : Array.from({ length: total }, (_, i) => i)

  for (const index of targets) {
    processing(Math.round(30 + (index / Math.max(targets.length, 1)) * 60))
    const page = doc.getPage(index)
    const width = page.getWidth()
    const height = page.getHeight()
    const textWidth = font.widthOfTextAtSize(text, FONT_SIZE)

    const x = Math.max((width - textWidth) / 2, 0)
    const y =
      position === 'arriba'
        ? height - PAD
        : position === 'centro'
          ? height / 2 - FONT_SIZE / 3
          : PAD

    page.drawText(text, {
      x,
      y,
      size: FONT_SIZE,
      font,
      color: fontColor,
      opacity: 0.9,
    })
  }

  generating(95)
  const bytes = await doc.save()
  done(100)
  return pdfResult(`${base}-firmado.pdf`, bytes)
}