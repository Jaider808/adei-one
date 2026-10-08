import { describe, expect, it } from 'vitest'
import {
  allPagesSelected,
  canSubmit,
  moveInOrder,
  presetPages,
  splitSubmitLabel,
} from '@/tools/common/pages-form.utils'

describe('presetPages', () => {
  it('pares devuelve las páginas pares (1-indexed)', () => {
    expect(presetPages('pares', 5)).toEqual([2, 4])
  })

  it('impares devuelve las páginas impares', () => {
    expect(presetPages('impares', 5)).toEqual([1, 3, 5])
  })

  it('todas devuelve todas las páginas en orden', () => {
    expect(presetPages('todas', 3)).toEqual([1, 2, 3])
  })

  it('total 0 devuelve lista vacía', () => {
    expect(presetPages('todas', 0)).toEqual([])
  })
})

describe('allPagesSelected', () => {
  it('todas marcadas en un documento completo → true', () => {
    expect(allPagesSelected([1, 2, 3], 3)).toBe(true)
  })

  it('solo parte de las páginas marcada → false', () => {
    expect(allPagesSelected([1, 2], 3)).toBe(false)
  })

  it('documento vacío sin nada marcado → true (caso límite)', () => {
    expect(allPagesSelected([], 0)).toBe(true)
  })

  it('documento con páginas y nada marcado → false', () => {
    expect(allPagesSelected([], 3)).toBe(false)
  })
})

describe('canSubmit', () => {
  it('split: exige al menos una página marcada', () => {
    expect(canSubmit('split', 0, 4)).toBe(false)
    expect(canSubmit('split', 2, 4)).toBe(true)
  })

  it('delete: no permite eliminar cero ni todas las páginas', () => {
    expect(canSubmit('delete', 0, 4)).toBe(false)
    expect(canSubmit('delete', 4, 4)).toBe(false)
    expect(canSubmit('delete', 3, 4)).toBe(true)
  })

  it('reorder: exige al menos una página marcada', () => {
    expect(canSubmit('reorder', 0, 4)).toBe(false)
    expect(canSubmit('reorder', 1, 4)).toBe(true)
  })
})

describe('splitSubmitLabel', () => {
  it('salida unida usa "Recortar" con singular/plural', () => {
    expect(splitSubmitLabel(3, 'unido')).toBe('Recortar 3 páginas')
    expect(splitSubmitLabel(1, 'unido')).toBe('Recortar 1 página')
  })

  it('salida separada anuncia el ZIP', () => {
    expect(splitSubmitLabel(2, 'separado')).toBe('Descargar 2 páginas (ZIP)')
  })
})

describe('moveInOrder (drag & drop de Reordenar)', () => {
  it('mueve un elemento de una posición a otra', () => {
    expect(moveInOrder([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4])
    expect(moveInOrder([1, 2, 3, 4], 3, 0)).toEqual([4, 1, 2, 3])
    expect(moveInOrder([3, 1, 2, 4], 1, 3)).toEqual([3, 2, 4, 1])
  })

  it('no muta el array original y tolera índices inválidos', () => {
    const order = [1, 2, 3]
    const next = moveInOrder(order, 0, 2)
    expect(order).toEqual([1, 2, 3]) // no mutado
    expect(next).toEqual([2, 3, 1])
    expect(moveInOrder(order, -1, 1)).toEqual(order)
    expect(moveInOrder(order, 0, 9)).toEqual(order)
  })
})