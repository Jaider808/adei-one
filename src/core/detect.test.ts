import { describe, expect, it } from 'vitest'
import { detectKind, detectKindByMagic } from '@/core/detect'
import type { FileKind } from '@/core/types'

function fakeFile(name: string, type = ''): File {
  return new File(['x'], name, { type })
}

/** Construye un File cuyos bytes son una cabecera real (magic-bytes). */
function magicFile(name: string, bytes: ReadonlyArray<number>): File {
  return new File([new Uint8Array(bytes)], name)
}

/** Firmas mágicas reales de formatos conocidos. */
const MAGIC = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34], // %PDF-1.4
  png: [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
  ],
  jpg: [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01],
  gif: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00], // GIF87a
  webp: [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20], // RIFF....WEBPVP8
  flac: [0x66, 0x4c, 0x61, 0x43], // fLaC
  zip: [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00], // PK\x03\x04
} as const

describe('detectKind', () => {
  it('detecta por extensión en minúsculas', () => {
    expect(detectKind(fakeFile('CONTRATO.PDF'))).toBe('pdf')
    expect(detectKind(fakeFile('foto.jpeg'))).toBe('jpg')
    expect(detectKind(fakeFile('clip.mkv'))).toBe('mkv')
    expect(detectKind(fakeFile('notas.md'))).toBe('md')
  })

  it('usa el MIME como fallback cuando no hay extensión conocida', () => {
    expect(detectKind(fakeFile('sin-extension', 'application/pdf'))).toBe('pdf')
    expect(detectKind(fakeFile('archivo', 'image/png'))).toBe('png')
    expect(detectKind(fakeFile('a', 'text/csv'))).toBe('csv')
  })

  it('reconoce MIME de Office (OOXML)', () => {
    const docx = fakeFile(
      'doc.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    expect(detectKind(docx)).toBe('docx')
  })

  it('devuelve unknown para formatos desconocidos', () => {
    expect(detectKind(fakeFile('datos.bin'))).toBe('unknown')
    expect(detectKind(fakeFile('x', 'application/octet-stream'))).toBe('unknown')
  })

  it('el tipo detectado es siempre parte del union FileKind', () => {
    const kinds: FileKind[] = [
      'pdf', 'docx', 'xlsx', 'pptx', 'md', 'txt', 'csv', 'xml', 'json',
      'jpg', 'png', 'webp', 'gif', 'svg', 'tiff', 'heic',
      'mp3', 'flac', 'm4a', 'wav', 'mp4', 'mov', 'mkv', 'avi', 'webm',
      'epub', 'zip', 'unknown',
    ]
    for (const name of ['a.pdf', 'b.png', 'c.mp4', 'd.weird']) {
      expect(kinds).toContain(detectKind(fakeFile(name)))
    }
  })

  it('reconoce la extensión .adei (contenedor encriptado propio)', () => {
    expect(detectKind(fakeFile('mi-archivo.adei'))).toBe('adei')
  })
})

describe('detectKindByMagic (magic-bytes reales)', () => {
  it('detecta el contenedor encriptado .adei por su magic propio "ADEI"', async () => {
    expect(
      await detectKindByMagic(magicFile('archivo.adei', [0x41, 0x44, 0x45, 0x49, 0x01, 0x00])),
    ).toBe('adei')
  })

  it('detecta PDF por su cabecera %PDF-', async () => {
    expect(await detectKindByMagic(magicFile('documento.sin-ext', MAGIC.pdf))).toBe('pdf')
  })

  it('detecta PNG por su firma de 8 bytes', async () => {
    expect(await detectKindByMagic(magicFile('imagen.png', MAGIC.png))).toBe('png')
  })

  it('detecta JPG por su cabecera FFD8FF', async () => {
    expect(await detectKindByMagic(magicFile('foto.jpg', MAGIC.jpg))).toBe('jpg')
  })

  it('detecta GIF87a', async () => {
    expect(await detectKindByMagic(magicFile('anim.gif', MAGIC.gif))).toBe('gif')
  })

  it('detecta WebP (RIFF + WEBP)', async () => {
    expect(await detectKindByMagic(magicFile('imagen.webp', MAGIC.webp))).toBe('webp')
  })

  it('detecta FLAC', async () => {
    expect(await detectKindByMagic(magicFile('audio.flac', MAGIC.flac))).toBe('flac')
  })

  it('detecta ZIP por PK\\x03\\x04', async () => {
    expect(await detectKindByMagic(magicFile('paquete.zip', MAGIC.zip))).toBe('zip')
  })

  it('el magic-bytes gana a la extensión (archivo renombrado)', async () => {
    expect(await detectKindByMagic(magicFile('falso.pdf', MAGIC.png))).toBe('png')
  })

  it('devuelve unknown para texto plano sin formato conocido', async () => {
    const plain = new TextEncoder().encode('Solo texto plano sin formato conocido.')
    expect(await detectKindByMagic(magicFile('notas.txt', [...plain]))).toBe('unknown')
  })
})