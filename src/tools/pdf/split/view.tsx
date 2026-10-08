/**
 * ADEI-ONE — Vista de "Dividir PDF": compone el formulario compartido de páginas.
 * `kind="split"` muestra presets (pares/impares/todas) y el toggle unido/ZIP.
 */
import { PagesForm } from '@/tools/common/pages-form'
import type { ActionConfig, ToolViewProps } from '@/core/types'

export function SplitView({ artifact, onSubmit }: ToolViewProps) {
  return <PagesForm kind="split" artifact={artifact} onSubmit={(c: ActionConfig) => onSubmit(c)} />
}