/**
 * ADEI-ONE — Tests del dominio RTF de "Eliminar metadata" (`rtf.ts`).
 *
 * Fixtures RTF realistas. Cirugía pura sobre texto → se prueban en Node sin DOM.
 * Incluye integración con el engine (`./engine`) y comprobación de que las llaves
 * quedan balanceadas y el contenido sobrevive intacto (el escáner respeta los
 * escapes `\{`, `\}`, `\\` y `\'hh`).
 */
import { describe, expect, it } from 'vitest'
import { rtfDomain } from './rtf'
import { scanMetadata, stripMetadata } from './engine'

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

const noop = (): void => {}

/* ── Fixtures ── */

/** RTF típico: cabecera, generador, grupo `info` y cuerpo con contenido. */
const DOCUMENT = String.raw`{\rtf1\ansi\ansicpg1252\deff0
{\fonttbl{\f0\fnil Calibri;}}
{\*\generator Microsoft Word 16.0}
{\info
{\title Informe confidencial}
{\author Ana García}
{\company Acme S.L.}
{\creatim\yr2020\mo1\dy2\hr3\min4}
{\id 12345}
}
\viewkind4\uc1\pard\f0\fs22 Hola mundo.\par
}
`

/**
 * RTF con escapes: el `\}` del `\author` es una llave LITERAL (un escáner
 * ingenuo creería que ahí cierra el `\info`), y el cuerpo usa `\{`, `\}` y
 * escapes hexadecimales `\'7b`/`\'7d`.
 */
const ESCAPED = String.raw`{\rtf1\ansi\deff0
{\info{\author Ana \}}{\company Acme}}
\viewkind4\uc1\pard Texto con \'7b llave, \'7d cierre y \{literal\}. \par
}
`

/** RTF sin `\info` ni generador (solo contenido). */
const CLEAN = String.raw`{\rtf1\ansi\deff0
\viewkind4\uc1\pard Solo contenido, sin metadatos.\par
}
`

/** RTF mal formado: grupo sin cerrar. */
const MALFORMED = String.raw`{\rtf1\ansi sin cerrar {grupo`

const DOCUMENT_BYTES = utf8(DOCUMENT)
const ESCAPED_BYTES = utf8(ESCAPED)
const CLEAN_BYTES = utf8(CLEAN)
const MALFORMED_BYTES = utf8(MALFORMED)

/* ── Balanceo de llaves consciente de escapes (verificación del resultado) ── */

function isBalanced(text: string): boolean {
  let depth = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '\\') {
      i++
      const c = text[i]
      if (c === undefined) return false
      if (/[a-zA-Z]/.test(c)) {
        while (i < text.length && /[a-zA-Z]/.test(text[i])) i++
        if (text[i] === '-') i++
        while (i < text.length && /[0-9]/.test(text[i])) i++
        if (text[i] === ' ') i++
      } else if (c === "'") {
        i += 3
      } else {
        i++
      }
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth < 0) return false
    }
    i++
  }
  return depth === 0
}

/* ── Dominio ── */

describe('rtfDomain — contrato', () => {
  it('declara el kind rtf', () => {
    expect(rtfDomain.kinds).toEqual(['rtf'])
  })
})

/* ── Escaneo ── */

describe('rtfDomain — escaneo (inventario)', () => {
  it('enumera los campos de info, el generador y el formato con rutas reales', async () => {
    const report = await rtfDomain.scan(DOCUMENT_BYTES)
    const wheres = report.entries.map((entry) => entry.where)
    expect(wheres).toEqual(
      expect.arrayContaining([
        String.raw`info > \author`,
        String.raw`info > \company`,
        String.raw`info > \creatim`,
        String.raw`info > \id`,
        String.raw`destino \*\generator`,
      ]),
    )
    const ids = report.blocks.map((block) => block.id)
    expect(ids).toEqual(expect.arrayContaining(['info', 'generator', 'format']))
  })

  it('marca el identificador de documento (\\id) como alta sensibilidad', async () => {
    const report = await rtfDomain.scan(DOCUMENT_BYTES)
    const id = report.entries.find((entry) => entry.where === String.raw`info > \id`)
    expect(id?.sensitivity).toBe('high')
    expect(id?.value).toBe('12345')
  })

  it('da formato legible a las fechas del \\info', async () => {
    const report = await rtfDomain.scan(DOCUMENT_BYTES)
    const date = report.entries.find((entry) => entry.where === String.raw`info > \creatim`)
    expect(date?.value).toBe('2020-01-02 03:04')
  })

  it('el removal del inventario es honesto: info/generator borrables, format nunca', async () => {
    const report = await rtfDomain.scan(DOCUMENT_BYTES)
    expect(report.entries.find((entry) => entry.where === String.raw`info > \author`)?.removal).toBe('with-container')
    expect(report.entries.find((entry) => entry.where === 'cabecera')?.removal).toBe('never')
  })

  it('engine.scanMetadata(rtf) ya no devuelve el report vacío', async () => {
    const report = await scanMetadata({ bytes: DOCUMENT_BYTES, kind: 'rtf' })
    expect(report.entries.length).toBeGreaterThan(0)
    expect(report.entries.some((entry) => entry.where === String.raw`info > \author`)).toBe(true)
  })
})

/* ── Limpieza ── */

describe('rtfDomain — limpieza quirúrgica', () => {
  it('light con info elimina el grupo completo y conserva cabecera y contenido', async () => {
    const out = await rtfDomain.strip(DOCUMENT_BYTES, 'rtf', { mode: 'light', blocks: ['info'] }, noop)
    const text = textOf(out)
    expect(text).not.toContain(String.raw`{\info`)
    expect(text).not.toContain('Ana García')
    expect(text).not.toContain('Acme S.L.')
    expect(text).not.toContain('12345')
    expect(text.startsWith(String.raw`{\rtf1\ansi\ansicpg1252\deff0`)).toBe(true)
    expect(text).toContain(String.raw`\viewkind4\uc1\pard\f0\fs22 Hola mundo.\par`)
    // El generador no se pidió: sigue intacto (light solo quita lo solicitado).
    expect(text).toContain(String.raw`{\*\generator Microsoft Word 16.0}`)
    expect(isBalanced(text)).toBe(true)
  })

  it('light con generator elimina el grupo generador y conserva info', async () => {
    const out = await rtfDomain.strip(DOCUMENT_BYTES, 'rtf', { mode: 'light', blocks: ['generator'] }, noop)
    const text = textOf(out)
    expect(text).not.toContain('generator')
    expect(text).toContain(String.raw`{\info`)
    expect(text).toContain('Ana García')
    expect(text).toContain('Hola mundo.')
    expect(isBalanced(text)).toBe(true)
  })

  it('deep elimina info y generator de una vez', async () => {
    const out = await rtfDomain.strip(DOCUMENT_BYTES, 'rtf', { mode: 'deep', blocks: [] }, noop)
    const text = textOf(out)
    expect(text).not.toContain(String.raw`{\info`)
    expect(text).not.toContain('generator')
    expect(text).toContain('Hola mundo.')
    expect(isBalanced(text)).toBe(true)
  })

  it('no confunde llaves escapadas con delimitadores (el cuerpo sobrevive intacto)', async () => {
    const out = await rtfDomain.strip(ESCAPED_BYTES, 'rtf', { mode: 'light', blocks: ['info'] }, noop)
    const text = textOf(out)
    // El `\}` del autor era literal: el grupo info se corta donde toca.
    expect(text).not.toContain(String.raw`{\info`)
    expect(text).not.toContain('Ana')
    expect(text).not.toContain('Acme')
    // El cuerpo con `\{`, `\}`, `\'7b` y `\'7d` queda byte a byte.
    expect(text).toContain(String.raw`Texto con \'7b llave, \'7d cierre y \{literal\}.`)
    expect(text.startsWith(String.raw`{\rtf1\ansi\deff0`)).toBe(true)
    expect(isBalanced(text)).toBe(true)
  })

  it('un RTF sin info ni generador no cambia (byte a byte) incluso en deep', async () => {
    const out = await rtfDomain.strip(CLEAN_BYTES, 'rtf', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, CLEAN_BYTES)).toBe(true)
  })

  it('un RTF inválido se devuelve intacto y no lanza', async () => {
    const out = await rtfDomain.strip(MALFORMED_BYTES, 'rtf', { mode: 'deep', blocks: [] }, noop)
    expect(sameBytes(out, MALFORMED_BYTES)).toBe(true)
    const report = await rtfDomain.scan(MALFORMED_BYTES)
    expect(report.entries).toEqual([])
  })

  it('light sin bloques es passthrough byte a byte', async () => {
    const out = await rtfDomain.strip(DOCUMENT_BYTES, 'rtf', { mode: 'light', blocks: [] }, noop)
    expect(sameBytes(out, DOCUMENT_BYTES)).toBe(true)
  })
})

/* ── Integración con el engine ── */

describe('rtfDomain — integración con el engine', () => {
  it('engine.stripMetadata limpia un RTF y conserva el contenido', async () => {
    const result = await stripMetadata({
      bytes: DOCUMENT_BYTES,
      name: 'informe.rtf',
      kind: 'rtf',
      config: { mode: 'light', blocks: ['info', 'generator'] },
    })
    expect(result.kind).toBe('rtf')
    expect(result.name).toBe('informe-limpio.rtf')
    const out = textOf(new Uint8Array(await result.blob.arrayBuffer()))
    expect(out).not.toContain(String.raw`{\info`)
    expect(out).not.toContain('Ana García')
    expect(out).toContain('Hola mundo.')
    expect(isBalanced(out)).toBe(true)
    expect(result.verification?.status).toBe('clean')
  })
})
