import { CircleCheckBig, Download } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { Artifact } from '@/core/types'
import { formatBytes } from '@/lib/utils'

interface ResultPanelProps {
  artifact: Artifact
  onDownload: (artifact: Artifact) => void
  onRestart: () => void
}

/**
 * ResultPanel — presentacional. El padre gestiona la descarga real;
 * aquí solo se muestra el resultado y se delegan las acciones.
 */
export function ResultPanel({ artifact, onDownload, onRestart }: ResultPanelProps) {
  return (
    <Card className="rounded-xl border border-success/30 bg-card">
      <CardContent className="flex flex-col gap-5 p-6">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <CircleCheckBig className="size-6 text-success" aria-hidden="true" />
            <h3 className="font-display text-xl font-semibold tracking-tight">¡Listo!</h3>
          </div>
          <p className="text-sm text-muted-foreground">Resultado generado:</p>
          <div className="flex items-baseline justify-between gap-3">
            <p className="truncate font-mono text-sm font-medium" title={artifact.name}>
              {artifact.name}
            </p>
            <span className="shrink-0 font-mono text-xs text-muted-foreground">
              {formatBytes(artifact.size)}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            type="button"
            onClick={() => onDownload(artifact)}
            className="sm:flex-1"
            aria-label={`Descargar ${artifact.name}`}
          >
            <Download data-icon="inline-start" />
            Descargar
          </Button>
          <Button type="button" variant="ghost" onClick={onRestart}>
            Procesar otro archivo
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export type { ResultPanelProps }