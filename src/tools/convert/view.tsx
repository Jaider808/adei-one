/**
 * ADEI-ONE — Vista de "Convertir archivo" (`convert.any`).
 * Muestra el archivo origen (icono + nombre + tipo + tamaño) y SOLO las
 * conversiones posibles para su tipo como tarjetas clicables; cada tarjeta
 * incluye la descripción de lo que hace. Sin estado: clic → `onSubmit({ to })`.
 */
import { FileText, RefreshCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/utils'
import { conversionsFor } from './engine'
import type { ActionConfig, ToolViewProps } from '@/core/types'

export function ConvertView({ artifact, onSubmit }: ToolViewProps) {
  const options = conversionsFor(artifact.kind)

  return (
    <div className="flex flex-col gap-4">
      {/* Archivo origen */}
      <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
        <FileText className="size-8 shrink-0 text-muted-foreground" data-icon="file" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">{artifact.name}</p>
          <p className="font-mono text-xs text-muted-foreground">
            {artifact.kind} · {formatBytes(artifact.size)}
          </p>
        </div>
        <RefreshCcw className="size-4 shrink-0 text-muted-foreground" data-icon="convert" />
      </div>

      {options.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          Todavía no hay conversiones para este tipo de archivo.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Convierte a…
          </p>
          {options.map((option) => (
            <Button
              key={option.id}
              type="button"
              variant="outline"
              className="h-auto justify-start gap-3 px-3 py-2.5"
              onClick={() => onSubmit({ to: option.id } as ActionConfig)}
            >
              <span className="text-sm font-medium text-foreground">{option.label}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                .{option.ext}
              </span>
              <span className="min-w-0 flex-1 text-left text-xs text-muted-foreground">
                {option.description}
              </span>
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}