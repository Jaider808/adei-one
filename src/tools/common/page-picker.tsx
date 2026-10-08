import { Check, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'

type PagePickerVariant = 'select' | 'delete' | 'order'

interface PagePickerProps {
  pageCount: number
  totalPages: number
  thumbs: (string | null)[]
  /** Páginas marcadas (1-indexed). En modo 'order' es la secuencia elegida. */
  selected: number[]
  onToggle: (page: number) => void
  variant?: PagePickerVariant
  disabled?: boolean
  /** Páginas que NO se renderizan (p. ej. en el pool de "pendientes" del reorder). */
  hidden?: number[]
}

/**
 * Selector visual de páginas: miniaturas numeradas (o tiles de número si aún no
 * hay thumbnail). Al tocar una página se marca/desmarca y CAMBIA SU OPACIDAD:
 * marcadas → atenuadas con anillo de acento + check (o papelera en modo 'delete').
 * Compartido por las tools de páginas de la categoría 'pdf'.
 */
export function PagePicker({
  pageCount,
  totalPages,
  thumbs,
  selected,
  onToggle,
  variant = 'select',
  disabled,
  hidden,
}: PagePickerProps) {
  const selectedSet = new Set(selected)
  const hiddenSet = new Set(hidden ?? [])
  const showAll = totalPages > pageCount

  return (
    <div className="flex flex-col gap-2.5">
      {showAll && (
        <p className="text-xs text-muted-foreground">
          Mostrando las primeras {pageCount} de {totalPages} páginas.
        </p>
      )}

      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
        {Array.from({ length: pageCount }, (_, i) => i + 1)
          .filter((page) => !hiddenSet.has(page))
          .map((page) => {
          const isSelected = selectedSet.has(page)
          const thumb = thumbs[page - 1]
          const position = variant === 'order' ? selected.indexOf(page) + 1 : 0
          const MarkIcon = variant === 'delete' ? Trash2 : Check

          return (
            <button
              key={page}
              type="button"
              onClick={() => onToggle(page)}
              disabled={disabled}
              aria-pressed={isSelected}
              aria-label={
                variant === 'order' && position > 0
                  ? `Página ${page}, posición ${position} en el orden`
                  : `Página ${page}${isSelected ? ', marcada' : ''}`
              }
              title={`Página ${page}`}
              className={cn(
                'group relative aspect-[3/4] overflow-hidden rounded-lg border text-left transition-[opacity,transform] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                isSelected
                  ? 'border-primary opacity-60 ring-2 ring-primary'
                  : 'border-border hover:-translate-y-0.5 hover:border-primary/50',
              )}
            >
              {thumb ? (
                <img src={thumb} alt="" className="size-full object-cover" draggable={false} />
              ) : (
                <span className="flex size-full items-center justify-center bg-muted">
                  <span className="font-mono text-2xl font-medium text-muted-foreground">
                    {page}
                  </span>
                </span>
              )}

              {isSelected && (
                <span
                  aria-hidden="true"
                  className="absolute inset-0 flex items-center justify-center bg-background/30"
                >
                  <span
                    className={cn(
                      'flex size-7 items-center justify-center rounded-full shadow-sm',
                      variant === 'delete'
                        ? 'bg-destructive text-white'
                        : 'bg-primary text-primary-foreground',
                    )}
                  >
                    <MarkIcon className="size-3.5" />
                  </span>
                </span>
              )}

              <span className="absolute left-1 top-1 rounded-full bg-foreground/80 px-1.5 font-mono text-[10px] leading-4 text-background">
                {position > 0 ? `#${position}` : page}
              </span>

              {!isSelected && variant === 'delete' && (
                <span className="absolute right-1 top-1 text-[10px] leading-4 text-destructive opacity-70">
                  ✕
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}