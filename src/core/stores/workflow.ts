import { create } from 'zustand'
import type { Artifact, ProgressEvent } from '@/core/types'

export type WorkflowStep = 'idle' | 'config' | 'running' | 'done' | 'error'

interface WorkflowState {
  step: WorkflowStep
  progress: ProgressEvent | null
  result: Artifact | null
  error: string | null
  setStep: (step: WorkflowStep) => void
  setProgress: (progress: ProgressEvent) => void
  setResult: (result: Artifact) => void
  setError: (error: string) => void
  reset: () => void
}

/** Estado del Workflow: paso actual, progreso y resultado. */
export const useWorkflow = create<WorkflowState>()((set) => ({
  step: 'idle',
  progress: null,
  result: null,
  error: null,
  setStep: (step) => set({ step }),
  setProgress: (progress) => set({ progress }),
  setResult: (result) => set({ step: 'done', result, progress: null }),
  setError: (error) => set({ step: 'error', error, progress: null }),
  reset: () => set({ step: 'idle', progress: null, result: null, error: null }),
}))