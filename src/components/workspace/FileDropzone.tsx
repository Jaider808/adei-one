import { useCallback, useRef, useState, type DragEvent } from 'react'
import { Upload } from 'lucide-react'
import { motion } from 'motion/react'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface FileDropzoneProps {
  onFile: (file: File) => void
  className?: string
  compact?: boolean
}

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1]
const FLOAT = {
  y: [0, -10, 0],
  transition: { duration: 5.5, repeat: Infinity, ease: 'easeInOut' as const },
}

/**
 * Zona de carga de archivos: arrastrar y soltar o elegir desde el file system.
 * `compact` renderiza una fila pequeña; por defecto, una zona grande centrada.
 */
export function FileDropzone({ onFile, className, compact }: FileDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)

  const openPicker = useCallback(() => {
    inputRef.current?.click()
  }, [])

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0]
      if (file) onFile(file)
    },
    [onFile]
  )

  const handleDragEnter = (e: DragEvent<HTMLButtonElement>) => {
    if (e.dataTransfer.types.includes('Files')) setDragging(true)
  }

  const handleDragOver = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }

  const handleDragLeave = (e: DragEvent<HTMLButtonElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false)
  }

  const handleDrop = (e: DragEvent<HTMLButtonElement>) => {
    e.preventDefault()
    setDragging(false)
    handleFiles(e.dataTransfer.files)
  }

  const sharedInput = (
    <input
      ref={inputRef}
      type="file"
      accept="*"
      className="sr-only"
      onChange={(e) => {
        handleFiles(e.target.files)
        e.target.value = ''
      }}
    />
  )

  if (compact) {
    return (
      <div className={cn('inline-flex items-center gap-3', className)}>
        {sharedInput}
        <Button type="button" variant="secondary" onClick={openPicker}>
          <Upload className="size-4" aria-hidden />
          Elegir archivo
        </Button>
        <span className="hidden text-sm text-muted-foreground sm:inline">
          PDF · Imágenes · Audio · Video…
        </span>
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, ease: EASE }}
      className={cn(className)}
    >
      <button
        type="button"
        onClick={openPicker}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        aria-label="Arrastra tu archivo aquí o elige uno de tu dispositivo"
        className={cn(
          'group flex w-full h-100 flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-border bg-card/40 px-6 py-14 text-center transition-colors duration-300',
          'hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          dragging && 'border-primary bg-primary/5'
        )}
      >
        {sharedInput}
        <motion.span
          animate={FLOAT}
          className="flex size-16 items-center justify-center rounded-2xl bg-accent text-primary"
          aria-hidden
        >
          <Upload className="size-8" />
        </motion.span>
        <span className="flex flex-col items-center gap-1.5">
          <span className="font-display text-lg font-semibold text-foreground">
            Arrastra tu archivo aquí
          </span>
          <span className="text-sm text-muted-foreground">
            PDF · Imágenes · Audio · Video · DOCX · XLSX · CSV…
          </span>
        </span>
        <span
          className={cn(buttonVariants({ variant: 'secondary' }), 'pointer-events-none')}
        >
          Elegir archivo
        </span>
      </button>
    </motion.div>
  )
}