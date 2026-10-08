/**
 * ADEI-ONE — Tests de los runners devtools (utilidades de texto/desarrollador).
 * Se ejecutan en Node (sin canvas): invocan directamente `.run` de cada RunnerDef,
 * sin pasar por el engine (el dominio nuevo aún no se registra en index.ts).
 */
import { describe, expect, it } from 'vitest'
import { strToU8 } from 'fflate'
import { devRunners } from './devtools'
import type { RunnerDef, RunFn } from '../runner-types'
import type { EngineInput, FileKind } from '@/core/types'

/** Construye una entrada mínima para un runner (bytes UTF-8 + kind). */
function textInput(text: string, kind: FileKind = 'txt'): EngineInput {
  return { bytes: strToU8(text), name: `archivo.${kind}`, kind, config: {} }
}

/** Busca un runner por id y falla rápido si no existe (fixture roto). */
function runnerDef(id: string): RunnerDef {
  const def = devRunners.find((r) => r.id === id)
  if (!def) throw new Error(`Runner devtools no encontrado: ${id}`)
  return def
}

/** Ejecuta un runner de texto y devuelve el contenido del resultado. */
async function runText(id: string, text: string, kind: FileKind = 'txt'): Promise<string> {
  const run: RunFn = runnerDef(id).run
  const result = await run(textInput(text, kind))
  return result.blob.text()
}

describe('devtools — metadata', () => {
  it('los ids son únicos y ninguno requiere canvas', () => {
    const ids = devRunners.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(devRunners.every((r) => !r.requiresCanvas)).toBe(true)
  })

  it('están presentes los ids clave del dominio', () => {
    const ids = new Set(devRunners.map((r) => r.id))
    for (const id of [
      'case-snake',
      'color-convert',
      'url-encode',
      'html-escape',
      'xml-escape',
      'number-base',
      'dec-to-roman',
      'timestamp-to-date',
      'sha1',
      'sha512',
      'uuid-v4',
      'rot13',
      'text-stats',
      'json-to-ts',
      'html-to-md',
    ]) {
      expect(ids.has(id)).toBe(true)
    }
  })
})

describe('devtools — cases', () => {
  it('case-snake separa palabras con guion bajo', async () => {
    expect(await runText('case-snake', 'Hola Mundo')).toBe('hola_mundo')
  })

  it('case-camel une palabras con minúscula inicial', async () => {
    expect(await runText('case-camel', 'Hola mundo')).toBe('holaMundo')
  })

  it('case-kebab separa palabras con guiones', async () => {
    expect(await runText('case-kebab', 'Hola mundo')).toBe('hola-mundo')
  })

  it('case-slug recorta el texto antes de convertir', async () => {
    expect(await runText('case-slug', '  Hola mundo  ')).toBe('hola-mundo')
  })

  it('los cases también aceptan origen md', async () => {
    const def = runnerDef('case-camel')
    expect(def.from).toContain('md')
  })
})

describe('devtools — color', () => {
  it('hex #RRGGBB muestra RGB y HSL además del hex', async () => {
    const out = await runText('color-convert', '#336699')
    expect(out).toContain('rgb(')
    expect(out).toContain('hsl(')
    expect(out).toContain('#336699')
  })

  it('acepta rgb() y hsl() como entrada', async () => {
    expect(await runText('color-convert', 'rgb(255, 0, 0)')).toContain('#ff0000')
    expect(await runText('color-convert', 'hsl(0, 100%, 50%)')).toContain('#ff0000')
  })
})

describe('devtools — URL encode/decode', () => {
  it('roundtrip encode → decode devuelve el original', async () => {
    const original = 'hola mundo/año 2026'
    const encoded = await runText('url-encode', original)
    expect(encoded).toContain('%20')
    expect(await runText('url-decode', encoded)).toBe(original)
  })

  it('url-decode con escapes inválidos lanza un error estable', async () => {
    await expect(runText('url-decode', '%ZZ')).rejects.toThrow(/URL/)
  })
})

describe('devtools — escapes HTML y XML', () => {
  it('html-escape escapa & < > " y \' y html-unescape lo revierte', async () => {
    const original = '<a href="x">& "comillas"'
    const escaped = await runText('html-escape', original)
    expect(escaped).toContain('&lt;')
    expect(escaped).toContain('&amp;')
    expect(escaped).toContain('&quot;')
    expect(await runText('html-unescape', escaped, 'html')).toBe(original)
  })

  it('xml-escape usa entidades XML y xml-unescape lo revierte', async () => {
    const original = '<a attr="\'v\'">x</a>'
    const escaped = await runText('xml-escape', original, 'xml')
    expect(escaped).toContain('&lt;')
    expect(escaped).toContain('&apos;')
    expect(await runText('xml-unescape', escaped, 'xml')).toBe(original)
  })
})

describe('devtools — bases numéricas', () => {
  it('detecta decimal y muestra 0xff / 0b11111111', async () => {
    const out = await runText('number-base', '255')
    expect(out).toContain('0xff')
    expect(out).toContain('0b11111111')
  })

  it('detecta 0x… como hexadecimal', async () => {
    expect(await runText('number-base', '0x1f')).toContain('decimal: 31')
  })
})

describe('devtools — numerales romanos', () => {
  it('1999 → MCMXCIX y de vuelta → 1999', async () => {
    const roman = await runText('dec-to-roman', '1999')
    expect(roman).toBe('MCMXCIX')
    expect(await runText('roman-to-dec', roman)).toBe('1999')
  })
})

describe('devtools — fechas', () => {
  it('date-to-timestamp y timestamp-to-date hacen roundtrip (UTC)', async () => {
    const epochText = await runText('date-to-timestamp', '2026-09-29')
    const epoch = Number.parseInt(/Epoch \(ms\): (\d+)/.exec(epochText)?.[1] ?? '', 10)
    expect(epoch).toBe(new Date('2026-09-29').getTime())

    const human = await runText('timestamp-to-date', String(epoch))
    expect(human).toContain('2026-09-29')
  })
})

describe('devtools — hashes y UUID', () => {
  it('sha1 de "abc" es la huella conocida', async () => {
    expect((await runText('sha1', 'abc')).trim()).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
  })

  it('sha512 produce 128 dígitos hexadecimales', async () => {
    expect((await runText('sha512', 'abc')).trim()).toMatch(/^[0-9a-f]{128}$/)
  })

  it('uuid-v4 emite un UUID v4 (ignora el contenido)', async () => {
    const uuid = (await runText('uuid-v4', 'contenido ignorado')).trim()
    expect(uuid).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })
})

describe('devtools — ROT13 y estadísticas', () => {
  it('rot13 rota A-Z y es reversible', async () => {
    expect(await runText('rot13', 'HELLO')).toBe('URYYB')
    expect(await runText('rot13', 'URYYB')).toBe('HELLO')
  })

  it('text-stats cuenta caracteres, palabras y líneas', async () => {
    const out = await runText('text-stats', 'Hola mundo\nsegunda línea')
    expect(out).toContain('Caracteres: 24')
    expect(out).toContain('Palabras: 4')
    expect(out).toContain('Líneas: 2')
    expect(out).toContain('Tiempo de lectura')
  })
})

describe('devtools — JSON → TypeScript', () => {
  it('genera una interface con el campo tipado', async () => {
    const out = await runText('json-to-ts', '{"a":1}', 'json')
    expect(out).toContain('interface')
    expect(out).toContain('a: number')
  })

  it('mime de salida es TypeScript', () => {
    expect(runnerDef('json-to-ts').ext).toBe('ts')
  })
})

describe('devtools — HTML → Markdown', () => {
  it('convierte headings a Markdown ATX', async () => {
    const md = await runText('html-to-md', '<h1>Hola</h1>', 'html')
    expect(md).toContain('# Hola')
  })
})