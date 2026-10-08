import { useMemo } from 'react'
import { ChevronRight, Cpu } from 'lucide-react'
import { motion, type Variants } from 'motion/react'
import { Badge } from '@/components/ui/badge'
import { hasProcessor } from '@/tools/registry'
import type { Action } from '@/core/types'
import { cn } from '@/lib/utils'

interface ActionCardProps {
  action: Action
  onSelect: (action: Action) => void
  index?: number
}

/** Entrada con fade-up; el delay por `index` genera el stagger entre tarjetas. */
function useCardVariants(index?: number): Variants {
  const delay = (index ?? 0) * 0.04
  return useMemo(
    () => ({
      hidden: { opacity: 0, y: 14 },
      show: {
        opacity: 1,
        y: 0,
        transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1], delay },
      },
    }),
    [delay],
  )
}

/**
 * Tarjeta de una herramienta: icono, nombre, descripción y categoría.
 * Si la tool aún no tiene motor real (registry), se muestra GRIS, bloqueada
 * (aria-disabled, sin onSelect) y con el badge "Próximamente" para distinguir
 * visualmente lo que ya funciona de lo que llega en fases futuras.
 */
export function ActionCard({ action, onSelect, index }: ActionCardProps) {
  const Icon = action.icon
  const variants = useCardVariants(index)
  const available = hasProcessor(action.id)

  return (
    <motion.button
      type="button"
      variants={variants}
      initial="hidden"
      animate="show"
      transition={{ type: 'spring', stiffness: 340, damping: 26 }}
      {...(available
        ? {
            whileHover: { y: -4 },
            whileTap: { scale: 0.98 },
            onClick: () => onSelect(action),
            'aria-label': action.name,
          }
        : {
            'aria-disabled': true,
            'aria-label': `${action.name}. Próximamente`,
            title: 'Próximamente',
          })}
      className={cn(
        'group relative flex flex-col gap-2 rounded-xl border p-4 text-left transition-shadow',
        available
          ? 'border-border bg-card shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background hover:shadow-md'
          : 'cursor-not-allowed border-muted bg-muted/50 text-muted-foreground',
      )}
    >
      {available ? (
        <ChevronRight
          className="absolute right-3 top-3 size-4 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          aria-hidden
        />
      ) : (
        <Badge
          variant="outline"
          className="absolute right-2 top-2 font-normal lowercase text-muted-foreground"
        >
          Próximamente
        </Badge>
      )}

      <span
        className={cn(
          'flex size-10 items-center justify-center rounded-lg',
          available ? 'bg-accent text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-5" aria-hidden />
      </span>

      <h3
        className={cn(
          'font-display text-sm font-medium leading-snug',
          available ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {action.name}
      </h3>

      <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
        {action.description}
      </p>

      <span className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <Badge variant="secondary" className="font-normal lowercase">
          {action.category}
        </Badge>
        {action.needsGpu && (
          <Badge variant="outline" className="gap-1 font-normal">
            <Cpu className="size-3" aria-hidden />
            GPU
          </Badge>
        )}
      </span>
    </motion.button>
  )
}