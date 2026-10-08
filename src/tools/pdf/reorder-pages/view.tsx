/**
 * ADEI-ONE — Vista de "Reordenar páginas": compone el formulario compartido de
 * páginas. `kind="reorder"` marca el orden deseado tocando en secuencia.
 */
import { PagesForm } from '@/tools/common/pages-form'
import type { ActionConfig, ToolViewProps } from '@/core/types'

export function ReorderPagesView({ artifact, onSubmit }: ToolViewProps) {
  return <PagesForm kind="reorder" artifact={artifact} onSubmit={(c: ActionConfig) => onSubmit(c)} />
}