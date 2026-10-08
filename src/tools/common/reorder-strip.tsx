import { useState } from 'react'
import { GripVertical, X } from 'lucide-react'
import { moveInOrder } from '@/tools/common/pages-form.utils'
import { cn } from '@/lib/utils'

interface ReorderStripProps {
  /** Secuencia actual (páginas 1-indexed en el orden elegido). */
  order: number[]
  thumbs: (string | null)[]
  onReorder: (nextOrder: number[]) => void
  onRemove: (page: number) => void
}

/**
 * Fila de fichas ORDENADAS de "Reordenar PDF": arrastrar y soltar para mover,
 * cada ficha muestra su Nº DE PÁGINA ORIGINAL (identidad) arriba-izquierda y su
 * POSICIÓN ACTUAL (#N) arriba-derecha. Botón × para devolverla al pool.
 */
export function ReorderStrip({ order, thumbs, onReorder, onRemove }: ReorderStripProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  function handleDrop(index: number) {
    if (dragIndex === null || dragIndex === index) {
      setDragIndex(null)
      setOverIndex(null)
      return
    }
    onReorder(moveInOrder(order, dragIndex, index))
    setDragIndex(null)
    setOverIndex(null)
  }

  return (
    <div
      role="list"
      aria-label="Orden de páginas (arrastra para mover)"
      className="flex flex-wrap gap-2"
    >
      {order.map((page, index) => {
        const thumb = thumbs[page - 1]
        const isOver = overIndex === index
        return (
          <div
            key={page}
            role="listitem"
            draggable
            onDragStart={(e) => {
              setDragIndex(index)
              e.dataTransfer.effectAllowed = 'move'
              e.dataTransfer.setData('text/plain', String(page))
            }}
            onDragOver={(e) => {
              e.preventDefault()
              if (overIndex !== index) setOverIndex(index)
            }}
            onDragLeave={() => setOverIndex((cur) => (cur === index ? null : cur))}
            onDrop={(e) => {
              e.preventDefault()
              handleDrop(index)
            }}
            onDragEnd={() => {
              setDragIndex(null)
              setOverIndex(null)
            }}
            aria-label={`Página ${page}, posición ${index + 1}`}
            title={`Página ${page} — posición ${index + 1} (arrastra para mover)`}
            className={cn(
              'group relative aspect-[3/4] w-16 select-none overflow-hidden rounded-lg border sm:w-20',
              'cursor-grab active:cursor-grabbing',
              isOver && 'border-primary ring-2 ring-primary',
              dragIndex === index && 'opacity-50',
            )}
            onMouseUp={() => {
              // Evita que un clic simple sin arrastre deje estado residual.
              setDragIndex(null)
              setOverIndex(null)
            }}
          >
            {thumb ? (
              <img
                src={thumb}
                alt=""
                className="size-full object-cover"
                draggable={false}
              />
            ) : (
              <span className="flex size-full items-center justify-center bg-muted">
                <span className="font-mono text-xl font-medium text-muted-foreground">
                  {page}
                </span>
              </span>
            )}

            {/* Nº de página ORIGINAL (identidad: así sabes cuál moviste) */}
            <span className="absolute left-1 top-1 rounded-full bg-foreground/80 px-1.5 font-mono text-[10px] leading-4 text-background">
              {page}
            </span>

            {/* Posición ACTUAL en el orden */}
            <span className="absolute right-1 top-1 rounded-full bg-primary px-1.5 font-mono text-[10px] leading-4 text-primary-foreground">
              #{index + 1}
            </span>

            {/* Manija de arrastre + quitar */}
            <span className="absolute bottom-1 left-1 text-background/80" aria-hidden="true">
              <GripVertical className="size-3.5" />
            </span>
            <button
              type="button"
              onClick={() => onRemove(page)}
              aria-label={`Quitar la página ${page} del orden`}
              className="absolute bottom-1 right-1 rounded-full bg-background/80 p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}