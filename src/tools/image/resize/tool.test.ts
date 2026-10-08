/**
 * ADEI-ONE — Tests de "Redimensionar" (`image.resize`).
 * En Node NO hay canvas, así que probamos la matemática pura de shared
 * (`computeResize`/`clampCrop`) y las guardas del engine: bytes vacíos primero
 * (error estable) y rechazo fuera del navegador con bytes reales.
 */
import { describe, expect, it } from 'vitest'
import { clampCrop, computeResize, requireBytes } from '@/tools/image/shared'
import { resizeImage } from './engine'
import type { EngineInput, FileKind } from '@/core/types'

/** Construye un `EngineInput` a partir de bytes puros (config vacío). */
function eng(bytes: Uint8Array, name = 'foto.jpg', kind: FileKind = 'jpg'): EngineInput {
  return { bytes, name, kind, config: {} }
}

describe('computeResize', () => {
  it('escala por porcentaje (percentage prioriza)', () => {
    expect(computeResize(1000, 500, { percentage: 50 })).toEqual({ width: 500, height: 250 })
  })

  it('mantiene el ratio al fijar solo width', () => {
    expect(computeResize(1000, 500, { width: 200 })).toEqual({ width: 200, height: 100 })
  })

  it('mantiene el ratio al fijar solo height', () => {
    expect(computeResize(1000, 500, { height: 300 })).toEqual({ width: 600, height: 300 })
  })
})

describe('clampCrop', () => {
  it('ajusta el recorte (x,y,w,h) al rango de la fuente', () => {
    expect(clampCrop(900, 900, 400, 400, 1000, 500)).toEqual({ x: 600, y: 100, width: 400, height: 400 })
  })
})

describe('requireBytes', () => {
  it('rechaza bytes vacíos con el mensaje estable', () => {
    expect(() => requireBytes(new Uint8Array())).toThrow('Se necesita un archivo')
  })
})

describe('resizeImage (guardas)', () => {
  it('bytes vacíos: lanza "Se necesita un archivo" ANTES del guard de navegador', async () => {
    await expect(resizeImage(eng(new Uint8Array()))).rejects.toThrow('Se necesita un archivo')
  })

  it('con bytes reales fuera del navegador: rechaza con mensaje de navegador', async () => {
    const fixture = new Uint8Array([0, 1, 2])
    await expect(resizeImage(eng(fixture))).rejects.toThrow(/navegador/i)
  })
})