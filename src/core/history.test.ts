import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clear, lastConfigFor, list, record, subscribe, top } from '@/core/history'

/* ────────────────────────────────────────────────────────────
 * Dobladores de almacenamiento (el módulo no debe depender de ellos):
 * Cache Storage falso + localStorage falso, inyectados en globalThis.
 * ──────────────────────────────────────────────────────────── */

class FakeCache {
  readonly entries = new Map<string, Response>()

  async put(request: Request | string, response: Response): Promise<void> {
    this.entries.set(typeof request === 'string' ? request : request.url, response)
  }

  async match(request: Request | string): Promise<Response | undefined> {
    const key = typeof request === 'string' ? request : request.url
    return this.entries.get(key)
  }

  async delete(request: Request | string): Promise<boolean> {
    const key = typeof request === 'string' ? request : request.url
    return this.entries.delete(key)
  }
}

class FakeCacheStorage {
  readonly buckets = new Map<string, FakeCache>()

  async open(name: string): Promise<FakeCache> {
    let bucket = this.buckets.get(name)
    if (!bucket) {
      bucket = new FakeCache()
      this.buckets.set(name, bucket)
    }
    return bucket
  }

  async delete(name: string): Promise<boolean> {
    return this.buckets.delete(name)
  }

  async has(name: string): Promise<boolean> {
    return this.buckets.has(name)
  }
}

class FakeLocalStorage {
  private readonly map = new Map<string, string>()

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}

/** Todo el texto persistido en el Cache Storage falso (para auditar secretos). */
async function cacheText(store: FakeCacheStorage): Promise<string> {
  let text = ''
  for (const bucket of store.buckets.values()) {
    for (const response of bucket.entries.values()) {
      text += await response.text()
    }
  }
  return text
}

function setGlobal(key: 'caches' | 'localStorage', value: unknown): void {
  ;(globalThis as Record<string, unknown>)[key] = value
}

function removeGlobal(key: 'caches' | 'localStorage'): void {
  delete (globalThis as Record<string, unknown>)[key]
}

describe('history (módulo puro)', () => {
  beforeEach(async () => {
    // Estado limpio entre tests (el módulo mantiene caché en memoria).
    await clear()
  })

  afterEach(() => {
    removeGlobal('caches')
    removeGlobal('localStorage')
  })

  it('registra, cuenta ocurrencias y ordena del más reciente al más antiguo', async () => {
    await record({ actionId: 'pdf.split', kind: 'pdf', config: { mode: 'ranges' } })
    await record({ actionId: 'pdf.merge', kind: 'pdf', config: {} })
    await record({ actionId: 'pdf.compress', kind: 'pdf', config: {} })

    const entries = await list('pdf')
    expect(entries.map((entry) => entry.actionId)).toEqual([
      'pdf.compress',
      'pdf.merge',
      'pdf.split',
    ])
    expect(entries.every((entry) => entry.count === 1)).toBe(true)

    // Repetir una acción sube su contador y la mueve al frente.
    await record({ actionId: 'pdf.split', kind: 'pdf', config: { mode: 'ranges' } })
    const after = await list('pdf')
    expect(after[0].actionId).toBe('pdf.split')
    expect(after[0].count).toBe(2)
    expect(after).toHaveLength(3)
  })

  it('filtra por FileKind', async () => {
    await record({ actionId: 'pdf.split', kind: 'pdf', config: {} })
    await record({ actionId: 'image.resize', kind: 'png', config: {} })

    expect((await list('pdf')).map((entry) => entry.actionId)).toEqual(['pdf.split'])
    expect((await list('png')).map((entry) => entry.actionId)).toEqual(['image.resize'])
    expect(await list()).toHaveLength(2)
  })

  it('top ordena por count desc y desempata por recencia; respeta el límite', async () => {
    await record({ actionId: 'pdf.split', kind: 'pdf', config: {} })
    await record({ actionId: 'pdf.merge', kind: 'pdf', config: {} })
    await record({ actionId: 'pdf.compress', kind: 'pdf', config: {} })
    await record({ actionId: 'pdf.split', kind: 'pdf', config: {} })
    await record({ actionId: 'pdf.merge', kind: 'pdf', config: {} })
    await record({ actionId: 'pdf.split', kind: 'pdf', config: {} })

    expect(top('pdf').map((entry) => entry.actionId)).toEqual([
      'pdf.split',
      'pdf.merge',
      'pdf.compress',
    ])
    expect(top('pdf', 2).map((entry) => entry.actionId)).toEqual(['pdf.split', 'pdf.merge'])
  })

  it('NUNCA persiste claves sensibles (passphrase/secret/token/key)', async () => {
    const caches = new FakeCacheStorage()
    const localStorage = new FakeLocalStorage()
    setGlobal('caches', caches)
    setGlobal('localStorage', localStorage)

    await record({
      actionId: 'crypto.file',
      kind: 'pdf',
      config: {
        passphrase: 'SUPER-SECRET',
        apiKey: 'KEY-123',
        authToken: 'TOKEN-123',
        clientSecret: 'SECRET-123',
        profile: 'standard',
      },
    })

    expect(lastConfigFor('crypto.file')).toEqual({ profile: 'standard' })

    const cacheDump = await cacheText(caches)
    expect(cacheDump).not.toContain('SUPER-SECRET')
    expect(cacheDump).not.toContain('passphrase')
    expect(cacheDump).not.toContain('TOKEN-123')
    expect(cacheDump).not.toContain('SECRET-123')
    expect(cacheDump).not.toContain('KEY-123')
    expect(cacheDump).toContain('profile')
  })

  it('lastConfigFor devuelve la config más reciente (o undefined)', async () => {
    expect(lastConfigFor('pdf.split')).toBeUndefined()

    await record({ actionId: 'pdf.split', kind: 'pdf', config: { mode: 'all' } })
    await record({ actionId: 'pdf.split', kind: 'pdf', config: { mode: 'ranges' } })

    expect(lastConfigFor('pdf.split')).toEqual({ mode: 'ranges' })
  })

  it('clear vacía la lista y los dos niveles de almacenamiento', async () => {
    const caches = new FakeCacheStorage()
    const localStorage = new FakeLocalStorage()
    setGlobal('caches', caches)
    setGlobal('localStorage', localStorage)

    await record({ actionId: 'pdf.split', kind: 'pdf', config: {} })
    expect(await list('pdf')).toHaveLength(1)

    await clear()

    expect(await list()).toHaveLength(0)
    expect(caches.buckets.size).toBe(0)
    expect(localStorage.getItem('adei-one:history:v1')).toBeNull()
  })

  it('usa localStorage como fallback cuando Cache Storage no está disponible', async () => {
    removeGlobal('caches')
    const localStorage = new FakeLocalStorage()
    setGlobal('localStorage', localStorage)

    await record({ actionId: 'pdf.merge', kind: 'pdf', config: { order: 'auto' } })

    expect(localStorage.getItem('adei-one:history:v1')).toContain('pdf.merge')
    expect((await list('pdf')).map((entry) => entry.actionId)).toEqual(['pdf.merge'])
  })

  it('cae a memoria y NO lanza cuando no hay almacenamiento disponible', async () => {
    removeGlobal('caches')
    removeGlobal('localStorage')

    await expect(
      record({ actionId: 'pdf.split', kind: 'pdf', config: { mode: 'ranges' } }),
    ).resolves.toBeUndefined()

    // Sin persistencia, la sesión aún recuerda (fallback en memoria).
    expect((await list('pdf')).map((entry) => entry.actionId)).toEqual(['pdf.split'])
    expect(top('pdf')).toHaveLength(1)
  })

  it('subscribe notifica en record y clear, y se cancela al desuscribir', async () => {
    let calls = 0
    const unsubscribe = subscribe(() => {
      calls += 1
    })

    await record({ actionId: 'pdf.split', kind: 'pdf', config: {} })
    expect(calls).toBe(1)

    await clear()
    expect(calls).toBe(2)

    unsubscribe()
    await record({ actionId: 'pdf.merge', kind: 'pdf', config: {} })
    expect(calls).toBe(2)
  })
})
