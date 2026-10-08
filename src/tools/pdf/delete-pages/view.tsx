/**
 * ADEI-ONE — Vista de "Eliminar páginas": compone el formulario compartido de
 * páginas. `kind="delete"` marca en modo borrar (las elegidas quedan atenuadas).
 */
import { PagesForm } from '@/tools/common/pages-form'
import type { ActionConfig, ToolViewProps } from '@/core/types'

export function DeletePagesView({ artifact, onSubmit }: ToolViewProps) {
  return <PagesForm kind="delete" artifact={artifact} onSubmit={(c: ActionConfig) => onSubmit(c)} />
}