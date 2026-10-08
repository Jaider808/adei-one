/**
 * ADEI-ONE — Tests de los runners de datos extra (`data-more`).
 *
 * Se ejecutan los runners directamente (sin el orquestador) para que este
 * archivo sea independiente del índice: mismo contrato `RunnerDef.run`.
 * Cobertura: JSON↔XML, CSV↔XML, YAML↔JSON, TOML↔JSON y tablas MD → CSV.
 */
import { describe, expect, it } from 'vitest'
import { dataMoreRunners } from './data-more'
import type { ActionConfig, EngineInput, FileKind } from '@/core/types'

/** Busca un runner por id; lanza si no existe. */
function runnerById(id: string) {
  const def = dataMoreRunners.find((r) => r.id === id)
  if (!def) throw new Error(`Runner no definido: ${id}`)
  return def
}

/** Construye un EngineInput desde texto (bytes UTF-8) para un runner dado. */
function input(text: string, kind: FileKind, id: string): EngineInput {
  const def = runnerById(id)
  return {
    bytes: new TextEncoder().encode(text),
    name: `archivo.${kind}`,
    kind,
    config: { to: def.id } as ActionConfig,
  }
}

/** Ejecuta un runner y devuelve el texto de su resultado (blob → string). */
async function runText(text: string, kind: FileKind, id: string): Promise<string> {
  const result = await runnerById(id).run(input(text, kind, id))
  return result.blob.text()
}

describe('dataMoreRunners (matriz de conversiones)', () => {
  it('ids únicos y `from`/`ext` exactos por conversión', () => {
    const ids = dataMoreRunners.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    const byId = (id: string): NonNullable<(typeof dataMoreRunners)[number]> | undefined =>
      dataMoreRunners.find((r) => r.id === id)
    expect(byId('json-to-xml')?.from).toEqual(['json'])
    expect(byId('json-to-xml')?.ext).toBe('xml')
    expect(byId('csv-to-xml')?.from).toEqual(['csv'])
    expect(byId('csv-to-xml')?.ext).toBe('xml')
    expect(byId('xml-to-csv')?.from).toEqual(['xml'])
    expect(byId('xml-to-csv')?.ext).toBe('csv')
    expect(byId('yaml-to-json')?.from).toEqual(['yaml'])
    expect(byId('yaml-to-json')?.ext).toBe('json')
    expect(byId('json-to-yaml')?.from).toEqual(['json'])
    expect(byId('json-to-yaml')?.ext).toBe('yaml')
    expect(byId('toml-to-json')?.from).toEqual(['toml'])
    expect(byId('toml-to-json')?.ext).toBe('json')
    expect(byId('json-to-toml')?.from).toEqual(['json'])
    expect(byId('json-to-toml')?.ext).toBe('toml')
    expect(byId('md-table-to-csv')?.from).toEqual(['md', 'txt'])
    expect(byId('md-table-to-csv')?.ext).toBe('csv')
  })
})

describe('json-to-xml', () => {
  it('serializa un objeto a elementos XML bajo la raíz <root>', async () => {
    const xml = await runText('{"a":1}', 'json', 'json-to-xml')
    expect(xml).toContain('<root>')
    expect(xml).toContain('<a>1</a>')
  })

  it('bytes vacíos → "Se necesita un archivo"', async () => {
    await expect(runnerById('json-to-xml').run(input('', 'json', 'json-to-xml'))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })
})

describe('csv-to-xml', () => {
  it('primera fila = claves; cada fila = un elemento <row> con <a>…', async () => {
    const xml = await runText('a,b\n1,x\n2,y', 'csv', 'csv-to-xml')
    expect(xml).toContain('<root>')
    expect(xml).toContain('<a>1</a>')
    expect(xml).toContain('<b>x</b>')
    expect(xml).toContain('<b>y</b>')
  })
})

describe('xml-to-csv', () => {
  it('la primera lista repetida se vuelve filas CSV con sus valores', async () => {
    const csv = await runText(
      '<r><row><a>1</a><b>x</b></row><row><a>2</a><b>y</b></row></r>',
      'xml',
      'xml-to-csv',
    )
    expect(csv).toContain('a,b')
    expect(csv).toContain('1,x')
    expect(csv).toContain('2,y')
  })
})

describe('yaml ↔ json', () => {
  it('yaml-to-json: a:1 y b:hola → JSON con a: 1 y b: "hola"', async () => {
    const json = await runText('a: 1\nb: hola', 'yaml', 'yaml-to-json')
    const parsed = JSON.parse(json) as { a: number; b: string }
    expect(parsed.a).toBe(1)
    expect(parsed.b).toBe('hola')
  })

  it('json-to-yaml: el JSON serializado contiene la clave "a:"', async () => {
    const yaml = await runText('{"a":1,"b":"hola"}', 'json', 'json-to-yaml')
    expect(yaml).toContain('a:')
  })
})

describe('toml ↔ json', () => {
  it('toml-to-json: "a = 1" → JSON con a: 1', async () => {
    const json = await runText('a = 1', 'toml', 'toml-to-json')
    const parsed = JSON.parse(json) as Record<string, unknown>
    expect(parsed.a).toBe(1)
  })

  it('json-to-toml: {"a":1} serializa a "a = 1"', async () => {
    const toml = await runText('{"a":1}', 'json', 'json-to-toml')
    expect(toml).toContain('a = 1')
  })

  it('bytes vacíos → "Se necesita un archivo"', async () => {
    await expect(runnerById('json-to-toml').run(input('', 'json', 'json-to-toml'))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })
})

describe('md-table-to-csv', () => {
  it('tabla 2x2 con fila separadora → CSV de 2 filas', async () => {
    const csv = await runText('| a | b |\n|---|---|\n| 1 | x |', 'md', 'md-table-to-csv')
    const lines = csv.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('a,b')
    expect(lines[1]).toBe('1,x')
  })
})