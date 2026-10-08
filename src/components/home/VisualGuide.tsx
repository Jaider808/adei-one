import { motion } from 'motion/react'
import {
  ArrowDownToLine,
  FileText,
  ImageIcon,
  RefreshCcw,
  Scissors,
  ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/** Periodo del bucle (via repeatDelay) para que la secuencia lea como un paso a paso. */
const CYCLE = 5.2

/**
 * Guía visual "cómo funciona" que RODEA el área de subida — SIN texto.
 * Bucle animado alrededor del dropzone:
 *  1) el archivo entra y se suelta sobre la zona,
 *  2) aparecen las acciones posibles a los lados,
 *  3) se descarga el resultado abajo.
 * Capa decorativa: pointer-events-none, aria-hidden, sin layout propio.
 */
export function VisualGuide({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn('pointer-events-none absolute inset-0 select-none', className)}>
      {/* Halo central de ambiente */}
      <motion.span
        className="absolute left-1/2 top-1/2 size-48 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-2xl"
        animate={{ opacity: [0.35, 0.7, 0.35], scale: [1, 1.08, 1] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Archivo que entra desde arriba y se suelta sobre la zona */}
      <motion.span
        className="absolute left-2/5 top-30 flex size-12 -translate-x-1/2 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/30"
        animate={{ y: [-110, -86, -86, -110], opacity: [0, 1, 1, 0], scale: [0.9, 1, 1, 1] }}
        transition={{
          duration: 1.25,
          times: [0, 0.42, 0.82, 1],
          repeat: Infinity,
          repeatDelay: CYCLE - 1.25,
          delay: 0.35,
          ease: 'easeOut',
        }}
      >
        <FileText className="size-5" />
      </motion.span>

      {/* Acciones posibles alrededor */}
      <OrbitChip icon={Scissors} className="left-[6%] top-[14%]" delay={0.5} />
      <OrbitChip icon={ImageIcon} className="right-[4%] top-[20%]" delay={0.75} />
      <OrbitChip icon={RefreshCcw} className="bottom-[16%] left-[4%]" delay={1.0} />
      <OrbitChip icon={ShieldCheck} className="bottom-[10%] right-[8%]" delay={1.25} />

      {/* Descarga abajo */}
      <motion.span
        className="absolute bottom-6 left-1/2 flex size-11 -translate-x-1/2 items-center justify-center rounded-2xl bg-card text-primary shadow-lg shadow-primary/20 ring-1 ring-border"
        animate={{ y: [10, 0, 0, 10], opacity: [0, 1, 1, 0], scale: [0.85, 1, 1, 1] }}
        transition={{
          duration: 1.1,
          times: [0, 0.4, 0.8, 1],
          repeat: Infinity,
          repeatDelay: CYCLE - 1.1,
          delay: CYCLE * 0.62,
          ease: 'easeOut',
        }}
      >
        <ArrowDownToLine className="size-5" />
      </motion.span>
    </div>
  )
}

function OrbitChip({
  icon: Icon,
  className,
  delay,
}: {
  icon: typeof Scissors
  className?: string
  delay: number
}) {
  return (
    <motion.span
      className={cn(
        'absolute flex size-10 items-center justify-center rounded-xl bg-card text-muted-foreground shadow-md ring-1 ring-border',
        className,
      )}
      animate={{ scale: [0, 1, 1, 0], opacity: [0, 1, 1, 0], y: [8, 0, 0, 8] }}
      transition={{
        duration: 1.15,
        times: [0, 0.34, 0.76, 1],
        repeat: Infinity,
        repeatDelay: CYCLE - 1.15,
        delay,
        ease: 'easeOut',
      }}
    >
      <Icon className="size-5" />
    </motion.span>
  )
}