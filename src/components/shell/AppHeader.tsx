import { FileText } from 'lucide-react'
import { motion } from 'motion/react'
import { ThemeToggle } from '@/components/theme/ThemeToggle'
import { PrivacyBadge } from '@/components/shell/PrivacyBadge'

/**
 * Chrome superior de ADEI-ONE (modo workspace): logo + privacidad + tema.
 * Sin navegación de secciones: la app vive en una sola pantalla h-dvh.
 */
export function AppHeader() {
  return (
    <motion.header
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: 'easeOut' }}
      className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur"
    >
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 md:px-6">
        <a
          href="#top"
          aria-label="ADEI-ONE — volver al inicio"
          className="group inline-flex items-center gap-2.5 rounded-sm"
        >
          <span className="flex size-8 items-center justify-center rounded-xl bg-linear-to-br from-primary to-primary/70 transition-transform duration-200 group-hover:scale-105">
            <FileText className="size-4 text-primary-foreground" aria-hidden="true" />
          </span>
          <span className="font-display text-lg font-semibold tracking-tight">
            ADEI<span className="text-primary">-ONE</span>
          </span>
        </a>

        <div className="flex items-center gap-2">
          <PrivacyBadge />
          <ThemeToggle />
        </div>
      </div>
    </motion.header>
  )
}