import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { motion } from 'motion/react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { PagePicker } from '@/tools/common/page-picker'
import { ReorderStrip } from '@/tools/common/reorder-strip'
import { usePdfPages } from '@/lib/pdf-render'
import {
  allPagesSelected,
  canSubmit,
  presetPages,
  splitSubmitLabel,
} from '@/tools/common/pages-form.utils'
import type { PagesFormKind } from '@/tools/common/pages-form.utils'
import type { ActionConfig, Artifact } from '@/core/types'

// Re-export del tipo para los consumers (evita círculos de imports).
export type { PagesFormKind } from '@/tools/common/pages-form.utils'

const HINTS: Record<PagesFormKind, string> = {
  split: 'Marca las páginas que quieres RECORTAR. Solo se descargan las marcadas.',
  delete: 'Marca las páginas que quieres ELIMINAR (quedan atenuadas).',
  reorder:
    'Ordena arrastrando las fichas. Toca una página de "Restantes" para añadirla; las que dejes fuera van al final.',
}

interface PagesFormProps {
  kind: PagesFormKind
  artifact: Artifact
  onSubmit: (config: ActionConfig) => void
}

/**
 * Formulario VISUAL de páginas, compartido por Recortar PDF / Eliminar / Reordenar:
 * en vez de escribir "2,5-7", se marcan/desmarcan páginas tocando miniaturas,
 * con presets Pares/Impares/Todas que REEMPLAZAN la selección. Al marcar el
 * documento completo en 'split' se fuerza salida ZIP (un PDF por página).
 */
export function PagesForm({ kind, artifact, onSubmit }: PagesFormProps) {
  const { pageCount, totalPages, thumbs, status } = usePdfPages(artifact.file)
  const [selected, setSelected] = useState<number[]>([])
  const [output, setOutput] = useState<'unido' | 'separado'>('unido')
  const [touched, setTouched] = useState(false)

  const knownPages = pageCount ?? 0
  const loading = status === 'loading' || status === 'idle'
  const ready = !loading && status === 'ready' && knownPages > 0

  // Reordenar arranca con el orden natural (1..N) la primera vez que el PDF está
  // listo; `touched` evita re-llenar si el usuario limpia la selección después.
  useEffect(() => {
    if (kind === 'reorder' && ready && !touched && knownPages > 0) {
      setSelected(Array.from({ length: knownPages }, (_, i) => i + 1))
      setTouched(true)
    }
  }, [kind, ready, knownPages, touched])

  const allSelected = allPagesSelected(selected, knownPages)
  // Con el documento completo solo tiene sentido partirlo por página (ZIP).
  const effectiveOutput: 'unido' | 'separado' = allSelected ? 'separado' : output

  function handleToggle(page: number) {
    setSelected((prev) => (prev.includes(page) ? prev.filter((p) => p !== page) : [...prev, page]))
  }

  const isValid = ready && canSubmit(kind, selected.length, knownPages)

  const submitLabel =
    kind === 'split'
      ? splitSubmitLabel(selected.length, effectiveOutput)
      : kind === 'delete'
        ? `Eliminar ${selected.length} página${selected.length === 1 ? '' : 's'}`
        : 'Aplicar orden'

  // Explica por qué el botón está deshabilitado (solo cuando el PDF está listo).
  const validationMessage =
    kind === 'delete'
      ? selected.length === 0
        ? 'Selecciona las páginas a eliminar.'
        : 'No puedes eliminar todas las páginas.'
      : 'Selecciona al menos una página.'

  function handleSubmit() {
    if (!isValid) return
    if (kind === 'split') onSubmit({ pages: selected, output: effectiveOutput })
    else if (kind === 'delete') onSubmit({ pages: selected })
    else onSubmit({ order: selected })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col gap-4"
    >
      {loading ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="aspect-[3/4] rounded-lg" />
          ))}
        </div>
      ) : !ready ? (
        <Alert className="flex flex-col items-start gap-2">
          <AlertTitle>No se pudo previsualizar el PDF</AlertTitle>
          <AlertDescription>La vista de páginas no está disponible para este archivo.</AlertDescription>
        </Alert>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{HINTS[kind]}</p>

          {(totalPages ?? knownPages) > knownPages && (
            <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
              Documento largo: se muestran las primeras {knownPages} de {totalPages} páginas. Las
              operaciones se aplican sobre estas páginas.
            </p>
          )}

          {kind === 'reorder' ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-foreground">
                  Tu orden ({selected.length} de {knownPages})
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSelected(Array.from({ length: knownPages }, (_, i) => i + 1))
                  }
                >
                  <RotateCcw className="size-3.5" data-icon="inline-start" />
                  Restablecer
                </Button>
              </div>

              {selected.length > 0 ? (
                <ReorderStrip
                  order={selected}
                  thumbs={thumbs}
                  onReorder={setSelected}
                  onRemove={(page) =>
                    setSelected((prev) => prev.filter((p) => p !== page))
                  }
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Aún no hay páginas en el orden.
                </p>
              )}

              {selected.length < knownPages && (
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">
                    Restantes (toca para añadir al orden):
                  </p>
                  <PagePicker
                    pageCount={knownPages}
                    totalPages={totalPages ?? knownPages}
                    thumbs={thumbs}
                    selected={[]}
                    hidden={selected}
                    onToggle={(page) =>
                      setSelected((prev) => (prev.includes(page) ? prev : [...prev, page]))
                    }
                    variant="select"
                  />
                </div>
              )}
            </div>
          ) : (
            <PagePicker
              pageCount={knownPages}
              totalPages={totalPages ?? knownPages}
              thumbs={thumbs}
              selected={selected}
              onToggle={handleToggle}
              variant={kind === 'delete' ? 'delete' : 'select'}
            />
          )}

          {kind === 'split' && (
            <div className="flex flex-wrap gap-2">
              {(['pares', 'impares', 'todas'] as const).map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSelected(presetPages(preset, knownPages))}
                >
                  {preset === 'todas' ? 'Todas' : preset === 'pares' ? 'Pares' : 'Impares'}
                </Button>
              ))}
            </div>
          )}

          {kind === 'split' &&
            (allSelected ? (
              // Todas las páginas mostradas: el ToggleGroup es redundante (no hay
              // "un solo PDF" que recortar); se informa y se fuerza salida ZIP.
              <p className="text-xs text-muted-foreground">
                Has seleccionado todas las páginas mostradas ({selected.length}) → se generará
                un PDF por página (ZIP).
              </p>
            ) : (
              <ToggleGroup
                type="single"
                variant="outline"
                value={output}
                onValueChange={(value) => {
                  if (value === 'unido' || value === 'separado') setOutput(value)
                }}
                className="justify-start"
              >
                <ToggleGroupItem value="unido">En un solo PDF</ToggleGroupItem>
                <ToggleGroupItem value="separado">Un PDF por página (ZIP)</ToggleGroupItem>
              </ToggleGroup>
            ))}

          {ready && selected.length > 0 && kind !== 'reorder' && (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                {selected.length} seleccionada{selected.length === 1 ? '' : 's'}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelected([])}
              >
                Limpiar
              </Button>
            </div>
          )}

          {ready && !isValid && (
            <p aria-live="polite" className="text-xs text-destructive">
              {validationMessage}
            </p>
          )}

          <Button onClick={handleSubmit} disabled={!isValid}>
            {submitLabel}
          </Button>
        </>
      )}
    </motion.div>
  )
}