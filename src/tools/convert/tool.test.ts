/**
 * ADEI-ONE — Tests de "Convertir archivo" (`convert.any`).
 *
 * Todos los casos headless (sin canvas): clasificación `conversionsFor` +
 * runners que no requieren navegador (md, txt, csv, json, xml, docx, xlsx).
 * Los casos de canvas (imagen→imagen, pdf→imágenes) se validan solo vía
 * errores estables en Node.
 *
 * Nota: los fixtures ZIP se construyen con `zipSync` (fflate): `unzipSync`
 * solo DEScomprime; `zipSync({ ruta: bytes })` crea el ZIP de test.
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { strToU8, zipSync, unzipSync } from 'fflate'
import { convertAny, conversionsFor } from './engine'
import type { ActionConfig, EngineInput, FileKind } from '@/core/types'

/** Construye un EngineInput desde texto (bytes UTF-8) para un kind dado. */
function textInput(text: string, kind: FileKind, config: unknown = {}): EngineInput {
  return { bytes: strToU8(text), name: `archivo.${kind}`, kind, config: config as ActionConfig }
}

/** Lee el texto de un ProcessResult (blob → string). */
async function resultText(result: { blob: Blob }): Promise<string> {
  return result.blob.text()
}

/** Configuración `to:<id>` de forma tipada y cómoda. */
const to = (id: string): ActionConfig => ({ to: id }) as ActionConfig

describe('conversionsFor (clasificación síncrona)', () => {
  it('pdf ofrece texto, documentos e imágenes, con canvas solo en imágenes', () => {
    const ids = conversionsFor('pdf').map((o) => o.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'pdf-to-txt',
        'pdf-to-docx',
        'pdf-to-csv',
        'pdf-to-jpg',
        'pdf-to-png',
        'pdf-to-webp',
      ]),
    )
    for (const option of conversionsFor('pdf')) {
      const image = option.id === 'pdf-to-jpg' || option.id === 'pdf-to-png' || option.id === 'pdf-to-webp'
      expect(Boolean(option.requiresCanvas)).toBe(image)
    }
  })

  it('md ofrece txt y html', () => {
    const ids = conversionsFor('md').map((o) => o.id)
    expect(ids).toContain('md-to-txt')
    expect(ids).toContain('md-to-html')
  })

  it('jpg ofrece png y webp (además de jpg)', () => {
    const ids = conversionsFor('jpg').map((o) => o.id)
    expect(ids).toContain('to-png')
    expect(ids).toContain('to-webp')
    expect(ids).toContain('to-jpg')
  })

  it('tipos sin conversiones siguen vacíos; zip ahora ofrece manifest', () => {
    expect(conversionsFor('mp3')).toEqual([])
    expect(conversionsFor('zip').map((o) => o.id)).toContain('zip-to-manifest')
  })
})

describe('md → txt', () => {
  it('quita frontmatter y marcadores, conserva el texto', async () => {
    const result = await convertAny(
      textInput('---\ntitle: x\n---\n# Hola\n**mundo**', 'md', to('md-to-txt')),
    )
    expect(result.kind).toBe('txt')
    expect(result.name).toBe('archivo.txt')
    const text = await resultText(result)
    expect(text).toContain('Hola')
    expect(text).toContain('mundo')
    expect(text).not.toContain('#')
    expect(text).not.toContain('**')
  })
})

describe('md → html', () => {
  it('renderiza headings y negritas en un HTML mínimo', async () => {
    const result = await convertAny(
      textInput('---\ntitle: x\n---\n# Hola\n**mundo**', 'md', to('md-to-html')),
    )
    expect(result.name).toBe('archivo.html')
    const html = await resultText(result)
    expect(html).toContain('<h1')
    expect(html).toContain('mundo')
    expect(html).toContain('</html>')
  })
})

describe('txt → pdf', () => {
  it('genera un PDF A4 con al menos una página', async () => {
    const text = Array.from({ length: 60 }, (_, i) => `Línea ${i + 1}: contenido de prueba.`).join(
      '\n',
    )
    const result = await convertAny(textInput(text, 'txt', to('txt-to-pdf')))
    expect(result.kind).toBe('pdf')
    expect(result.blob.type).toBe('application/pdf')
    const doc = await PDFDocument.load(await result.blob.arrayBuffer())
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
  })
})

describe('csv → json', () => {
  it('primera fila = claves; filas = objetos (strings ok)', async () => {
    const result = await convertAny(
      textInput('nombre,edad\nAna,30\nLuis,25', 'csv', to('csv-to-json')),
    )
    expect(result.kind).toBe('json')
    const parsed = JSON.parse(await resultText(result)) as Array<{ nombre: string; edad: string }>
    expect(parsed).toEqual([
      { nombre: 'Ana', edad: '30' },
      { nombre: 'Luis', edad: '25' },
    ])
  })
})

describe('json → csv', () => {
  it('arreglo de objetos → cabecera con la unión de claves', async () => {
    const result = await convertAny(textInput('[{"a":1,"b":"x"}]', 'json', to('json-to-csv')))
    expect(result.kind).toBe('csv')
    const csv = await resultText(result)
    expect(csv).toContain('a,b')
  })
})

describe('xml → json', () => {
  it('parsea el XML y lo serializa como JSON anidado', async () => {
    const result = await convertAny(textInput('<a><b>1</b></a>', 'xml', to('xml-to-json')))
    expect(result.kind).toBe('json')
    const parsed = JSON.parse(await resultText(result)) as { a: { b: string } }
    expect(parsed.a.b).toBe('1')
  })
})

describe('docx → txt', () => {
  it('extrae el texto de word/document.xml', async () => {
    const zip = zipSync({
      'word/document.xml': strToU8(
        '<w:document><w:p><w:r><w:t>Hola</w:t></w:r></w:p></w:document>',
      ),
    })
    const input: EngineInput = {
      bytes: zip,
      name: 'documento.docx',
      kind: 'docx',
      config: to('docx-to-txt'),
    }
    const result = await convertAny(input)
    expect(await resultText(result)).toContain('Hola')
  })
})

describe('xlsx → csv', () => {
  it('resuelve sharedStrings (t="s") y números crudos por celda', async () => {
    const zip = zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Hola</t></si><si><t></t></si></sst>'),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>7</v></c></row></sheetData></worksheet>',
      ),
    })
    const input: EngineInput = {
      bytes: zip,
      name: 'tabla.xlsx',
      kind: 'xlsx',
      config: to('xlsx-to-csv'),
    }
    const result = await convertAny(input)
    expect(result.kind).toBe('csv')
    const csv = await resultText(result)
    expect(csv).toContain('Hola')
    expect(csv).toContain('7')
  })

  it('lanza error si el ZIP no trae hoja de cálculo', async () => {
    const zip = zipSync({ 'xl/sharedStrings.xml': strToU8('<sst></sst>') })
    const input: EngineInput = {
      bytes: zip,
      name: 'tabla.xlsx',
      kind: 'xlsx',
      config: to('xlsx-to-csv'),
    }
    await expect(convertAny(input)).rejects.toThrow('No se encontró la hoja de cálculo')
  })
})

describe('convertAny (validaciones)', () => {
  it('id de conversión desconocido → "Conversión no disponible"', async () => {
    await expect(
      convertAny(textInput('hola', 'txt', to('no-existe'))),
    ).rejects.toThrow(/no disponible/)
  })

  it('bytes vacíos → "Se necesita un archivo"', async () => {
    const input: EngineInput = {
      bytes: new Uint8Array(),
      name: 'vacio.md',
      kind: 'md',
      config: to('md-to-txt'),
    }
    await expect(convertAny(input)).rejects.toThrow('Se necesita un archivo')
  })

  it('conversión de imagen en Node → requiere navegador', async () => {
    const input: EngineInput = {
      bytes: strToU8('png-fake'),
      name: 'foto.png',
      kind: 'png',
      config: to('to-webp'),
    }
    await expect(convertAny(input)).rejects.toThrow(/navegador/i)
  })
})

/* ------------------------------------------------------------------ */
/* Nuevas conversiones node-testables                                  */
/* ------------------------------------------------------------------ */

describe('csv → xlsx', () => {
  it('genera un XLSX leíble por SheetJS con el mime de hoja de cálculo', async () => {
    const result = await convertAny(textInput('nombre,edad\nAna,30\nLuis,25', 'csv', to('csv-to-xlsx')))
    expect(result.kind).toBe('xlsx')
    expect(result.blob.type).toContain('spreadsheetml')
    const XLSX = await import('xlsx')
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    const wb = XLSX.read(bytes, { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]!]!)
    expect(rows).toEqual([
      { nombre: 'Ana', edad: 30 },
      { nombre: 'Luis', edad: 25 },
    ])
  })
})

describe('xlsx → json', () => {
  it('lee la primera hoja y la serializa como JSON con sus valores', async () => {
    const XLSX = await import('xlsx')
    const ws = XLSX.utils.json_to_sheet([{ nombre: 'Ana', edad: 30 }])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Datos')
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
    const input: EngineInput = {
      bytes: new Uint8Array(out as ArrayBuffer),
      name: 'tabla.xlsx',
      kind: 'xlsx',
      config: to('xlsx-to-json'),
    }
    const result = await convertAny(input)
    expect(result.kind).toBe('json')
    const parsed = JSON.parse(await resultText(result)) as Array<Record<string, unknown>>
    expect(parsed).toEqual([{ nombre: 'Ana', edad: 30 }])
  })

  it('una hoja sin filas de datos produce JSON vacío', async () => {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Vacia')
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
    const input: EngineInput = {
      bytes: new Uint8Array(out as ArrayBuffer),
      name: 'vacia.xlsx',
      kind: 'xlsx',
      config: to('xlsx-to-json'),
    }
    const result = await convertAny(input)
    expect(JSON.parse(await resultText(result))).toEqual([])
  })
})

describe('json → xlsx', () => {
  it('convierte un arreglo de objetos a hoja de cálculo', async () => {
    const result = await convertAny(
      textInput('[{"a":1,"b":"hola"}]', 'json', to('json-to-xlsx')),
    )
    expect(result.kind).toBe('xlsx')
    const XLSX = await import('xlsx')
    const bytes = new Uint8Array(await result.blob.arrayBuffer())
    const wb = XLSX.read(bytes, { type: 'array' })
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]!]!)
    expect(rows).toEqual([{ a: 1, b: 'hola' }])
  })

  it('JSON inválido → error estable', async () => {
    await expect(convertAny(textInput('{no-json', 'json', to('json-to-xlsx')))).rejects.toThrow(
      'no es JSON válido',
    )
  })
})

describe('docx → html', () => {
  it('convierte un docx mínimo a HTML con su contenido', async () => {
    const docx = zipSync({
      'word/document.xml': strToU8(
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Frase de prueba ADEI</w:t></w:r></w:p></w:body></w:document>',
      ),
      '_rels/.rels': strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    })
    const input: EngineInput = {
      bytes: docx,
      name: 'documento.docx',
      kind: 'docx',
      config: to('docx-to-html'),
    }
    const result = await convertAny(input)
    expect(result.name).toBe('documento.html')
    const html = await resultText(result)
    expect(html).toContain('Frase de prueba ADEI')
    expect(html).toContain('</html>')
  })
})

describe('md → pdf', () => {
  it('página el markdown limpio en un PDF A4', async () => {
    const result = await convertAny(
      textInput('---\ntitle: x\n---\n# Hola\n**mundo**', 'md', to('md-to-pdf')),
    )
    expect(result.kind).toBe('pdf')
    const doc = await PDFDocument.load(await result.blob.arrayBuffer())
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
  })
})

describe('html → pdf', () => {
  it('quita las etiquetas y genera un PDF con el texto', async () => {
    const result = await convertAny(
      textInput('<h1>Título</h1><p>Contenido <b>importante</b></p>', 'txt', to('html-to-pdf')),
    )
    expect(result.kind).toBe('pdf')
    const doc = await PDFDocument.load(await result.blob.arrayBuffer())
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1)
  })
})

describe('pdf → docx', () => {
  it('crea un DOCX cuyo zip incluye word/document.xml', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([320, 320])
    page.drawText('Texto para DOCX', { x: 24, y: 280, size: 14 })
    const pdfBytes = await pdf.save()
    const input: EngineInput = {
      bytes: new Uint8Array(pdfBytes),
      name: 'fuente.pdf',
      kind: 'pdf',
      config: to('pdf-to-docx'),
    }
    const result = await convertAny(input)
    expect(result.kind).toBe('docx')
    const entries = unzipSync(new Uint8Array(await result.blob.arrayBuffer()))
    expect(entries['word/document.xml']).toBeDefined()
  })
})

describe('pdf → csv', () => {
  it('extrae cada línea de texto como una fila CSV', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([320, 320])
    page.drawText('Primera línea', { x: 24, y: 280, size: 14 })
    const pdfBytes = await pdf.save()
    const input: EngineInput = {
      bytes: new Uint8Array(pdfBytes),
      name: 'fuente.pdf',
      kind: 'pdf',
      config: to('pdf-to-csv'),
    }
    const result = await convertAny(input)
    expect(result.kind).toBe('csv')
    expect(await resultText(result)).toContain('Primera línea')
  })
})

describe('imagen → pdf', () => {
  it('incrusta un PNG 1x1 en una sola página A4', async () => {
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const bytes = Uint8Array.from(atob(pngB64), (c) => c.charCodeAt(0))
    const input: EngineInput = {
      bytes,
      name: 'pixel.png',
      kind: 'png',
      config: to('img-to-pdf'),
    }
    const result = await convertAny(input)
    expect(result.kind).toBe('pdf')
    const doc = await PDFDocument.load(await result.blob.arrayBuffer())
    expect(doc.getPageCount()).toBe(1)
  })

  it('incrusta un JPG 1x1 en una sola página A4', async () => {
    const jpgB64 =
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q=='
    const bytes = Uint8Array.from(atob(jpgB64), (c) => c.charCodeAt(0))
    const input: EngineInput = {
      bytes,
      name: 'pixel.jpg',
      kind: 'jpg',
      config: to('img-to-pdf'),
    }
    const result = await convertAny(input)
    expect(result.kind).toBe('pdf')
    const doc = await PDFDocument.load(await result.blob.arrayBuffer())
    expect(doc.getPageCount()).toBe(1)
  })
})

describe('zip → manifest', () => {
  it('lista cada entrada del zip con su tamaño', async () => {
    const zip = zipSync({
      'leeme.txt': strToU8('hola'),
      'datos.json': strToU8('{}'),
    })
    const input: EngineInput = {
      bytes: zip,
      name: 'paquete.zip',
      kind: 'zip',
      config: to('zip-to-manifest'),
    }
    const result = await convertAny(input)
    expect(result.kind).toBe('txt')
    const text = await resultText(result)
    expect(text).toContain('leeme.txt')
    expect(text).toContain('datos.json')
  })
})

describe('txt ↔ base64', () => {
  it('codifica a base64 y permite decodificar al byte exacto', async () => {
    const encoded = await convertAny(textInput('Hola ADEI', 'txt', to('txt-to-base64')))
    expect(encoded.kind).toBe('txt')
    const b64 = await resultText(encoded)
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/)

    const decodedInput: EngineInput = {
      bytes: strToU8(b64),
      name: 'cifrado.txt',
      kind: 'txt',
      config: to('base64-to-txt'),
    }
    const decoded = await convertAny(decodedInput)
    expect(decoded.name).toBe('cifrado.bin')
    const bytes = new Uint8Array(await decoded.blob.arrayBuffer())
    expect(bytes).toEqual(strToU8('Hola ADEI'))
  })

  it('base64 inválido → error estable', async () => {
    const input: EngineInput = {
      bytes: strToU8('no-es-base64!'),
      name: 'malo.txt',
      kind: 'txt',
      config: to('base64-to-txt'),
    }
    await expect(convertAny(input)).rejects.toThrow(/Base64/)
  })
})

describe('to-sha256', () => {
  it('devuelve el hash hexadecimonimal conocido para "abc"', async () => {
    const result = await convertAny(textInput('abc', 'txt', to('to-sha256')))
    expect(result.kind).toBe('txt')
    const hex = (await resultText(result)).trim()
    expect(hex).toMatch(/^[0-9a-f]{64}$/)
    expect(hex).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('json pretty / minify', () => {
  it('json-pretty indenta con 2 espacios', async () => {
    const result = await convertAny(textInput('{"a":1,"b":[1,2]}', 'json', to('json-pretty')))
    const text = await resultText(result)
    expect(JSON.parse(text)).toEqual({ a: 1, b: [1, 2] })
    expect(text).toContain('\n  ')
  })

  it('json-minify compacta a una línea', async () => {
    const result = await convertAny(textInput('{\n  "a": 1,\n  "b": [1, 2]\n}', 'json', to('json-minify')))
    const text = await resultText(result)
    expect(JSON.parse(text)).toEqual({ a: 1, b: [1, 2] })
    expect(text).not.toContain('\n')
  })
})

describe('conversiones solo navegador (Node las rechaza)', () => {
  const pngBytes = Uint8Array.from(
    atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
    (c) => c.charCodeAt(0),
  )

  it('img-to-svg → requiere navegador', async () => {
    const input: EngineInput = { bytes: pngBytes, name: 'foto.png', kind: 'png', config: to('img-to-svg') }
    await expect(convertAny(input)).rejects.toThrow(/navegador/i)
  })

  it('heic-to-jpg / heic-to-png → requiere navegador', async () => {
    const fake = strToU8('heic-fake')
    for (const id of ['heic-to-jpg', 'heic-to-png'] as const) {
      const input: EngineInput = { bytes: fake, name: 'foto.heic', kind: 'heic', config: to(id) }
      await expect(convertAny(input)).rejects.toThrow(/navegador/i)
    }
  })

  it('tiff-to-png / tiff-to-jpg → requiere navegador', async () => {
    const fake = strToU8('tiff-fake')
    for (const id of ['tiff-to-png', 'tiff-to-jpg'] as const) {
      const input: EngineInput = { bytes: fake, name: 'foto.tiff', kind: 'tiff', config: to(id) }
      await expect(convertAny(input)).rejects.toThrow(/navegador/i)
    }
  })
})