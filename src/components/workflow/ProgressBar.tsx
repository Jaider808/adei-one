import { CheckCheck } from 'lucide-react'

import { Progress } from '@/components/ui/progress'

interface ProgressBarProps {
  phase: string
  percent: number
}

/**
 * ProgressBar — fase + porcentaje con barra Radix ya estilizada.
 * Anuncia el estado a lectores de pantalla (role="status" + sr-only).
 */
export function ProgressBar({ phase, percent }: ProgressBarProps) {
  const rounded = Math.round(percent)
  const done = percent >= 100
  const clamped = Math.min(100, Math.max(0, percent))
  const announcement = done
    ? `Procesamiento completado: ${phase}`
    : `${phase}: ${rounded} %`

  return (
    <div role="status" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm font-medium">{phase}</span>
        {done ? (
          <CheckCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
        ) : (
          <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
            {rounded}%
          </span>
        )}
      </div>
      <Progress value={clamped} className="h-2" />
      <span className="sr-only">{announcement}</span>
    </div>
  )
}

export type { ProgressBarProps }