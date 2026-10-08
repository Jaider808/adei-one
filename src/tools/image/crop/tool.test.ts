/**
 * ADEI-ONE — Tests de "Recortar imagen" (`image.crop`).
 *
 * En Node no hay canvas: cubrimos lo testeable — `clampCrop` (matemática pura
 * de shared), `requireBytes` y el guard de navegador de `cropImage`. El guard
 * DEBE correr DESPUÉS de `requireBytes`: bytes vacíos → error de archivo;
 * bytes con contenido pero sin navegador → "requiere el navegador".
 */
import { describe, expect, it } from 'vitest'
import { clampCrop, requireBytes } from '@/tools/image/shared'
import { cropImage } from './engine'
import type { EngineInput, FileKind } from '@/core/types'

/** Construye un `EngineInput` a partir de bytes puros (config mínimo vacío). */
function eng(bytes: Uint8Array, name: string, kind: FileKind): EngineInput {
  return { bytes, name, kind, config: {} }
}

/** Bytes pseudo-aleatorios (deterministas) para el guard de navegador. */
function fakeBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 31 + 7) % 256)
}

describe('clampCrop (desde shared)', () => {
  it('recorte dentro de los límites: mantiene x/y y medidas', () => {
    expect(clampCrop(0, 0, 100, 50, 200, 100)).toEqual({ x: 0, y: 0, width: 100, height: 50 })
    expect(clampCrop(50, 25, 100, 50, 200, 100)).toEqual({ x: 50, y: 25, width: 100, height: 50 })
  })

  it('medidas mayores que la fuente: ajusta al tamaño completo', () => {
    expect(clampCrop(0, 0, 500, 300, 200, 100)).toEqual({ x: 0, y: 0, width: 200, height: 100 })
  })

  it('x/y negativos: se anclan a la esquina (0, 0)', () => {
    expect(clampCrop(-10, -20, 80, 40, 200, 100)).toEqual({ x: 0, y: 0, width: 80, height: 40 })
  })

  it('x/y que se salen por el borde derecho/inferior: recorre hasta caber', () => {
    expect(clampCrop(150, 80, 100, 40, 200, 100)).toEqual({ x: 100, y: 60, width: 100, height: 40 })
    expect(clampCrop(1000, 1000, 50, 50, 200, 100)).toEqual({ x: 150, y: 50, width: 50, height: 50 })
  })

  it('decimales: redondea posición y medidas', () => {
    expect(clampCrop(1.4, 2.6, 50.6, 30.4, 200, 100)).toEqual({ x: 1, y: 3, width: 51, height: 30 })
  })
})

describe('requireBytes', () => {
  it('bytes vacíos → error estable', () => {
    expect(() => requireBytes(new Uint8Array())).toThrow('Se necesita un archivo')
  })

  it('bytes con contenido → no lanza', () => {
    expect(() => requireBytes(new Uint8Array([1, 2, 3]))).not.toThrow()
  })
})

describe('cropImage (entorno Node, sin canvas)', () => {
  it('bytes vacíos → falla por requireBytes (antes que el guard)', async () => {
    await expect(cropImage(eng(new Uint8Array(), 'vacio.jpg', 'jpg'))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })

  it('bytes con contenido y sin navegador → requiere navegador', async () => {
    await expect(cropImage(eng(fakeBytes(64), 'foto.png', 'png'))).rejects.toThrow(/navegador/i)
  })
})