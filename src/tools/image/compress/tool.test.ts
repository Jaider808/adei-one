/**
 * ADEI-ONE — Tests de "Comprimir imagen" (`image.compress`).
 * En Node NO hay canvas, así que probamos las guardas del engine: bytes vacíos
 * primero (error estable) y rechazo fuera del navegador con bytes reales.
 */
import { describe, expect, it } from 'vitest'
import { requireBytes } from '@/tools/image/shared'
import { compressImage } from './engine'
import type { EngineInput, FileKind } from '@/core/types'

/** Construye un `EngineInput` a partir de bytes puros (config vacío). */
function eng(bytes: Uint8Array, name = 'foto.jpg', kind: FileKind = 'jpg'): EngineInput {
  return { bytes, name, kind, config: {} }
}

describe('requireBytes', () => {
  it('rechaza bytes vacíos con el mensaje estable', () => {
    expect(() => requireBytes(new Uint8Array())).toThrow('Se necesita un archivo')
  })
})

describe('compressImage (guardas)', () => {
  it('bytes vacíos: lanza "Se necesita un archivo" ANTES del guard de navegador', async () => {
    await expect(compressImage(eng(new Uint8Array()))).rejects.toThrow('Se necesita un archivo')
  })

  it('con bytes reales fuera del navegador: rechaza con mensaje de navegador', async () => {
    const fixture = new Uint8Array([0, 1, 2])
    await expect(compressImage(eng(fixture))).rejects.toThrow(/navegador/i)
  })
})