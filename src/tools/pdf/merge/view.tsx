/**
 * ADEI-ONE — Vista de "Unir PDFs": tool multiarchivo SIN schema.
 * El usuario acumula PDFs en una lista ordenada (subir/bajar/quitar) y el
 * botón "Unir N PDFs" entrega esos `File` como Artifacts en `onSubmit`.
 */
import { useRef, useState, type ChangeEvent } from 'react'
import { ChevronDown, ChevronUp, FileText, Plus, X } from 'lucide-react'
import { motion } from 'motion/react'
import { Button } from '@/components/ui/button'
import { formatBytes } from '@/lib/utils'
import type { ActionConfig, Artifact, ToolViewProps } from '@/core/types'

export function MergeView({ artifact, onSubmit }: ToolViewProps) {
  const [files, setFiles] = useState<File[]>(() => (artifact.file ? [artifact.file] : []))
  const inputRef = useRef<HTMLInputElement>(null)

  function openPicker() {
    inputRef.current?.click()
  }

  function handleChange(evt: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(evt.target.files ?? [])
    if (picked.length === 0) return
    setFiles((prev) => {
      // Elimina duplicados por (nombre, tamaño) frente a los ya listados.
      const existing = new Set(prev.map((f) => `${f.name}|${f.size}`))
      const fresh = picked.filter((f) => !existing.has(`${f.name}|${f.size}`))
      return [...prev, ...fresh]
    })
    // Limpia el input para poder volver a elegir el mismo archivo después.
    evt.target.value = ''
  }

  function moveUp(index: number) {
    setFiles((prev) => {
      if (index <= 0) return prev
      const next = [...prev]
      next[index] = next[index - 1]!
      next[index - 1] = prev[index]!
      return next
    })
  }

  function moveDown(index: number) {
    setFiles((prev) => {
      if (index >= prev.length - 1) return prev
      const next = [...prev]
      next[index] = next[index + 1]!
      next[index + 1] = prev[index]!
      return next
    })
  }

  function removeAt(index: number) {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }

  function handleSubmit() {
    if (files.length < 2) return
    const arts: Artifact[] = files.map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      kind: 'pdf',
      size: f.size,
      source: 'file',
      file: f,
    }))
    const config: ActionConfig = {}
    onSubmit(config, arts)
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col gap-4"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          El primer PDF de la lista encabeza el documento final.
        </p>
        <Button type="button" variant="outline" size="sm" onClick={openPicker}>
          <Plus className="size-3.5" data-icon="inline-start" />
          Añadir PDFs
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept="application/pdf"
        className="hidden"
        aria-label="Añadir PDFs"
        onChange={handleChange}
      />

      {files.length > 0 && (
        <ul className="flex flex-col gap-2">
          {files.map((f, i) => (
            <li
              key={`${f.name}|${f.size}`}
              className="flex items-center gap-2 rounded-lg border bg-card p-2"
            >
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                {f.name}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Subir ${f.name}`}
                onClick={() => moveUp(i)}
                disabled={i === 0}
              >
                <ChevronUp className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Bajar ${f.name}`}
                onClick={() => moveDown(i)}
                disabled={i === files.length - 1}
              >
                <ChevronDown className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Quitar ${f.name}`}
                onClick={() => removeAt(i)}
              >
                <X className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {files.length < 2 && (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          Añade al menos un PDF más para unir.
        </p>
      )}

      <Button type="button" onClick={handleSubmit} disabled={files.length < 2}>
        Unir {files.length} PDF{files.length === 1 ? '' : 's'}
      </Button>
    </motion.div>
  )
}