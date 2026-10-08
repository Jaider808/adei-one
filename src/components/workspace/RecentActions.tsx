import { useMemo } from 'react'
import { History, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CATALOG } from '@/core/catalog'
import { useHistory } from '@/core/stores/history'
import { hasProcessor } from '@/tools/registry'
import type { Action, FileKind } from '@/core/types'

/** Índice id→Action para resolver las entradas sin recorrer el catálogo. */
const ACTION_BY_ID = new Map<string, Action>(CATALOG.map((action) => [action.id, action]))

interface RecentActionsProps {
  /** Formato actual; solo se muestran las acciones ejecutadas sobre él. */
  kind: FileKind
  onSelect: (action: Action) => void
  /** Máximo de chips visibles (los más recientes primero). */
  limit?: number
}

/**
 * Fila compacta de "Recientes": las últimas acciones ejecutadas sobre el
 * formato actual, con un acceso directo para repetirlas. Se omiten las
 * acciones sin motor (`hasProcessor`) y no se renderiza nada si no hay
 * historial. Incluye "Borrar historial" como escape explícito de privacidad.
 */
export function RecentActions({ kind, onSelect, limit = 6 }: RecentActionsProps) {
  const entries = useHistory((state) => state.entries)
  const clear = useHistory((state) => state.clear)

  const actions = useMemo(() => {
    const seen = new Set<string>()
    const result: Action[] = []
    for (const entry of entries) {
      if (entry.kind !== kind || seen.has(entry.actionId)) continue
      const action = ACTION_BY_ID.get(entry.actionId)
      if (!action || !hasProcessor(action.id)) continue
      seen.add(entry.actionId)
      result.push(action)
      if (result.length >= limit) break
    }
    return result
  }, [entries, kind, limit])

  if (actions.length === 0) return null

  async function handleClear() {
    await clear()
    toast.success('Historial borrado')
  }

  return (
    <section aria-label="Acciones recientes" className="flex flex-col gap-2 border-b border-border/60 pb-3">
      <div className="flex items-center gap-2">
        <History className="size-3.5 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-medium">Recientes</h3>
        <Badge variant="secondary" className="rounded-full px-1.5 text-[10px]">
          {actions.length}
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            void handleClear()
          }}
          aria-label="Borrar historial"
          className="ml-auto gap-1.5 px-2 text-muted-foreground hover:text-foreground"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          Borrar historial
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {actions.map((action) => {
          const Icon = action.icon
          return (
            <Button
              key={action.id}
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onSelect(action)}
              aria-label={`Volver a usar ${action.name}`}
              className="gap-1.5 rounded-full"
            >
              <Icon className="size-3.5" aria-hidden="true" />
              {action.name}
            </Button>
          )
        })}
      </div>
    </section>
  )
}
