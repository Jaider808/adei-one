import { describe, expect, it } from 'vitest'
import { extOf, formatBytes } from '@/lib/utils'

describe('formatBytes', () => {
  it('formatea bytes pequeños', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('formatea KB, MB y GB', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5_242_880)).toBe('5 MB')
    expect(formatBytes(2_147_483_648)).toBe('2 GB')
  })

  it('tolera entradas inválidas', () => {
    expect(formatBytes(NaN)).toBe('0 B')
    expect(formatBytes(-5, 1)).toBe('0 B')
  })
})

describe('extOf', () => {
  it('extrae la extensión en minúsculas', () => {
    expect(extOf('contrato.PDF')).toBe('pdf')
    expect(extOf('foto perfil.JePg')).toBe('jepg')
  })

  it('devuelve vacío sin extensión o con nombre de punto', () => {
    expect(extOf('README')).toBe('')
    expect(extOf('.gitignore')).toBe('')
    expect(extOf('sin.extension.'))?.toBe('')
  })
})