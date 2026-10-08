/**
 * ADEI-ONE — Tests de "Encriptar archivo" (`crypto.file`).
 *
 * El motor usa `libsodium-wrappers-sumo` (import dinámico; el build estándar
 * de libsodium 0.8.x excluye Argon2). Argon2id estándar (3 iteraciones,
 * 256 MiB) tarda ~2 s por derivación en Node, así que los tests de cripto
 * llevan timeout generoso y se limitan a 1-2 roundtrips reales.
 *
 * Errores estables del engine (documentados en `engine.ts`):
 *  - 'No es un archivo ADEI-ONE válido'   (cabecera mal formada / bounds KDF)
 *  - 'Archivo truncado o corrupto'        (stream incompleto)
 *  - 'Contraseña incorrecta o archivo corrupto' (fallo AEAD)
 */
import { describe, expect, it } from 'vitest'
import { cryptoFile, sanitizeName } from './engine'
import type { EngineInput, FileKind } from '@/core/types'

/** Construye un `EngineInput` a partir de bytes puros. */
function eng(bytes: Uint8Array, name: string, kind: FileKind = 'txt'): EngineInput {
  return { bytes, name, kind, config: {} }
}

/** Fija la contraseña (y perfil opcional) en la config del input. */
function withPass(
  input: EngineInput,
  passphrase: string,
  profile?: 'standard' | 'high',
): EngineInput {
  return { ...input, config: { passphrase, ...(profile ? { profile } : {}) } }
}

/** Bytes del blob de un resultado. */
async function bytesOf(result: { blob: Blob }): Promise<Uint8Array> {
  return new Uint8Array(await result.blob.arrayBuffer())
}

describe('cryptoFile · roundtrip', () => {
  it(
    'encripta un fixture y luego lo desencripta recuperando bytes y nombre',
    async () => {
      const plain = new TextEncoder().encode('Hola mundo')
      const sealed = await cryptoFile(withPass(eng(plain, 'doc.txt'), 'correct horse'))

      // Salida: formato .adei (kind txt, mime octet-stream, magic ADEI).
      expect(sealed.kind).toBe('txt')
      expect(sealed.name).toBe('doc.adei')
      expect(sealed.blob.type).toBe('application/octet-stream')
      const sealedBytes = await bytesOf(sealed)
      expect(new TextDecoder().decode(sealedBytes.subarray(0, 4))).toBe('ADEI')

      // Reabrir con la misma contraseña → bytes y nombre originales.
      const opened = await cryptoFile(withPass(eng(sealedBytes, sealed.name), 'correct horse'))
      expect(opened.kind).toBe('txt')
      expect(opened.name).toBe('doc.txt')
      expect(opened.blob.type).toBe('application/octet-stream')
      expect(new TextDecoder().decode(await bytesOf(opened))).toBe('Hola mundo')
    },
    60_000,
  )

  it(
    'contraseña incorrecta: error claro al descifrar',
    async () => {
      const sealed = await cryptoFile(withPass(eng(new TextEncoder().encode('secreto'), 'a.txt'), 'buena'))
      await expect(
        cryptoFile(withPass(eng(await bytesOf(sealed), 'a.adei'), 'mala')),
      ).rejects.toThrow(/contraseña/i)
    },
    60_000,
  )
})

describe('cryptoFile · detección', () => {
  it(
    'archivo plano → encripta (el resultado empieza por ADEI)',
    async () => {
      const result = await cryptoFile(withPass(eng(new TextEncoder().encode('Hola mundo'), 'x.txt'), 'pass'))
      const bytes = await bytesOf(result)
      expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('ADEI')
      expect(result.blob.type).toBe('application/octet-stream')
    },
    60_000,
  )

  it('bytes que empiezan por ADEI pero corruptos (muy cortos) → no es un archivo', async () => {
    const short = new TextEncoder().encode('ADEI')
    await expect(cryptoFile(withPass(eng(short, 'x.adei'), 'pass'))).rejects.toThrow(
      /no es un archivo/i,
    )
  })
})

describe('cryptoFile · bounds del KDF', () => {
  it('cabecera fabricada con memlimit > 1 GiB se rechaza sin derivar clave', async () => {
    const head = new Uint8Array(54)
    head.set(new TextEncoder().encode('ADEI'), 0)
    head[4] = 1 // version
    head[5] = 2 // ALG_ARGON2ID13 (constante del wrapper sumo)
    head.set([3, 0, 0, 0], 6) // opslimit = 3
    head.set([0, 0, 0, 0x60], 10) // memlimit = 1.5 GiB (> 1 GiB permitido)
    await expect(cryptoFile(withPass(eng(head, 'x.adei'), 'pass'))).rejects.toThrow(
      /no es un archivo/i,
    )
  })
})

describe('sanitizeName', () => {
  it('quita rutas, control chars y override bidireccional', () => {
    expect(sanitizeName('../../../evil.txt')).toBe('evil.txt')
    expect(sanitizeName('C:\\Users\\pepe\\foto.png')).toBe('foto.png')
    expect(sanitizeName('\u202ertc.txt')).toBe('rtc.txt')
  })

  it('bloquea puntos iniciales y recorta a 200 caracteres', () => {
    expect(sanitizeName('..')).toBe('archivo')
    expect(sanitizeName('.hidden')).toBe('hidden')
    const long = `${'x'.repeat(300)}.txt`
    expect(sanitizeName(long)).toHaveLength(200)
  })
})

describe('cryptoFile · guardas', () => {
  it('bytes vacíos: guardia clara (sin tocar cripto)', async () => {
    await expect(cryptoFile(eng(new Uint8Array(), 'vacio.txt'))).rejects.toThrow(
      'Se necesita un archivo',
    )
  })

  it('sin contraseña: guardia clara', async () => {
    await expect(cryptoFile(eng(new TextEncoder().encode('hola'), 'x.txt'))).rejects.toThrow(
      'La contraseña no puede estar vacía',
    )
  })
})