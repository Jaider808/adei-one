/** @vitest-environment happy-dom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { App } from '@/App'
import { ThemeProvider } from '@/lib/theme'
import { clear as clearHistory } from '@/core/history'
import { useHistory } from '@/core/stores/history'
import { useWorkflow } from '@/core/stores/workflow'
import { useWorkspace } from '@/core/stores/workspace'
import type { Artifact } from '@/core/types'

const PDF: Artifact = {
  id: 't1',
  name: 'contrato.pdf',
  kind: 'pdf',
  size: 4096,
  source: 'file',
  file: new File(['%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF'], 'contrato.pdf', {
    type: 'application/pdf',
  }),
}

beforeEach(async () => {
  cleanup()
  // Los stores de zustand son singletons y sobreviven entre tests.
  useWorkspace.getState().reset()
  useWorkflow.getState().reset()
  // El historial persiste en almacenamiento: limpiarlo para aislar los tests.
  await clearHistory()
  useHistory.setState({ entries: [], hydrated: false })
})

function renderApp() {
  // Montaje idéntico a main.tsx (App requiere ThemeProvider)
  return render(
    <ThemeProvider>
      <App />
    </ThemeProvider>,
  )
}

function selectFile(artifact: Artifact = PDF) {
  act(() => {
    useWorkspace.getState().setArtifact(artifact)
  })
}

async function selectPdfAndWait() {
  renderApp()
  selectFile()
  await screen.findByRole('heading', { level: 1, name: 'Qué puedes hacer' })
  await waitFor(() =>
    expect(screen.getAllByText('Recortar PDF').length).toBeGreaterThan(0),
  )
}

/** Smoke test de integración: monta la app completa sin depender de un navegador. */
describe('<App />', () => {
  it('estado inicial: solo la parte de subir centrada + guía visual, sin footer', () => {
    renderApp()

    // Header con wordmark ADEI-ONE y privacidad SIEMPRE arriba
    expect(screen.getByRole('link', { name: /ADEI-ONE/ })).toBeTruthy()
    expect(screen.getAllByText('100% local').length).toBeGreaterThan(0)

    expect(screen.getByRole('heading', { level: 1, name: 'Sube tu archivo' })).toBeTruthy()
    const dropzone = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.includes('Arrastra tu archivo aquí'))
    expect(dropzone).toBeTruthy()

    expect(screen.queryByRole('heading', { name: 'Qué puedes hacer' })).toBeNull()
    expect(screen.queryByText(/hecho para la privacidad/i)).toBeNull()
  })

  it('con archivo: muestra las categorías admitidas por el formato con sus acciones', async () => {
    await selectPdfAndWait()

    // PDF + meta (transversal) están admitidas para un PDF
    expect(screen.getAllByText('Recortar PDF').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Eliminar metadata').length).toBeGreaterThan(0)
    // Subtítulo de categoría presente
    expect(screen.getByText(/Recorta, une, firma/i)).toBeTruthy()
    // El nombre del archivo aparece en el subtítulo del panel
    expect(screen.getAllByText('contrato.pdf').length).toBeGreaterThan(0)
    // Transparencia: acordeón "Cómo funciona" por categoría + tecnología interna
    expect(screen.getAllByText('Cómo funciona').length).toBeGreaterThan(0)
    expect(screen.getAllByText('pdf-lib (estructura y edición)').length).toBeGreaterThan(0)
  })

  it('al elegir una herramienta crece in-place con botón volver; las de páginas usan selector visual', async () => {
    await selectPdfAndWait()

    fireEvent.click(screen.getByRole('button', { name: /Recortar PDF/ }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /volver/i })).toBeTruthy(),
    )
    // El cuerpo de la herramienta aparece: ícono + título
    expect(screen.getByRole('heading', { name: 'Recortar PDF' })).toBeTruthy()
    // El campo de texto "Cómo dividir" fue reemplazado por el selector visual de páginas
    expect(screen.queryByText('Cómo dividir')).toBeNull()

    // Volver restaura las categorías admitidas del formato
    fireEvent.click(screen.getByRole('button', { name: /volver/i }))
    await waitFor(() => expect(screen.getAllByText('Recortar PDF').length).toBeGreaterThan(0))
  })

  it('las tools sin motor se ven bloqueadas con "Próximamente" y no se abren', async () => {
    await selectPdfAndWait()

    // "Resumir texto" (IA) aún no tiene motor → gris/bloqueada
    const pendingCard = screen.getByRole('button', { name: /Resumir texto/ })
    expect(pendingCard.getAttribute('aria-disabled')).toBe('true')
    expect(screen.getAllByText('Próximamente').length).toBeGreaterThan(0)

    // Click en card bloqueada NO abre la herramienta
    fireEvent.click(pendingCard)
    expect(screen.queryByRole('button', { name: /volver/i })).toBeNull()
    expect(screen.queryByText('Cómo dividir')).toBeNull()
  })

  it('"Recientes" muestra las acciones ya ejecutadas para el formato', async () => {
    await selectPdfAndWait()

    await act(async () => {
      await useHistory.getState().record({ actionId: 'pdf.split', kind: 'pdf', config: {} })
    })

    await screen.findByText('Recientes')
    expect(screen.getByRole('button', { name: 'Volver a usar Recortar PDF' })).toBeTruthy()
  })

  it('"Borrar historial" vacía "Recientes" inmediatamente', async () => {
    await selectPdfAndWait()
    await act(async () => {
      await useHistory.getState().record({ actionId: 'pdf.split', kind: 'pdf', config: {} })
    })
    await screen.findByText('Recientes')

    fireEvent.click(screen.getByRole('button', { name: 'Borrar historial' }))

    await waitFor(() => expect(screen.queryByText('Recientes')).toBeNull())
  })
})