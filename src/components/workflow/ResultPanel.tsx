import { CircleCheckBig, Download, TriangleAlert } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { Artifact, VerificationResult } from '@/core/types'
import { formatBytes } from '@/lib/utils'

interface ResultPanelProps {
  artifact: Artifact
  onDownload: (artifact: Artifact) => void
  onRestart: () => void
  /** Verificación posterior a la limpieza (opcional; solo `meta.strip` la rellena). */
  verification?: VerificationResult
}

/** Texto del aviso de restos: recuento + muestra corta de etiquetas. */
function remainingText(verification: VerificationResult): string {
  const count = verification.remaining ?? 0
  const noun = count === 1 ? 'dato' : 'datos'
  const sample = verification.sample?.length ? `: ${verification.sample.join(', ')}` : ''
  return `Quedan ${count} ${noun} sin eliminar${sample}.`
}

/**
 * ResultPanel — presentacional. El padre gestiona la descarga real;
 * aquí solo se muestra el resultado y se delegan las acciones.
 * Si la verificación detecta restos (o no se pudo comprobar), se avisa inline;
 * con `clean` o sin verificación no se pinta nada (sin ruido).
 */
export function ResultPanel({ artifact, onDownload, onRestart, verification }: ResultPanelProps) {
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

        {verification?.status === 'remaining' ? (
          <Alert className="border-warning/40 bg-warning/10 text-warning-foreground">
            <TriangleAlert className="size-4 text-warning" aria-hidden="true" />
            <AlertTitle>Quedan datos sin eliminar</AlertTitle>
            <AlertDescription>{remainingText(verification)}</AlertDescription>
          </Alert>
        ) : null}

        {verification?.status === 'unverifiable' ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            No se pudo verificar el resultado: revisa el archivo descargado.
          </p>
        ) : null}

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
