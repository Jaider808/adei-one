import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import {
  ChevronDown,
  FileQuestion,
  Files,
  Lightbulb,
  RefreshCcw,
  SearchX,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FileDropzone } from '@/components/workspace/FileDropzone'
import { ActionCard } from '@/components/workspace/ActionCard'
import { FileBadge } from '@/components/workspace/FileBadge'
import { VisualGuide } from '@/components/home/VisualGuide'
import { ToolWorkspace } from '@/components/home/ToolWorkspace'

import {
  CATALOG,
  CATEGORY_HOW_IT_WORKS,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  CATEGORY_SUBTITLES,
  actionsForKind,
  groupByCategory,
} from '@/core/catalog'
import { detectKind, detectKindByMagic } from '@/core/detect'
import { useWorkspace } from '@/core/stores/workspace'
import { cn } from '@/lib/utils'

const IMAGE_KINDS = new Set(['jpg', 'png', 'webp', 'gif', 'tiff', 'heic', 'svg'])

const TRUST = [
  { icon: ShieldCheck, label: 'Sin servidores' },
  { icon: Zap, label: 'WebGPU / WASM' },
  { icon: Trash2, label: 'Sin rastro' },
] as const

const EASE = [0.22, 1, 0.36, 1] as const

/**
 * Pantalla principal (h-dvh, sin footer):
 * - SIN archivo: subida CENTRADA (título + dropzone rodeado por la guía animada).
 * - CON archivo: el panel de subir se desliza a la izquierda (morph `layout`) y a la
 *   derecha aparecen las categorías admitidas por el formato (lista plana con sus
 *   cards). Al elegir una card, la herramienta crece in-place ocupando el panel hasta
 *   el título "Qué puedes hacer", con botón "Volver" arriba-izquierda.
 */
export function WorkspaceScreen() {
  const { artifact, setArtifact, selectedAction, selectAction, reset } = useWorkspace()
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!artifact?.file || !IMAGE_KINDS.has(artifact.kind)) {
      setPreviewUrl(null)
      return
    }
    const url = URL.createObjectURL(artifact.file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [artifact])

  const grouped = useMemo(() => {
    const source = artifact ? actionsForKind(artifact.kind) : CATALOG
    return groupByCategory(source)
  }, [artifact])

  const presentCategories = CATEGORY_ORDER.filter((cat) => (grouped.get(cat)?.length ?? 0) > 0)

  async function handleFile(file: File) {
    const byMagic = await detectKindByMagic(file)
    const kind = byMagic !== 'unknown' ? byMagic : detectKind(file)
    if (kind === 'unknown') {
      toast.error('No reconocemos este tipo de archivo todavía')
      return
    }
    setArtifact({
      id: crypto.randomUUID(),
      name: file.name,
      kind,
      size: file.size,
      source: 'file',
      file,
    })
  }

  /** Volver desde una herramienta: vuelve a la lista de categorías del formato. */
  function backFromTool() {
    selectAction(null)
  }

  return (
    <div className="flex flex-wrap justify-center w-full h-full">
      {/* ---------- IZQUIERDA: subir (centrado) / vista previa ---------- */}
      <motion.section
        layout
        transition={{ layout: { type: 'spring', stiffness: 240, damping: 30 } }}
        aria-label={artifact ? 'Archivo' : 'Subir archivo'}
        className={cn(
          'flex flex-col gap-6 p-6 md:p-8',
          artifact
            ? 'border-b border-border lg:w-130 lg:overflow-y-auto lg:border-r lg:border-b-0'
            : 'items-center justify-center',
        )}
      >
        {!artifact ? (
          <motion.div
            key="upload"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="my-auto flex max-w-4xl flex-col items-center gap-7 text-center"
          >
            <div className="flex flex-col items-center gap-2.5">
              <h1 className="font-display text-3xl font-semibold tracking-tight text-balance md:text-5xl">
                Sube tu archivo
              </h1>
              <p className="max-w-md text-sm text-muted-foreground">
                Te mostramos qué puedes hacer con él. Todo en tu navegador.
              </p>
            </div>

            {/* Guía visual animada (sin texto) que RODEA el área de subida */}
            <div className="relative mx-auto w-full">
              <VisualGuide />
              <FileDropzone onFile={handleFile} className="w-full" />
            </div>

            <ul className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
              {TRUST.map(({ icon: Icon, label }) => (
                <li
                  key={label}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <Icon className="size-3.5 text-primary" aria-hidden="true" />
                  {label}
                </li>
              ))}
            </ul>
          </motion.div>
        ) : (
          <motion.div
            key="preview"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: EASE }}
            className="my-auto flex w-full flex-col gap-5"
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Files className="size-4 text-primary" aria-hidden="true" />
              Archivo listo para procesar
            </div>

            <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5">
              {previewUrl ? (
                <div className="flex max-h-64 items-center justify-center overflow-hidden rounded-xl bg-muted">
                  <img
                    src={previewUrl}
                    alt={`Vista previa de ${artifact.name}`}
                    className="max-h-64 w-auto object-contain"
                  />
                </div>
              ) : (
                <div className="flex aspect-video items-center justify-center rounded-xl bg-muted">
                  <FileQuestion className="size-12 text-muted-foreground/60" aria-hidden="true" />
                </div>
              )}

              <FileBadge artifact={artifact} onClear={reset} className="flex-wrap" />
            </div>

            <Button variant="secondary" size="sm" onClick={reset} className="self-start">
              <RefreshCcw className="size-4" data-icon="inline-start" />
              Cambiar archivo
            </Button>
          </motion.div>
        )}
      </motion.section>

      {/* ---------- DERECHA: acciones posibles / herramienta ---------- */}
      {artifact && (
        <motion.section
          layout
          initial={{ opacity: 0, x: 48 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.45, ease: EASE }}
          aria-label="Acciones posibles"
          className="flex h-[calc(100dvh-55px)] flex-col gap-6 p-6 md:p-8 lg:flex-1 lg:overflow-hidden"
        >
          {selectedAction ? (
            <ToolWorkspace
              key={selectedAction.id}
              action={selectedAction}
              artifact={artifact}
              onBack={backFromTool}
            />
          ) : presentCategories.length === 0 ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border p-10 text-center">
              <SearchX className="size-8 text-muted-foreground/60" aria-hidden="true" />
              <p className="text-sm text-muted-foreground">
                Todavía no hay herramientas para este tipo de archivo.
              </p>
              <Button variant="outline" size="sm" onClick={reset}>
                Probar con otro archivo
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-2">
              <motion.div
                initial="hidden"
                animate="show"
                variants={{
                  hidden: {},
                  show: { transition: { staggerChildren: 0.05 } },
                }}
                className="flex flex-col gap-1.5"
              >
                <h1 className="font-display text-2xl font-semibold tracking-tight md:text-3xl">
                  Qué puedes hacer
                </h1>
                <p className="text-sm text-muted-foreground">
                  {selectedAction
                    ? 'Configura y ejecuta la herramienta.'
                    : `Con ${artifact.name} puedes realizar ${actionsForKind(artifact.kind).length} acciones.`}
                </p>
              </motion.div>

              <div className="flex flex-1 max-h-[calc(100dvh-170px)] flex-col gap-7 overflow-y-auto overscroll-contain">
                {presentCategories.map((category) => {
                  const actions = grouped.get(category) ?? []
                  return (
                    <div key={category} className="flex flex-col gap-3">

                      <div className="flex flex-col gap-0.5">
                        <div className="flex gap-2">
                          <h3 className="font-display text-lg font-semibold tracking-tight">
                            {CATEGORY_LABELS[category]}
                          </h3>
                          <Badge variant="secondary" className="shrink-0 rounded-full p-1 text-xs">
                            {actions.length}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {CATEGORY_SUBTITLES[category]}
                        </p>
                      </div>

                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {actions.map((action, index) => (
                          <ActionCard
                            key={action.id}
                            action={action}
                            index={index}
                            onSelect={selectAction}
                          />
                        ))}
                      </div>

                      {/* Transparencia: cómo funciona la categoría (pasos + tecnologías) */}
                      <details className="group rounded-lg border border-border/60 bg-muted/40 px-3 py-2">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground [&::-webkit-details-marker]:hidden hover:text-foreground">
                          <Lightbulb className="size-3.5 text-primary" aria-hidden="true" />
                          Cómo funciona
                          <ChevronDown
                            className="ml-auto size-3.5 transition-transform group-open:rotate-180"
                            aria-hidden="true"
                          />
                        </summary>

                        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                          {CATEGORY_HOW_IT_WORKS[category].what}
                        </p>

                        <ol className="mt-2 flex list-decimal flex-col gap-1 pl-5 text-xs text-muted-foreground">
                          {CATEGORY_HOW_IT_WORKS[category].steps.map((step) => (
                            <li key={step}>{step}</li>
                          ))}
                        </ol>

                        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] text-muted-foreground">Tecnología:</span>
                          {CATEGORY_HOW_IT_WORKS[category].tools.map((tool) => (
                            <Badge key={tool} variant="outline" className="text-[10px] font-normal">
                              {tool}
                            </Badge>
                          ))}
                          <Badge
                            variant="secondary"
                            className="gap-1 text-[10px] font-normal text-primary"
                          >
                            <ShieldCheck className="size-3" aria-hidden="true" />
                            100% local
                          </Badge>
                        </div>
                      </details>
                    </div>
                  )
                })}
              </div>
            </div>
            </>
          )}
        </motion.section>
      )}
    </div>
  )
}