/**
 * ADEI-ONE — Historial local por caché (v1).
 *
 * Módulo PURO de historial: recuerda las últimas tools ejecutadas para no
 * repetir pasos, pero es DELIBERADAMENTE desechable. La privacidad absoluta es
 * el producto, así que el historial vive en el Cache Storage del navegador
 * (con `localStorage` como fallback y memoria como último recurso): si la
 * persona borra la caché, el historial desaparece con ella.
 *
 * Reglas duras:
 *  - NADA sale del navegador (sin red, sin telemetría).
 *  - NUNCA se persisten nombres de archivo, contenidos, bytes ni texto derivado;
 *    solo `{ actionId, kind, config, ts, count }`.
 *  - La config se filtra en ESCRITURA: se descarta cualquier clave sensible
 *    (`/pass|secret|token|key/i`), cubriendo `crypto.file` → `passphrase`.
 *  - Toda falla de almacenamiento se traga: el historial jamás rompe una tool.
 */
import type { ActionConfig, FileKind } from '@/core/types'

/** Entrada del historial (nunca contiene datos del archivo, solo su `kind`). */
export interface HistoryEntry {
  actionId: string
  kind: FileKind
  /** Configuración ya filtrada (sin claves sensibles). */
  config: ActionConfig
  /** Marca temporal monótona en ms (desempata orden por recencia). */
  ts: number
  /** Veces que se ejecutó la acción con este `kind`. */
  count: number
}

/** Entrada que recibe `record` (la config solo se guarda filtrada). */
export interface HistoryRecordInput {
  actionId: string
  kind: FileKind
  config: ActionConfig
}

/* ────────────────────────────────────────────────────────────
 * Constantes de almacenamiento
 * ──────────────────────────────────────────────────────────── */

/** Bucket de Cache Storage (versionado). */
const CACHE_NAME = 'adei-one/history/v1'
/** Clave sintética dentro del bucket (Request/Response, sin red real). */
const CACHE_REQUEST_URL = 'https://adei-one.invalid/history/v1'
/** Clave del fallback en localStorage (versionada). */
const LOCAL_STORAGE_KEY = 'adei-one:history:v1'
/** Filtro de claves sensibles: se aplica antes de persistir. */
const SECRET_KEY = /pass|secret|token|key/i

/* ────────────────────────────────────────────────────────────
 * Estado en memoria (fuente de lectura de la sesión)
 * ──────────────────────────────────────────────────────────── */

let entries: HistoryEntry[] = []
let loaded = false
let lastTs = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      /* un suscriptor roto no debe romper a los demás */
    }
  }
}

/** Marca temporal estrictamente creciente (evita empates dentro del mismo ms). */
function nextTs(): number {
  const now = Date.now()
  lastTs = now > lastTs ? now : lastTs + 1
  return lastTs
}

function clone(entry: HistoryEntry): HistoryEntry {
  return { ...entry, config: { ...entry.config } }
}

/** Descarta claves sensibles de la config (nivel superior, escritura). */
function filterSecrets(config: ActionConfig | undefined | null): ActionConfig {
  const filtered: ActionConfig = {}
  if (!config) return filtered
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_KEY.test(key)) continue
    filtered[key] = value
  }
  return filtered
}

/* ────────────────────────────────────────────────────────────
 * Adaptadores de almacenamiento (se resuelven en cada operación)
 * ──────────────────────────────────────────────────────────── */

function getCaches(): CacheStorage | undefined {
  const value = (globalThis as { caches?: CacheStorage }).caches
  return value ?? undefined
}

function getLocalStorage(): Storage | undefined {
  try {
    const value = (globalThis as { localStorage?: Storage }).localStorage
    return value ?? undefined
  } catch {
    // Acceder a localStorage puede lanzar (modo privado/denegado).
    return undefined
  }
}

/** Normaliza datos crudos de almacenamiento a entradas seguras. */
function toEntries(raw: unknown): HistoryEntry[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item): item is HistoryEntry =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as HistoryEntry).actionId === 'string' &&
      typeof (item as HistoryEntry).kind === 'string' &&
      typeof (item as HistoryEntry).ts === 'number' &&
      typeof (item as HistoryEntry).count === 'number',
  )
}

/** Lee del Cache Storage. `null` = nivel no disponible. */
async function cacheRead(): Promise<HistoryEntry[] | null> {
  const caches = getCaches()
  if (!caches) return null
  try {
    const cache = await caches.open(CACHE_NAME)
    const response = await cache.match(new Request(CACHE_REQUEST_URL))
    if (!response) return []
    return toEntries(await response.json())
  } catch {
    return null
  }
}

/** Escribe en el Cache Storage. `true` si tuvo éxito. */
async function cacheWrite(payload: HistoryEntry[]): Promise<boolean> {
  const caches = getCaches()
  if (!caches) return false
  try {
    const cache = await caches.open(CACHE_NAME)
    const response = new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    })
    await cache.put(new Request(CACHE_REQUEST_URL), response)
    return true
  } catch {
    return false
  }
}

/** Lee de localStorage. `null` = nivel no disponible o ilegible. */
function localStorageRead(): HistoryEntry[] | null {
  const storage = getLocalStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(LOCAL_STORAGE_KEY)
    if (raw === null) return []
    return toEntries(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Escribe en localStorage. `true` si tuvo éxito. */
function localStorageWrite(payload: HistoryEntry[]): boolean {
  const storage = getLocalStorage()
  if (!storage) return false
  try {
    storage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload))
    return true
  } catch {
    return false
  }
}

/** Carga inicial: Cache Storage → localStorage → memoria. */
async function loadFromStorage(): Promise<HistoryEntry[] | null> {
  const fromCache = await cacheRead()
  if (fromCache && fromCache.length > 0) return fromCache
  const fromLocalStorage = localStorageRead()
  if (fromLocalStorage && fromLocalStorage.length > 0) return fromLocalStorage
  return fromCache ?? fromLocalStorage
}

/** Persiste en el mejor nivel disponible (fallas tragadas). */
async function persist(): Promise<void> {
  const payload = entries.map(clone)
  if (await cacheWrite(payload)) return
  localStorageWrite(payload)
}

async function ensureLoaded(): Promise<void> {
  if (loaded) return
  const fromStorage = await loadFromStorage()
  entries = fromStorage ?? []
  loaded = true
}

/* ────────────────────────────────────────────────────────────
 * API pública
 * ──────────────────────────────────────────────────────────── */

/**
 * Registra una ejecución: suma al contador de la acción y la mueve al frente.
 * Filtra secretos antes de guardar y traga cualquier fallo de almacenamiento.
 */
export async function record(input: HistoryRecordInput): Promise<void> {
  await ensureLoaded()
  const config = filterSecrets(input.config)
  const ts = nextTs()
  const existing = entries.find(
    (entry) => entry.actionId === input.actionId && entry.kind === input.kind,
  )
  if (existing) {
    existing.count += 1
    existing.ts = ts
    existing.config = config
  } else {
    entries.push({ actionId: input.actionId, kind: input.kind, config, ts, count: 1 })
  }
  notify()
  await persist()
}

/** Entradas (opcionalmente de un `kind`), más recientes primero. */
export async function list(kind?: FileKind): Promise<HistoryEntry[]> {
  await ensureLoaded()
  const source = kind ? entries.filter((entry) => entry.kind === kind) : entries
  return [...source].sort((a, b) => b.ts - a.ts).map(clone)
}

/** Ranking por uso (`count` desc), desempatando por recencia. */
export function top(kind?: FileKind, limit?: number): HistoryEntry[] {
  const source = kind ? entries.filter((entry) => entry.kind === kind) : [...entries]
  const sorted = [...source].sort((a, b) => b.count - a.count || b.ts - a.ts)
  const limited = limit && limit > 0 ? sorted.slice(0, limit) : sorted
  return limited.map(clone)
}

/** Config no sensible de la última ejecución de `actionId`, o `undefined`. */
export function lastConfigFor(actionId: string): ActionConfig | undefined {
  let latest: HistoryEntry | undefined
  for (const entry of entries) {
    if (entry.actionId !== actionId) continue
    if (!latest || entry.ts > latest.ts) latest = entry
  }
  return latest ? { ...latest.config } : undefined
}

/** Vacía la memoria y AMBOS niveles de almacenamiento (escape de privacidad). */
export async function clear(): Promise<void> {
  entries = []
  loaded = true
  lastTs = 0
  notify()

  const caches = getCaches()
  if (caches) {
    try {
      await caches.delete(CACHE_NAME)
    } catch {
      /* best-effort */
    }
  }

  const storage = getLocalStorage()
  if (storage) {
    try {
      storage.removeItem(LOCAL_STORAGE_KEY)
    } catch {
      /* best-effort */
    }
  }
}

/** Notifica cambios de historial. Devuelve la función para desuscribir. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
