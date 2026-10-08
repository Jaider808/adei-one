import { create } from 'zustand'

import * as history from '@/core/history'
import type { HistoryEntry, HistoryRecordInput } from '@/core/history'

interface HistoryState {
  /** Entradas hidratadas desde el módulo (más recientes primero). */
  entries: HistoryEntry[]
  /** `true` una vez que `hydrate()` leyó el almacenamiento. */
  hydrated: boolean
  /** Carga el historial del módulo y se suscribe a sus cambios. */
  hydrate: () => Promise<void>
  /** Registra una ejecución y refresca las entradas reactivas. */
  record: (input: HistoryRecordInput) => Promise<void>
  /** Vacía el historial (memoria + almacenamiento) y refresca el estado. */
  clear: () => Promise<void>
}

/**
 * Store reactivo del historial "Recientes".
 *
 * NO usa el middleware `persist`: el módulo `@/core/history` es dueño del
 * almacenamiento (Cache Storage con fallback), y el store solo hidrata y
 * refleja. Así la política de privacidad (caché desechable, secretos fuera)
 * vive en un único lugar.
 */
export const useHistory = create<HistoryState>()((set) => {
  let unsubscribe: (() => void) | null = null

  function refresh(): void {
    void history.list().then((entries) => set({ entries }))
  }

  return {
    entries: [],
    hydrated: false,

    hydrate: async () => {
      const entries = await history.list()
      // Una sola suscripción al módulo, aunque `hydrate()` se llame varias veces.
      if (!unsubscribe) unsubscribe = history.subscribe(refresh)
      set({ entries, hydrated: true })
    },

    record: async (input) => {
      await history.record(input)
      set({ entries: await history.list() })
    },

    clear: async () => {
      await history.clear()
      set({ entries: [] })
    },
  }
})
