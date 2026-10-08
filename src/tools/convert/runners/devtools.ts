/**
 * ADEI-ONE — Runners de devtools del "Convertidor universal".
 * Dominio: utilidades de texto y desarrollador (cases, color, URL, escapes,
 * bases numéricas, numerales romanos, fechas, hashes, UUID, ROT13,
 * estadísticas, JSON→TS y HTML→Markdown). Todo 100% local, sin red.
 */
import {
  baseName,
  decodeUtf8,
  decodeXmlEntities,
  requireBytes,
  steps,
  textResult,
  toHex,
} from '../helpers'
import type { ProgressCb } from '../helpers'
import type { RunnerDef } from '../runner-types'
import type { EngineInput, FileKind, ProcessResult } from '@/core/types'

/* ------------------------------------------------------------------ */
/* Cases (text-case, importación perezosa)                             */
/* ------------------------------------------------------------------ */

/** Firma de las funciones de conversión de case (todas comparten forma). */
type CaseTransform = (text: string) => string

/** Conjunto de funciones que ofrece text-case (solo las que usamos). */
interface CaseBundle {
  camelCase: CaseTransform
  pascalCase: CaseTransform
  snakeCase: CaseTransform
  kebabCase: CaseTransform
  constantCase: CaseTransform
  titleCase: CaseTransform
  sentenceCase: CaseTransform
}

/** Importa text-case solo cuando se ejecuta un runner de cases. */
async function loadCaseBundle(): Promise<CaseBundle> {
  const {
    camelCase,
    pascalCase,
    snakeCase,
    kebabCase,
    constantCase,
    titleCase,
    sentenceCase,
  } = await import('text-case')
  return { camelCase, pascalCase, snakeCase, kebabCase, constantCase, titleCase, sentenceCase }
}

/** Fábrica de runners de "case": misma forma de ejecución, transformación distinta. */
function makeCaseRunner(
  id: string,
  label: string,
  description: string,
  apply: (text: string, fns: CaseBundle) => string,
): RunnerDef {
  return {
    id,
    label,
    ext: 'txt',
    description,
    from: ['txt', 'md'],
    run: async (input, onProgress) => {
      requireBytes(input.bytes)
      const [reading, converting, generating, done] = steps(onProgress)
      reading(10)
      const text = decodeUtf8(input.bytes)
      converting(55)
      const fns = await loadCaseBundle()
      const out = apply(text, fns)
      generating(90)
      done(100)
      return textResult(`${baseName(input.name)}.txt`, out, 'txt', 'text/plain')
    },
  }
}

/* ------------------------------------------------------------------ */
/* Color: conversión manual HEX/RGB/HSL (sin dependencias)             */
/* ------------------------------------------------------------------ */

/**
 * `#RRGGBB` o `#RGB` → [r, g, b] (0-255). Acepta con o sin `#` inicial.
 * Error estable si la cadena no parece un color hex.
 */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, '').toLowerCase()
  if (/^[0-9a-f]{6}$/.test(h)) {
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ]
  }
  if (/^[0-9a-f]{3}$/.test(h)) {
    // #RGB: cada dígito se expande (p. ej. #abc → #aabbcc)
    const expand = (ch: string): string => ch + ch
    return [parseInt(expand(h[0]), 16), parseInt(expand(h[1]), 16), parseInt(expand(h[2]), 16)]
  }
  throw new Error('No entiendo el color hex (esperaba #RRGGBB o #RGB)')
}

/** [r, g, b] (0-255) → '#rrggbb' en minúsculas. */
function rgbToHex(r: number, g: number, b: number): string {
  const ch = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${ch(r)}${ch(g)}${ch(b)}`
}

/** [r, g, b] (0-255) → [h (0-360), s (0-100), l (0-100)] redondeados. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const luminosity = (max + min) / 2
  const delta = max - min
  if (delta === 0) return [0, 0, Math.round(luminosity * 100)]
  const saturation = luminosity > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let hue = 0
  if (max === rn) hue = (gn - bn) / delta + (gn < bn ? 6 : 0)
  else if (max === gn) hue = (bn - rn) / delta + 2
  else hue = (rn - gn) / delta + 4
  hue *= 60
  return [Math.round(hue), Math.round(saturation * 100), Math.round(luminosity * 100)]
}

/** [h, s, l] (0-360, 0-100, 0-100) → [r, g, b] (0-255) redondeados. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const saturation = s / 100
  const luminosity = l / 100
  const chroma = (1 - Math.abs(2 * luminosity - 1)) * saturation
  const sector = h / 60
  const x = chroma * (1 - Math.abs((sector % 2) - 1))
  let work: [number, number, number] = [0, 0, 0]
  if (sector < 1) work = [chroma, x, 0]
  else if (sector < 2) work = [x, chroma, 0]
  else if (sector < 3) work = [0, chroma, x]
  else if (sector < 4) work = [0, x, chroma]
  else if (sector < 5) work = [x, 0, chroma]
  else work = [chroma, 0, x]
  const m = luminosity - chroma / 2
  return work.map((v) => Math.round((v + m) * 255)) as [number, number, number]
}

/** Resultado del parseo de color: siempre normalizado a RGB (0-255). */
interface ParsedColor {
  r: number
  g: number
  b: number
}

/** Clampa un canal RGB textual a 0-255 (defensa ante valores raros). */
function clampChannel(value: string): number {
  return Math.min(255, Math.max(0, parseInt(value, 10)))
}

/**
 * Reconoce `#RRGGBB` / `#RGB`, `rgb(r, g, b)` o `hsl(h, s%, l%)` y lo
 * normaliza a RGB. Lanza un error estable si no reconoce el formato.
 */
function parseColor(text: string): ParsedColor {
  const raw = text.trim()
  if (raw.startsWith('#')) {
    const [r, g, b] = hexToRgb(raw)
    return { r, g, b }
  }
  const rgbMatch = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/i.exec(raw)
  if (rgbMatch) {
    return {
      r: clampChannel(rgbMatch[1]!),
      g: clampChannel(rgbMatch[2]!),
      b: clampChannel(rgbMatch[3]!),
    }
  }
  const hslMatch =
    /^hsl\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)%\s*,\s*(\d+(?:\.\d+)?)%\s*\)$/i.exec(raw)
  if (hslMatch) {
    const [r, g, b] = hslToRgb(
      parseFloat(hslMatch[1]!),
      parseFloat(hslMatch[2]!),
      parseFloat(hslMatch[3]!),
    )
    return { r, g, b }
  }
  throw new Error('Formato de color no reconocido (usa #RRGGBB, rgb() o hsl())')
}

async function colorConvert(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const { r, g, b } = parseColor(decodeUtf8(input.bytes))
  converting(55)
  const hex = rgbToHex(r, g, b)
  const [h, s, l] = rgbToHsl(r, g, b)
  const lines = [
    `HEX: ${hex}`,
    `RGB: rgb(${r}, ${g}, ${b})`,
    `HSL: hsl(${h}, ${s}%, ${l}%)`,
    `css: ${hex}`,
  ]
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, lines.join('\n'), 'txt', 'text/plain')
}

/* ------------------------------------------------------------------ */
/* URL y escapes (HTML / XML)                                          */
/* ------------------------------------------------------------------ */

/** Escapa los caracteres de una URL para poder usarla en una query string. */
function encodeUrl(text: string): string {
  return encodeURIComponent(text)
}

/** Des-escapa una URL; error estable si lleva escapes %xx inválidos. */
function decodeUrl(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    throw new Error('No es una cadena URL válida')
  }
}

/** Fábrica de runners URL encode/decode (misma forma, sentido opuesto). */
function makeUrlRunner(
  id: string,
  label: string,
  description: string,
  encode: boolean,
): RunnerDef {
  return {
    id,
    label,
    ext: 'txt',
    description,
    from: ['txt'],
    run: async (input, onProgress) => {
      requireBytes(input.bytes)
      const [reading, converting, generating, done] = steps(onProgress)
      reading(10)
      const text = decodeUtf8(input.bytes)
      converting(55)
      const out = encode ? encodeUrl(text) : decodeUrl(text)
      generating(90)
      done(100)
      return textResult(`${baseName(input.name)}.txt`, out, 'txt', 'text/plain')
    },
  }
}

/** Escapa los 5 caracteres reservados del HTML (& < > " '). */
function escapeHtmlEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Escapa los 5 caracteres reservados del XML (& < > " '). */
function escapeXmlEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Fábrica de runners de escape/des-escape (el des-escape usa decodeXmlEntities). */
function makeEscapeRunner(
  id: string,
  label: string,
  description: string,
  from: FileKind[],
  transform: (text: string) => string,
): RunnerDef {
  return {
    id,
    label,
    ext: 'txt',
    description,
    from,
    run: async (input, onProgress) => {
      requireBytes(input.bytes)
      const [reading, converting, generating, done] = steps(onProgress)
      reading(10)
      const text = decodeUtf8(input.bytes)
      converting(55)
      const out = transform(text)
      generating(90)
      done(100)
      return textResult(`${baseName(input.name)}.txt`, out, 'txt', 'text/plain')
    },
  }
}

/* ------------------------------------------------------------------ */
/* Bases numéricas y numerales romanos                                 */
/* ------------------------------------------------------------------ */

/** Parsea decimal, `0x…` o `0b…` a un entero; error estable si no lo reconoce. */
function parseIntFromText(text: string): number {
  const raw = text.trim()
  if (/^0x[0-9a-f]+$/i.test(raw)) return parseInt(raw.slice(2), 16)
  if (/^0b[01]+$/i.test(raw)) return parseInt(raw.slice(2), 2)
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10)
  throw new Error('No pude identificar la base del número (usa decimal, 0x… o 0b…)')
}

/** Muestra un entero en decimal, hexadecimal y binario. */
function formatNumberBases(value: number): string {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  return [
    `decimal: ${value}`,
    `hex: ${sign}0x${abs.toString(16)}`,
    `binary: ${sign}0b${abs.toString(2)}`,
  ].join('\n')
}

async function numberBase(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const value = parseIntFromText(decodeUtf8(input.bytes))
  converting(55)
  const lines = formatNumberBases(value)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, lines, 'txt', 'text/plain')
}

/** Pares valor→símbolo para construir numerales romanos (orden descendente). */
const ROMAN_TABLE = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
] as const

/** Valor de cada símbolo romano básico (los sustractivos se resuelven abajo). */
const ROMAN_VALUES: Readonly<Record<string, number>> = {
  I: 1,
  V: 5,
  X: 10,
  L: 50,
  C: 100,
  D: 500,
  M: 1000,
}

/** Convierte un entero 1-3999 a su numeral romano (estilo estándar). */
function decimalToRoman(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 3999) {
    throw new Error('El número debe ser un entero entre 1 y 3999')
  }
  let rest = value
  let out = ''
  for (const [num, symbol] of ROMAN_TABLE) {
    while (rest >= num) {
      out += symbol
      rest -= num
    }
  }
  return out
}

/** Convierte un numeral romano a entero (regla sustractiva clásica). */
function romanToDecimal(roman: string): number {
  const raw = roman.trim().toUpperCase()
  if (!raw) throw new Error('El romano está vacío')
  let total = 0
  for (let i = 0; i < raw.length; i++) {
    const current = ROMAN_VALUES[raw[i]!]
    const next = ROMAN_VALUES[raw[i + 1] ?? ''] ?? 0
    if (current === undefined) throw new Error(`Carácter romano no válido: ${raw[i]}`)
    total += current < next ? -current : current
  }
  return total
}

async function decToRoman(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const value = parseIntFromText(decodeUtf8(input.bytes))
  converting(55)
  const roman = decimalToRoman(value)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, roman, 'txt', 'text/plain')
}

async function romanToDec(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const value = romanToDecimal(decodeUtf8(input.bytes))
  converting(55)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, String(value), 'txt', 'text/plain')
}

/* ------------------------------------------------------------------ */
/* Fechas: ISO / epoch ms ↔ texto humano                               */
/* ------------------------------------------------------------------ */

/** Rellena un número a 2 dígitos (p. ej. 7 → '07'). */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** Fecha → 'YYYY-MM-DD HH:mm:ss' en UTC (determinista en cualquier zona horaria). */
function formatUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(
    d.getUTCHours(),
  )}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
}

/** Interpreta una entrada de fecha: epoch en ms o texto ISO/humano. */
function parseDateInput(text: string): Date {
  const raw = text.trim()
  const numeric = /^-?\d+$/.exec(raw)
  const date = numeric ? new Date(parseInt(numeric[0], 10)) : new Date(raw)
  if (Number.isNaN(date.getTime())) {
    throw new Error('No pude interpretar la fecha (usa formato ISO o epoch en ms)')
  }
  return date
}

async function timestampToDate(
  input: EngineInput,
  onProgress?: ProgressCb,
): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const date = parseDateInput(decodeUtf8(input.bytes))
  converting(55)
  const lines = [
    `Fecha (UTC): ${formatUtc(date)}`,
    `ISO: ${date.toISOString()}`,
    `Epoch (ms): ${date.getTime()}`,
  ]
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, lines.join('\n'), 'txt', 'text/plain')
}

async function dateToTimestamp(
  input: EngineInput,
  onProgress?: ProgressCb,
): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const date = parseDateInput(decodeUtf8(input.bytes))
  converting(55)
  const lines = [`ISO: ${date.toISOString()}`, `Epoch (ms): ${date.getTime()}`]
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, lines.join('\n'), 'txt', 'text/plain')
}

/* ------------------------------------------------------------------ */
/* Hashes (Web Crypto) y UUID                                          */
/* ------------------------------------------------------------------ */

/** Algoritmos de hash que ofrece este dominio (Web Crypto). */
type HashAlgo = 'SHA-1' | 'SHA-384' | 'SHA-512'

/** Ids de runner por algoritmo (el algoritmo vive una vez aquí). */
const HASH_IDS: Readonly<Record<HashAlgo, string>> = {
  'SHA-1': 'sha1',
  'SHA-384': 'sha384',
  'SHA-512': 'sha512',
}

/** ArrayBuffer propio de los bytes (mismo cast que to-sha256 en utils.ts). */
function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** Fábrica de runners de hash: algoritmo y etiqueta distinguen el runner. */
function makeHashRunner(algo: HashAlgo, label: string, description: string): RunnerDef {
  return {
    id: HASH_IDS[algo],
    label,
    ext: 'txt',
    description,
    from: ['txt', 'md', 'json', 'csv', 'pdf'],
    run: async (input, onProgress) => {
      requireBytes(input.bytes)
      const [reading, converting, generating, done] = steps(onProgress)
      reading(10)
      converting(55)
      const digest = await crypto.subtle.digest(algo, bytesToArrayBuffer(input.bytes))
      generating(90)
      done(100)
      return textResult(`${baseName(input.name)}.txt`, toHex(digest), 'txt', 'text/plain')
    },
  }
}

async function uuidV4(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  converting(55)
  // El contenido de entrada se ignora: se genera un UUID v4 aleatorio nuevo.
  const uuid = crypto.randomUUID()
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, uuid, 'txt', 'text/plain')
}

/* ------------------------------------------------------------------ */
/* ROT13 y estadísticas de texto                                       */
/* ------------------------------------------------------------------ */

/** Rota las letras [A-Za-z] 13 posiciones (ROT13 es su propia inversa). */
function rot13(text: string): string {
  return text.replace(/[a-zA-Z]/g, (ch) => {
    const base = ch >= 'a' ? 97 : 65
    return String.fromCharCode(((ch.charCodeAt(0) - base + 13) % 26) + base)
  })
}

async function rot13Runner(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const text = decodeUtf8(input.bytes)
  converting(55)
  const out = rot13(text)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, out, 'txt', 'text/plain')
}

/** Palabras por minuto de lectura (referencia conservadora). */
const WORDS_PER_MINUTE = 200

/** Resumen honesto del texto: caracteres, palabras, líneas y lectura aprox. */
function summarizeText(text: string): string {
  const chars = text.length
  const trimmed = text.trim()
  const words = trimmed === '' ? 0 : trimmed.split(/\s+/).length
  const lines = text === '' ? 0 : text.split(/\r?\n/).length
  const minutes = words / WORDS_PER_MINUTE
  const reading = minutes < 1 ? '<1 min' : `~${Math.round(minutes)} min`
  return [
    `Caracteres: ${chars}`,
    `Palabras: ${words}`,
    `Líneas: ${lines}`,
    `Tiempo de lectura: ${reading}`,
  ].join('\n')
}

async function textStats(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const text = decodeUtf8(input.bytes)
  converting(55)
  const summary = summarizeText(text)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, summary, 'txt', 'text/plain')
}

/* ------------------------------------------------------------------ */
/* JSON → interfaces TypeScript                                        */
/* ------------------------------------------------------------------ */

/** Devuelve el tipo TS de un valor JSON (objetos inline, primitivos tipados). */
function jsonToTsType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return value.length === 0 ? 'unknown[]' : `${jsonToTsType(value[0])}[]`
  }
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'object': {
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.length === 0) return 'Record<string, unknown>'
      const inner = entries.map(([k, v]) => `${k}: ${jsonToTsType(v)}`).join('\n    ')
      return `{\n    ${inner}\n  }`
    }
    default:
      return 'unknown'
  }
}

/** Genera una interface/alias TypeScript simple a partir de un JSON (honesto). */
function jsonToTypescript(text: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('El texto no es JSON válido')
  }
  if (Array.isArray(parsed)) {
    return parsed.length === 0
      ? 'type Root = unknown[]'
      : `type Root = ${jsonToTsType(parsed[0])}[]`
  }
  if (parsed === null || typeof parsed !== 'object') {
    return `type Root = ${jsonToTsType(parsed)}`
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0) return 'interface Root {}\n\nexport default Root'
  const fields = entries.map(([k, v]) => `  ${k}: ${jsonToTsType(v)}`).join('\n')
  return `interface Root {\n${fields}\n}\n\nexport default Root`
}

async function jsonToTs(input: EngineInput, onProgress?: ProgressCb): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  converting(55)
  const code = jsonToTypescript(decodeUtf8(input.bytes))
  generating(90)
  done(100)
  // ext 'ts' con kind 'txt' y MIME de TypeScript (contrato de la spec).
  return textResult(`${baseName(input.name)}.ts`, code, 'txt', 'text/x-typescript')
}

/* ------------------------------------------------------------------ */
/* HTML → Markdown (Turndown, importación perezosa)                    */
/* ------------------------------------------------------------------ */

/** API mínima de TurndownService que usa el runner (el paquete no trae tipos). */
interface TurndownServiceLike {
  turndown(html: string): string
}

/** Constructor tipado: `new TurndownService(opciones?) → TurndownServiceLike`. */
type TurndownLike = new (options?: Record<string, unknown>) => TurndownServiceLike

async function htmlToMarkdown(
  input: EngineInput,
  onProgress?: ProgressCb,
): Promise<ProcessResult> {
  requireBytes(input.bytes)
  const [reading, converting, generating, done] = steps(onProgress)
  reading(10)
  const html = decodeUtf8(input.bytes)
  converting(55)
  // turndown es CJS sin declaración de tipos; se proyecta a la API mínima de arriba.
  // @ts-expect-error — módulo sin tipos (la API usada se tipa manualmente).
  const TurndownService = (await import('turndown')).default as unknown as TurndownLike
  const md = new TurndownService({ headingStyle: 'atx' }).turndown(html)
  generating(90)
  done(100)
  return textResult(`${baseName(input.name)}.txt`, md, 'txt', 'text/plain')
}

/* ------------------------------------------------------------------ */
/* Runners del dominio devtools                                        */
/* ------------------------------------------------------------------ */

/** Runners del dominio devtools (utilidades de texto y desarrollador). */
export const devRunners: RunnerDef[] = [
  // Cases (txt/md)
  makeCaseRunner('case-camel', 'Camel case', 'Convierte el texto a camelCase (palabras unidas, minúscula inicial).', (t, f) => f.camelCase(t)),
  makeCaseRunner('case-pascal', 'Pascal case', 'Convierte el texto a PascalCase (cada palabra con inicial mayúscula).', (t, f) => f.pascalCase(t)),
  makeCaseRunner('case-snake', 'Snake case', 'Convierte el texto a snake_case (minúsculas separadas por guion bajo).', (t, f) => f.snakeCase(t)),
  makeCaseRunner('case-kebab', 'Kebab case', 'Convierte el texto a kebab-case (minúsculas separadas por guiones).', (t, f) => f.kebabCase(t)),
  makeCaseRunner('case-constant', 'Constant case', 'Convierte el texto a CONSTANT_CASE (mayúsculas separadas por guion bajo).', (t, f) => f.constantCase(t)),
  makeCaseRunner('case-title', 'Title case', 'Convierte el texto a Title Case (inicial mayúscula en cada palabra).', (t, f) => f.titleCase(t)),
  makeCaseRunner('case-sentence', 'Sentence case', 'Convierte el texto a Sentence case (solo la primera palabra con mayúscula).', (t, f) => f.sentenceCase(t)),
  makeCaseRunner('case-slug', 'Slug', 'Convierte el texto a un slug de URL seguro (kebab-case, sin espacios).', (t, f) => f.kebabCase(t.trim())),

  // Color
  {
    id: 'color-convert',
    label: 'CSS color',
    ext: 'txt',
    description: 'Convierte un color (HEX, rgb() o hsl()) a sus formas HEX, RGB y HSL listas para CSS.',
    from: ['txt'],
    run: colorConvert,
  },

  // URL encode/decode
  makeUrlRunner('url-encode', 'URL encode', 'Codifica el texto como URL (escapes %xx) para usarlo en una query string.', true),
  makeUrlRunner('url-decode', 'URL decode', 'Decodifica una cadena URL con escapes %xx de vuelta a texto legible.', false),

  // Escapes HTML y XML (entrada y salida de texto)
  makeEscapeRunner('html-escape', 'HTML escape', 'Escapa & < > " y \' como entidades HTML (&amp;, &lt;, …).', ['txt', 'html'], escapeHtmlEntities),
  makeEscapeRunner('html-unescape', 'HTML unescape', 'Convierte las entidades HTML comunes (&amp;, &lt;, …) a sus caracteres.', ['txt', 'html'], decodeXmlEntities),
  makeEscapeRunner('xml-escape', 'XML escape', 'Escapa los caracteres reservados de XML (& < > " \' → &amp; &lt; &gt; &quot; &apos;).', ['txt', 'xml'], escapeXmlEntities),
  makeEscapeRunner('xml-unescape', 'XML unescape', 'Convierte las entidades XML (&amp;, &lt;, &gt;, &quot;, &apos;) a sus caracteres.', ['txt', 'xml'], decodeXmlEntities),

  // Bases numéricas
  {
    id: 'number-base',
    label: 'Conversor base',
    ext: 'txt',
    description: 'Detecta si el número es decimal, 0x… o 0b… y lo muestra en decimal, hexadecimal y binario.',
    from: ['txt'],
    run: numberBase,
  },

  // Numerales romanos
  {
    id: 'dec-to-roman',
    label: 'Romano',
    ext: 'txt',
    description: 'Convierte un número decimal entero (1-3999) a su numeral romano.',
    from: ['txt'],
    run: decToRoman,
  },
  {
    id: 'roman-to-dec',
    label: 'Decimal',
    ext: 'txt',
    description: 'Convierte un numeral romano a su valor decimal.',
    from: ['txt'],
    run: romanToDec,
  },

  // Fechas
  {
    id: 'timestamp-to-date',
    label: 'Fecha legible',
    ext: 'txt',
    description: 'Convierte una fecha ISO o un epoch Unix en ms a una fecha legible (UTC).',
    from: ['txt'],
    run: timestampToDate,
  },
  {
    id: 'date-to-timestamp',
    label: 'Unix ms',
    ext: 'txt',
    description: 'Convierte una fecha en texto a su epoch Unix en milisegundos.',
    from: ['txt'],
    run: dateToTimestamp,
  },

  // Hashes (Web Crypto)
  makeHashRunner('SHA-1', 'SHA-1', 'Calcula el hash SHA-1 del archivo (huella hexadecimal de 40 caracteres).'),
  makeHashRunner('SHA-384', 'SHA-384', 'Calcula el hash SHA-384 del archivo (huella hexadecimal de 96 caracteres).'),
  makeHashRunner('SHA-512', 'SHA-512', 'Calcula el hash SHA-512 del archivo (huella hexadecimal de 128 caracteres).'),

  // Identificador y cifrado básico
  {
    id: 'uuid-v4',
    label: 'UUID v4',
    ext: 'txt',
    description: 'Genera un identificador UUID v4 aleatorio (crypto.randomUUID). Ignora el contenido.',
    from: ['txt'],
    run: uuidV4,
  },
  {
    id: 'rot13',
    label: 'ROT13',
    ext: 'txt',
    description: 'Rota las letras A-Z 13 posiciones (cifrado ROT13, reversible).',
    from: ['txt'],
    run: rot13Runner,
  },

  // Estadísticas de texto
  {
    id: 'text-stats',
    label: 'Estadísticas',
    ext: 'txt',
    description: 'Cuenta caracteres, palabras y líneas, y estima el tiempo de lectura.',
    from: ['txt', 'md'],
    run: textStats,
  },

  // JSON → TypeScript
  {
    id: 'json-to-ts',
    label: 'TypeScript',
    ext: 'ts',
    description: 'Genera interfaces TypeScript simples a partir de un JSON.',
    from: ['json'],
    run: jsonToTs,
  },

  // HTML → Markdown
  {
    id: 'html-to-md',
    label: 'Markdown',
    ext: 'txt',
    description: 'Convierte HTML a Markdown con Turndown (headings, listas, enlaces).',
    from: ['txt', 'html'],
    run: htmlToMarkdown,
  },
]