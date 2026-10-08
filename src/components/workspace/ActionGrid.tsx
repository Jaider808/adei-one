import { SearchX } from 'lucide-react'
import { motion, type Variants } from 'motion/react'
import type { Action } from '@/core/types'
import { ActionCard } from './ActionCard'

interface ActionGridProps {
  actions: Action[]
  onSelect: (action: Action) => void
}

const gridVariants: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.03, delayChildren: 0.03 },
  },
}

const emptyVariants: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
  },
}

/** Cuadrícula de herramientas del catálogo con stagger de entrada por fila. */
export function ActionGrid({ actions, onSelect }: ActionGridProps) {
  if (actions.length === 0) {
    return (
      <motion.div
        variants={emptyVariants}
        initial="hidden"
        animate="show"
        className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/40 px-6 py-16 text-center"
      >
        <SearchX className="size-10 text-muted-foreground" aria-hidden />
        <p className="max-w-xs text-sm leading-relaxed text-muted-foreground">
          No hay herramientas para este tipo de archivo todavía
        </p>
      </motion.div>
    )
  }

  return (
    <motion.div
      variants={gridVariants}
      initial="hidden"
      animate="show"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    >
      {actions.map((action, i) => (
        <ActionCard key={action.id} action={action} onSelect={onSelect} index={i} />
      ))}
    </motion.div>
  )
}