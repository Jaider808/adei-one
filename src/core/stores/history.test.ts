import { beforeEach, describe, expect, it } from 'vitest'

import { clear as clearModule, list } from '@/core/history'
import { useHistory } from '@/core/stores/history'

describe('useHistory (store zustand)', () => {
  beforeEach(async () => {
    await clearModule()
    useHistory.setState({ entries: [], hydrated: false })
  })

  it('arranca vacío y sin hidratar', () => {
    const state = useHistory.getState()
    expect(state.entries).toEqual([])
    expect(state.hydrated).toBe(false)
  })

  it('hydrate marca hydrated y expone las entradas del módulo', async () => {
    await useHistory.getState().hydrate()

    const state = useHistory.getState()
    expect(state.hydrated).toBe(true)
    expect(state.entries).toEqual([])
  })

  it('record persiste y refleja la entrada en el estado reactivo', async () => {
    await useHistory.getState().hydrate()
    await useHistory.getState().record({
      actionId: 'pdf.split',
      kind: 'pdf',
      config: { mode: 'ranges' },
    })

    const entries = useHistory.getState().entries
    expect(entries).toHaveLength(1)
    expect(entries[0].actionId).toBe('pdf.split')
    expect(entries[0].count).toBe(1)

    // Coincide con la fuente de verdad del módulo.
    expect((await list('pdf')).map((entry) => entry.actionId)).toEqual(['pdf.split'])
  })

  it('clear vacía el estado y el almacenamiento del módulo', async () => {
    await useHistory.getState().hydrate()
    await useHistory.getState().record({ actionId: 'pdf.merge', kind: 'pdf', config: {} })
    expect(useHistory.getState().entries).toHaveLength(1)

    await useHistory.getState().clear()

    expect(useHistory.getState().entries).toEqual([])
    expect(await list()).toEqual([])
  })

  it('record antes de hidratar sigue reflejando la entrada', async () => {
    await useHistory.getState().record({ actionId: 'pdf.compress', kind: 'pdf', config: {} })

    expect(useHistory.getState().entries.map((entry) => entry.actionId)).toEqual(['pdf.compress'])
  })
})
