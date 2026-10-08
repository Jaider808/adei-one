import { Fragment } from 'react'

import { cn } from '@/lib/utils'

interface StepsProps {
  steps: string[]
  /** Paso actual, 0-based. */
  current: number
}

/**
 * Steps — stepper horizontal compacto.
 * Dot + label (solo sm+) + conector flexible entre pasos.
 */
export function Steps({ steps, current }: StepsProps) {
  return (
    <ol aria-label="Progreso de pasos" className="flex items-center gap-2">
      {steps.map((label, index) => {
        const passed = index < current
        const active = index === current
        return (
          <Fragment key={`${label}-${index}`}>
            <li
              className="flex min-w-0 items-center gap-1.5"
              aria-current={active ? 'step' : undefined}
              aria-label={`Paso ${index + 1}: ${label}`}
              title={label}
            >
              <span
                aria-hidden="true"
                className={cn(
                  'size-2.5 shrink-0 rounded-full transition-transform duration-200',
                  (passed || active) && 'bg-primary',
                  active && 'ring-2 ring-ring/50 scale-125',
                  !passed && !active && 'bg-muted',
                )}
              />
              <span
                className={cn(
                  'hidden truncate text-xs sm:inline',
                  passed || active
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                {label}
              </span>
            </li>
            {index < steps.length - 1 && (
              <span
                aria-hidden="true"
                className="h-px min-w-3 flex-1 rounded-full bg-border"
              />
            )}
          </Fragment>
        )
      })}
    </ol>
  )
}

export type { StepsProps }