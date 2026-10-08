/**
 * ADEI-ONE — Tests del helper ZIP compartido (`zipdoc.ts`).
 *
 * Verifica el requisito crítico de ODF/EPUB: `mimetype` debe quedar como la
 * PRIMERA entrada del ZIP y estar ALMACENADA (método 0). Se comprueba leyendo la
 * cabecera LOCAL del archivo resultante (firma `PK\x03\x04`).
 */
import { describe, expect, it } from 'vitest'
import { zipSync } from 'fflate'
import { firstLocalEntry, readZip, writeZip } from './zipdoc'

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/* ── Lectura ── */

describe('zipdoc — lectura', () => {
  it('lee las entradas de un ZIP en un mapa nombre → bytes', () => {
    const zip = zipSync({ 'a.txt': utf8('hola'), 'dir/b.txt': utf8('adios') })
    const entries = readZip(zip)
    expect(entries).not.toBeNull()
    expect(textOf(entries!['a.txt']!)).toBe('hola')
    expect(textOf(entries!['dir/b.txt']!)).toBe('adios')
  })

  it('un ZIP inválido devuelve null sin lanzar', () => {
    expect(readZip(utf8('esto no es un zip'))).toBeNull()
    expect(() => readZip(utf8('PK\x03\x04 basura'))).not.toThrow()
  })
})

/* ── Reconstrucción ── */

describe('zipdoc — reconstrucción', () => {
  it('coloca mimetype como primera entrada y almacenada (método 0)', () => {
    const zip = zipSync({
      'content.xml': utf8('<x/>'),
      mimetype: utf8('application/vnd.oasis.opendocument.text'),
    })
    const out = writeZip(readZip(zip)!)!
    const first = firstLocalEntry(out)
    expect(first).not.toBeNull()
    expect(first!.name).toBe('mimetype')
    expect(first!.method).toBe(0)
    const entries = readZip(out)!
    expect(textOf(entries['mimetype']!)).toBe('application/vnd.oasis.opendocument.text')
    expect(textOf(entries['content.xml']!)).toBe('<x/>')
  })

  it('conserva el orden original del resto de entradas', () => {
    const zip = zipSync({
      'primero.txt': utf8('1'),
      'segundo.txt': utf8('2'),
      'tercero.txt': utf8('3'),
    })
    const out = writeZip(readZip(zip)!)!
    expect(Object.keys(readZip(out)!)).toEqual(['primero.txt', 'segundo.txt', 'tercero.txt'])
  })

  it('no emite un paquete roto si una entrada numérica desplaza a mimetype', () => {
    // `fflate` visita primero las claves enteras (`for...in`): la entrada `123`
    // adelantaría a `mimetype`. La autocomprobación debe detectarlo y devolver null
    // para que el llamante haga passthrough byte a byte.
    const entries = {
      mimetype: utf8('application/epub+zip'),
      '123': utf8('contenido'),
      'a.txt': utf8('otro'),
    }
    expect(writeZip(entries)).toBeNull()
  })
})

/* ── Inspección de la cabecera local ── */

describe('zipdoc — inspección de cabecera local', () => {
  it('devuelve nombre y método del primer fichero', () => {
    const zip = zipSync({ mimetype: [utf8('text/plain'), { level: 0 }], 'a.txt': utf8('x') })
    expect(firstLocalEntry(zip)).toEqual({ name: 'mimetype', method: 0 })
  })

  it('devuelve null si no hay firma PK\\x03\\x04 o el tramo es corto', () => {
    expect(firstLocalEntry(utf8('nope'))).toBeNull()
    expect(firstLocalEntry(new Uint8Array(0))).toBeNull()
  })
})
