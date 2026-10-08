/**
 * ADEI-ONE — Tests de "Proteger PDF" (`pdf.protect`).
 *
 * add: cifra el PDF; SIN contraseña el load rechaza y CON ella abre con la
 * misma cantidad de páginas.
 * unlock: descifra un PDF previamente protegido; el resultado abre SIN
 * contraseña (pdf-lib oficial) y conserva las páginas.
 *
 * Nota: el engine usa `pdf-lib-with-encrypt` (fork con `encrypt()`; pdf-lib
 * 1.17 no cifra). En los tests, `EncryptedDocument` es ese fork y
 * `PdfLibDocument` el pdf-lib oficial, para validar de verdad el contrato.
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument as PdfLibDocument } from 'pdf-lib'
import { PDFDocument as EncryptedDocument } from 'pdf-lib-with-encrypt'
import { protectPdf } from './engine'
import type { EngineInput, FileKind } from '@/core/types'

/** Construye un `EngineInput` a partir de bytes puros. */
function eng(bytes: Uint8Array, name: string, kind: FileKind): EngineInput {
  return { bytes, name, kind, config: {} }
}

/** Bytes del blob de un resultado (para re-abrir el PDF). */
async function bytesOf(result: { blob: Blob }): Promise<Uint8Array> {
  return new Uint8Array(await result.blob.arrayBuffer())
}

/** PDF plano de `pages` páginas (pdf-lib oficial, sin contraseña). */
async function makePdfBytes(pages: number): Promise<Uint8Array> {
  const doc = await PdfLibDocument.create()
  for (let i = 0; i < pages; i++) doc.addPage()
  return doc.save()
}

describe('protectPdf · add', () => {
  it('cifra el PDF: sin contraseña rechaza y con ella abre con las mismas páginas', async () => {
    const input = eng(await makePdfBytes(3), 'doc.pdf', 'pdf')
    const result = await protectPdf({
      ...input,
      config: { status: 'add', password: 'secreta' },
    })
    expect(result.name).toBe('doc-protegido.pdf')

    const bytes = await bytesOf(result)
    // Sin contraseña: ni pdf-lib oficial ni el fork deben poder abrirlo.
    await expect(PdfLibDocument.load(bytes)).rejects.toThrow()
    await expect(EncryptedDocument.load(bytes)).rejects.toThrow()

    // Con la contraseña correcta abre y conserva las 3 páginas.
    const opened = await EncryptedDocument.load(bytes, { password: 'secreta' })
    expect(opened.getPageCount()).toBe(3)
  })

  it('bytes vacíos: guardia clara', async () => {
    await expect(protectPdf(eng(new Uint8Array(), 'doc.pdf', 'pdf'))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })
})

describe('protectPdf · unlock', () => {
  it('desbloquea: el resultado abre sin contraseña con las mismas páginas', async () => {
    const input = eng(await makePdfBytes(2), 'doc.pdf', 'pdf')
    const locked = await protectPdf({
      ...input,
      config: { status: 'add', password: 'x' },
    })

    const result = await protectPdf({
      ...eng(await bytesOf(locked), 'doc.pdf', 'pdf'),
      config: { status: 'unlock', password: 'x' },
    })
    expect(result.name).toBe('doc-desbloqueado.pdf')

    // pdf-lib oficial puede abrirlo SIN contraseña y mantiene las 2 páginas.
    const opened = await PdfLibDocument.load(await bytesOf(result))
    expect(opened.getPageCount()).toBe(2)
  })

  it('contraseña incorrecta en unlock: error claro', async () => {
    const input = eng(await makePdfBytes(1), 'doc.pdf', 'pdf')
    const locked = await protectPdf({
      ...input,
      config: { status: 'add', password: 'x' },
    })

    await expect(
      protectPdf({
        ...eng(await bytesOf(locked), 'doc.pdf', 'pdf'),
        config: { status: 'unlock', password: 'mal' },
      }),
    ).rejects.toThrow('Contraseña incorrecta')
  })
})