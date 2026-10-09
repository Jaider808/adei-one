/** @vitest-environment happy-dom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MetaStripView } from './view'
import { stripMetadataTool } from './tool'
import type { Artifact, MetaEntry, MetadataReport, RegenerationRisk } from '@/core/types'

const engineMock = vi.hoisted(() => ({ scanMetadata: vi.fn() }))

vi.mock('./engine', () => ({ scanMetadata: engineMock.scanMetadata }))

/** Report base sin metadata; cada test añade lo que necesita. */
const EMPTY: MetadataReport = { fields: [], count: 0, blocks: [], entries: [] }

function artifactFor(name = 'cancion.mp3'): Artifact {
  return {
    id: 'a1',
    name,
    kind: 'mp3',
    size: 2048,
    source: 'file',
    file: new File([new Uint8Array([0x49, 0x44, 0x33])], name, { type: 'audio/mpeg' }),
  }
}

function renderView(report: MetadataReport) {
  engineMock.scanMetadata.mockResolvedValue(report)
  const onSubmit = vi.fn()
  render(<MetaStripView action={stripMetadataTool} artifact={artifactFor()} onSubmit={onSubmit} />)
  return onSubmit
}

/** Valor numérico del cuadro de resumen cuya etiqueta se pasa. */
function statValue(label: string): string | null {
  return screen.getByText(label).previousElementSibling?.textContent ?? null
}

beforeEach(() => {
  cleanup()
  engineMock.scanMetadata.mockReset()
})

describe('<MetaStripView /> — inventario', () => {
  it('muestra una entrada desconocida con su clave cruda (sin ocultarla)', async () => {
    renderView({
      ...EMPTY,
      entries: [
        {
          where: 'ID3v2 > TXXX',
          key: 'TXXX',
          value: 'valor privado',
          sensitivity: 'high',
          removal: 'with-container',
        },
      ],
    })

    expect(await screen.findByText('TXXX')).toBeTruthy()
    expect(screen.getByText('valor privado')).toBeTruthy()
  })

  it('hoistea la inseparabilidad de un grupo with-container una sola vez', async () => {
    renderView({
      ...EMPTY,
      blocks: [
        {
          id: 'id3v2',
          label: 'Etiqueta ID3v2',
          removableIn: 'light',
          fields: [{ name: 'Título', value: 'Hola', sensitivity: 'low' }],
        },
      ],
      entries: [
        {
          where: 'ID3v2 > PRIV',
          key: 'PRIV',
          value: 'binario',
          sensitivity: 'medium',
          removal: 'with-container',
        },
        {
          where: 'ID3v2 > PRIV',
          key: 'PRIV2',
          value: 'más binario',
          sensitivity: 'high',
          removal: 'with-container',
        },
      ],
    })

    expect(await screen.findByText('Se elimina')).toBeTruthy()
    // La nota vive en la cabecera del grupo, no repetida por cada fila.
    expect(screen.getAllByText('se borra junto con su contenedor').length).toBe(1)
  })

  it('no repite la etiqueta cuando coincide con la clave humanizada (defecto reportado)', async () => {
    renderView({
      ...EMPTY,
      entries: [
        {
          where: 'Datos de cámara (EXIF/GPS)',
          key: 'Tiempo de exposición',
          label: 'Tiempo de exposición',
          value: '0,083',
          sensitivity: 'low',
          removal: 'individual',
        },
      ],
    })

    // El dato es el ancla y la etiqueta se pinta exactamente una vez.
    expect(await screen.findByText('0,083')).toBeTruthy()
    expect(screen.getAllByText('Tiempo de exposición').length).toBe(1)
  })

  it('no repite la clave cruda cuando es idéntica a la etiqueta en forma camelCase (forma de producción)', async () => {
    // Forma real de producción (image-plus): `key === label === "ExposureTime"`
    // para una clave EXIF sin curar. `humanizeKey` la reescribiría a
    // "Exposure Time" y el guard antiguo dejaría pintar la misma cadena dos
    // veces (caption + clave cruda).
    renderView({
      ...EMPTY,
      entries: [
        {
          where: 'Datos de cámara (EXIF/GPS)',
          key: 'ExposureTime',
          label: 'ExposureTime',
          value: '0,083',
          sensitivity: 'medium',
          removal: 'individual',
        },
      ],
    })

    expect(await screen.findByText('0,083')).toBeTruthy()
    expect(screen.getAllByText('ExposureTime').length).toBe(1)
  })

  it('muestra la clave cruda solo cuando aporta información frente a la etiqueta', async () => {
    renderView({
      ...EMPTY,
      entries: [
        {
          where: 'Datos de cámara (EXIF/GPS)',
          key: 'EXIF:ExposureTime',
          label: 'Tiempo de exposición',
          value: '0,083',
          sensitivity: 'low',
          removal: 'individual',
        },
      ],
    })

    expect(await screen.findByText('EXIF:ExposureTime')).toBeTruthy()
    expect(screen.getByText('Tiempo de exposición')).toBeTruthy()
  })

  it('declara el resultado por fila solo cuando el grupo mezcla resultados', async () => {
    renderView({
      ...EMPTY,
      blocks: [
        {
          id: 'id3v2',
          label: 'Etiqueta ID3v2',
          removableIn: 'light',
          fields: [{ name: 'Título', value: 'Hola', sensitivity: 'low' }],
        },
      ],
      entries: [
        {
          where: 'ID3v2',
          key: 'TIT2',
          label: 'Título',
          value: 'Hola',
          sensitivity: 'low',
          removal: 'individual',
        },
        {
          where: 'ID3v2',
          key: 'GEOB',
          label: 'Geolocalización',
          value: 'coordenadas',
          sensitivity: 'high',
          removal: 'never',
        },
      ],
    })

    await screen.findByText('Hola')
    // Grupo mixto: sin insignia única; una por fila, sin duplicar.
    expect(screen.getAllByText('Se elimina').length).toBe(1)
    expect(screen.getAllByText('Se conserva').length).toBe(1)
  })

  it('filtra por clave, valor o ruta y muestra el estado sin resultados', async () => {
    renderView({
      ...EMPTY,
      entries: [
        {
          where: 'ID3v2 > TIT2',
          key: 'TIT2',
          label: 'Título',
          value: 'Hola mundo',
          sensitivity: 'low',
          removal: 'with-container',
        },
        {
          where: 'ID3v2 > TXXX',
          key: 'TXXX',
          value: 'secreto',
          sensitivity: 'high',
          removal: 'with-container',
        },
      ],
    })

    const input = await screen.findByLabelText('Buscar en el inventario')
    fireEvent.change(input, { target: { value: 'secreto' } })

    await waitFor(() => expect(screen.queryByText('Hola mundo')).toBeNull())
    expect(screen.getByText('secreto')).toBeTruthy()

    fireEvent.change(input, { target: { value: 'no-existe-xyz' } })
    expect(await screen.findByText('Sin resultados')).toBeTruthy()
  })

  it('el resumen cuadra con las filas mostradas', async () => {
    renderView({
      ...EMPTY,
      blocks: [
        {
          id: 'id3v2',
          label: 'Etiqueta ID3v2',
          removableIn: 'light',
          fields: [{ name: 'Título', value: 'Hola', sensitivity: 'low' }],
        },
      ],
      entries: [
        {
          where: 'ID3v2 > TIT2',
          key: 'TIT2',
          label: 'Título',
          value: 'Hola',
          sensitivity: 'low',
          removal: 'with-container',
        },
        {
          where: 'FLAC > PICTURE',
          key: 'PICTURE',
          value: 'portada',
          sensitivity: 'low',
          removal: 'individual',
        },
        {
          where: 'StreamInfo',
          key: 'sample_rate',
          label: 'Frecuencia de muestreo',
          value: '44100',
          sensitivity: 'high',
          removal: 'never',
        },
      ],
    })

    await screen.findByText('Entradas encontradas')
    expect(statValue('Entradas encontradas')).toBe('3')
    expect(statValue('Se eliminarán')).toBe('2')
    expect(statValue('Se conservarán')).toBe('1')
    expect(statValue('De alto riesgo')).toBe('1')

    // Las filas de borrado coinciden con el resumen.
    expect(screen.getAllByText('Se elimina').length).toBe(2)
    expect(screen.getAllByText('Se conserva').length).toBe(1)
  })

  it('no promete borrado en el modo por defecto cuando no hay ningún bloque eliminable que enviar', async () => {
    renderView({
      ...EMPTY,
      blocks: [
        {
          id: 'format',
          label: 'Información técnica',
          removableIn: 'never',
          fields: [{ name: 'Formato', value: 'MP3', sensitivity: 'low' }],
        },
      ],
      entries: [
        {
          where: 'ID3v2 > PRIV',
          key: 'PRIV',
          value: 'binario',
          sensitivity: 'high',
          removal: 'with-container',
        },
      ],
    })

    // MP3 cuyo único frame es desconocido: no se emite bloque eliminable, el
    // submit queda deshabilitado y ninguna fila puede decir "Se elimina".
    await screen.findByText('Entradas encontradas')
    expect(statValue('Se eliminarán')).toBe('0')
    expect(statValue('Se conservarán')).toBe('1')
    expect(screen.queryAllByText('Se elimina').length).toBe(0)
    expect(screen.getAllByText('Se conserva').length).toBe(1)

    const boton = screen.getByRole('button', { name: 'Eliminar toda la metadata' }) as HTMLButtonElement
    expect(boton.disabled).toBe(true)
  })

  it('con el switch activado (deep) sí elimina las entradas eliminables aunque en light no haya bloques', async () => {
    renderView({
      ...EMPTY,
      entries: [
        {
          where: 'ID3v2 > PRIV',
          key: 'PRIV',
          value: 'binario',
          sensitivity: 'high',
          removal: 'with-container',
        },
      ],
    })

    await screen.findByText('Entradas encontradas')
    fireEvent.click(screen.getByRole('switch', { name: 'Permitir modificar el archivo' }))

    await waitFor(() => expect(screen.getAllByText('Se elimina').length).toBe(1))
    expect(statValue('Se eliminarán')).toBe('1')
    const boton = screen.getByRole('button', { name: 'Eliminar toda la metadata' }) as HTMLButtonElement
    expect(boton.disabled).toBe(false)
  })

  it('revela el hex crudo con un botón accesible', async () => {
    renderView({
      ...EMPTY,
      entries: [
        {
          where: 'FLAC > PICTURE',
          key: 'PICTURE',
          value: 'portada',
          size: 3,
          hex: 'ff d8 ff',
          sensitivity: 'low',
          removal: 'individual',
        },
      ],
    })

    const bytes = await screen.findByText('ff d8 ff')
    expect((bytes as HTMLElement).hidden).toBe(true)

    const toggle = screen.getByRole('button', { name: 'Ver bytes' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle)

    expect((bytes as HTMLElement).hidden).toBe(false)
    expect(screen.getByRole('button', { name: 'Ocultar bytes' }).getAttribute('aria-expanded')).toBe(
      'true',
    )
  })

  it('recurre a la vista por bloques cuando no hay entradas enumeradas (PDF, Office…)', async () => {
    renderView({
      ...EMPTY,
      blocks: [
        {
          id: 'info',
          label: 'Información del documento',
          removableIn: 'light',
          fields: [{ name: 'Autor', value: 'Ada Lovelace', sensitivity: 'medium' }],
        },
      ],
      entries: [],
    })

    expect(await screen.findByText('Se puede eliminar')).toBeTruthy()
    expect(screen.getByText('Información del documento')).toBeTruthy()
    expect(screen.getByText('Ada Lovelace')).toBeTruthy()
    expect(screen.queryByText('Entradas encontradas')).toBeNull()
  })

  it('mantiene el contrato de envío { mode, blocks }', async () => {
    const onSubmit = renderView({
      ...EMPTY,
      blocks: [
        {
          id: 'id3v2',
          label: 'Etiqueta ID3v2',
          removableIn: 'light',
          fields: [{ name: 'Título', value: 'Hola', sensitivity: 'low' }],
        },
      ],
      entries: [
        {
          where: 'ID3v2 > TIT2',
          key: 'TIT2',
          label: 'Título',
          value: 'Hola',
          sensitivity: 'low',
          removal: 'with-container',
        },
      ],
    })

    const action = await screen.findByRole('button', { name: 'Eliminar toda la metadata' })
    fireEvent.click(action)
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'light', blocks: ['id3v2'] })

    fireEvent.click(screen.getByRole('switch', { name: 'Permitir modificar el archivo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar toda la metadata' }))
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'deep', blocks: [] })
  })
})

describe('<MetaStripView /> — modo y avisos inline', () => {
  const deepRisk: RegenerationRisk = {
    id: 'pdf-forms',
    label: 'Formularios',
    detail: 'El modo profundo elimina los formularios rellenables (2 campos).',
    severity: 'high',
    affects: 'deep',
  }
  // Riesgo legado del eje "light": el camino por defecto ya NO modifica el
  // archivo, así que no debe surfacearse en ningún estado del switch.
  const lightRisk: RegenerationRisk = {
    id: 'legacy-light',
    label: 'Re-codificación',
    detail: 'Un riesgo ligero legado que ya no debe mostrarse: el modo por defecto no toca el archivo.',
    severity: 'medium',
    affects: 'light',
  }
  const orientationEntry: MetaEntry = {
    where: 'Datos de cámara (EXIF/GPS)',
    key: 'Orientation',
    label: 'Orientación (se conserva para no girar la foto sin perder calidad)',
    value: '6',
    sensitivity: 'low',
    removal: 'never',
    preservedNote: 'Se conserva para no girar la foto sin perder calidad.',
  }

  it('el switch arranca apagado y el botón envía el modo no destructivo (light)', async () => {
    const onSubmit = renderView({
      ...EMPTY,
      blocks: [
        {
          id: 'id3v2',
          label: 'Etiqueta ID3v2',
          removableIn: 'light',
          fields: [{ name: 'Título', value: 'Hola', sensitivity: 'low' }],
        },
      ],
      entries: [
        {
          where: 'ID3v2 > TIT2',
          key: 'TIT2',
          label: 'Título',
          value: 'Hola',
          sensitivity: 'low',
          removal: 'with-container',
        },
      ],
    })

    const toggle = await screen.findByRole('switch', { name: 'Permitir modificar el archivo' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    await screen.findByText('Entradas encontradas')
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar toda la metadata' }))
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'light', blocks: ['id3v2'] })
  })

  it('activar el switch envía el modo que permite modificar el archivo (deep)', async () => {
    const onSubmit = renderView({
      ...EMPTY,
      blocks: [
        {
          id: 'id3v2',
          label: 'Etiqueta ID3v2',
          removableIn: 'light',
          fields: [{ name: 'Título', value: 'Hola', sensitivity: 'low' }],
        },
      ],
      entries: [
        {
          where: 'ID3v2 > TIT2',
          key: 'TIT2',
          label: 'Título',
          value: 'Hola',
          sensitivity: 'low',
          removal: 'with-container',
        },
      ],
    })

    const toggle = await screen.findByRole('switch', { name: 'Permitir modificar el archivo' })
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Eliminar toda la metadata' }))
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'deep', blocks: [] })
  })

  it('con el switch activado aparecen los avisos de lo que se pierde (deep)', async () => {
    renderView({ ...EMPTY, risks: [deepRisk] })

    // Apagado (por defecto): el aviso profundo no se muestra.
    await screen.findByRole('switch', { name: 'Permitir modificar el archivo' })
    expect(screen.queryByText(deepRisk.detail)).toBeNull()

    fireEvent.click(screen.getByRole('switch', { name: 'Permitir modificar el archivo' }))
    expect(await screen.findByText(deepRisk.detail)).toBeTruthy()
  })

  it('con el switch apagado explica la orientación conservada y señala el switch', async () => {
    renderView({ ...EMPTY, entries: [orientationEntry] })

    // La etiqueta explicativa del escaneo se surfacea (inventario + aviso).
    expect((await screen.findAllByText(orientationEntry.label as string)).length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Se conserva sin tocar el archivo')).toBeTruthy()
    expect(screen.getByText(/Activa «Permitir modificar el archivo»/)).toBeTruthy()
  })

  it('no surfacea riesgos del modo ligero: el camino por defecto es no destructivo', async () => {
    renderView({ ...EMPTY, risks: [lightRisk] })

    await screen.findByRole('switch', { name: 'Permitir modificar el archivo' })
    expect(screen.queryByText(lightRisk.detail)).toBeNull()

    fireEvent.click(screen.getByRole('switch', { name: 'Permitir modificar el archivo' }))
    expect(screen.queryByText(lightRisk.detail)).toBeNull()
  })

  it('sin nada que advertir no añade avisos ni ruido', async () => {
    renderView({
      ...EMPTY,
      blocks: [
        {
          id: 'id3v2',
          label: 'Etiqueta ID3v2',
          removableIn: 'light',
          fields: [{ name: 'Título', value: 'Hola', sensitivity: 'low' }],
        },
      ],
      entries: [
        {
          where: 'ID3v2 > TIT2',
          key: 'TIT2',
          label: 'Título',
          value: 'Hola',
          sensitivity: 'low',
          removal: 'individual',
        },
      ],
    })

    await screen.findByText('Hola')
    expect(screen.queryByText('Se conserva sin tocar el archivo')).toBeNull()
    expect(screen.queryByText(/Activa «Permitir modificar el archivo»/)).toBeNull()
    expect(screen.queryByText(/Afecta a:/)).toBeNull()

    // El botón conserva su única etiqueta en ambos estados del switch.
    expect(screen.getByRole('button', { name: 'Eliminar toda la metadata' })).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Permitir modificar el archivo' }))
    expect(screen.getByRole('button', { name: 'Eliminar toda la metadata' })).toBeTruthy()
  })

  it('mantiene el contrato de envío { mode, blocks } aunque existan riesgos', async () => {
    const onSubmit = renderView({
      ...EMPTY,
      risks: [deepRisk],
      blocks: [
        {
          id: 'id3v2',
          label: 'Etiqueta ID3v2',
          removableIn: 'light',
          fields: [{ name: 'Título', value: 'Hola', sensitivity: 'low' }],
        },
      ],
      entries: [
        {
          where: 'ID3v2 > TIT2',
          key: 'TIT2',
          label: 'Título',
          value: 'Hola',
          sensitivity: 'low',
          removal: 'with-container',
        },
      ],
    })

    fireEvent.click(await screen.findByRole('switch', { name: 'Permitir modificar el archivo' }))
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar toda la metadata' }))
    expect(onSubmit).toHaveBeenCalledWith({ mode: 'deep', blocks: [] })
  })
})
