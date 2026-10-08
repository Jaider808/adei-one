import { create } from 'zustand'
import type { Action, Artifact } from '@/core/types'

interface WorkspaceState {
  artifact: Artifact | null
  selectedAction: Action | null
  setArtifact: (artifact: Artifact | null) => void
  selectAction: (action: Action | null) => void
  reset: () => void
}

/**
 * Estado del workspace: el Artifact actual y la Action seleccionada.
 * Patrón slices de zustand (ver skill zustand-state-management).
 */
export const useWorkspace = create<WorkspaceState>()((set) => ({
  artifact: null,
  selectedAction: null,
  setArtifact: (artifact) => set({ artifact, selectedAction: null }),
  selectAction: (selectedAction) => set({ selectedAction }),
  reset: () => set({ artifact: null, selectedAction: null }),
}))