/**
 * ADEI-ONE — Tests de "Texto desde imagen" (`image.to-text`).
 * El OCR (tesseract.js) es solo navegador: en Node los tests comprueban los
 * guards (input vacío y rechazo claro de la rama browser-only) y la metadata
 * declarada en `tool.ts`. No se llega a instanciar el worker nunca.
 */
import { describe, expect, it } from 'vitest'
import { extractImageText } from './engine'
import { toTextTool } from './tool'
import type { EngineInput, FileKind } from '@/core/types'

/** Construye un `EngineInput` a partir de bytes puros (config vacío: sin opciones). */
function eng(bytes: Uint8Array, name: string, kind: FileKind): EngineInput {
  return { bytes, name, kind, config: {} }
}

describe('extractImageText (guards en Node)', () => {
  it('bytes vacíos → "Se necesita un archivo"', async () => {
    await expect(extractImageText(eng(new Uint8Array(), 'vacia.png', 'png'))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })

  it('bytes aleatorios → requiere navegador (tesseract no se toca en Node)', async () => {
    const random = Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
    await expect(extractImageText(eng(random, 'foto.png', 'png'))).rejects.toThrow(/navegador/i)
  })

  it('incluso 1 byte → requiere navegador', async () => {
    await expect(extractImageText(eng(new Uint8Array(1), 'foto.jpg', 'jpg'))).rejects.toThrow(
      /navegador/i,
    )
  })
})

describe('toTextTool (metadata)', () => {
  it('declara la Action de OCR con su targeting de imágenes', () => {
    expect(toTextTool.id).toBe('image.to-text')
    expect(toTextTool.name).toBe('Texto desde imagen')
    expect(toTextTool.category).toBe('image')
    expect(toTextTool.appliesTo).toEqual(['jpg', 'png', 'webp', 'gif', 'tiff', 'heic'])
    expect(toTextTool.keywords).toContain('ocr')
    expect(toTextTool.icon).toBeDefined()
  })
})