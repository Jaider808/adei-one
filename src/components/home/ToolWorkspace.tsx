import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Construction, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { Skeleton } from '@/components/ui/skeleton'
import { WizardForm } from '@/components/workflow/WizardForm'
import { ProgressBar } from '@/components/workflow/ProgressBar'
import { ResultPanel } from '@/components/workflow/ResultPanel'

import { CATEGORY_LABELS } from '@/core/catalog'
import { saveResult } from '@/core/ports'
import { useWorkflow } from '@/core/stores/workflow'
import { getToolView, hasProcessor, runTool } from '@/tools/registry'
import type { Action, ActionConfig, Artifact, FileKind, VerificationResult } from '@/core/types'

interface ToolWorkspaceProps {
  action: Action
  artifact: Artifact
  onBack: () => void
}

/** MIME con el que descargar el resultado según su FileKind. */
function mimeForKind(kind: FileKind): string {
  switch (kind) {
    case 'pdf':
      return 'application/pdf'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    case 'zip':
      return 'application/zip'
    case 'jpg':
      return 'image/jpeg'
    case 'png':
      return 'image/png'
    case 'webp':
      return 'image/webp'
    case 'gif':
      return 'image/gif'
    case 'svg':
      return 'image/svg+xml'
    case 'tiff':
      return 'image/tiff'
    case 'mp3':
      return 'audio/mpeg'
    case 'wav':
      return 'audio/wav'
    case 'flac':
      return 'audio/flac'
    case 'mp4':
      return 'video/mp4'
    case 'webm':
      return 'video/webm'
    case 'mkv':
      return 'video/x-matroska'
    case 'csv':
      return 'text/csv'
    case 'json':
      return 'application/json'
    case 'xml':
      return 'application/xml'
    case 'txt':
    case 'md':
      return 'text/plain'
    default:
      return 'application/octet-stream'
  }
}

/**
 * Cuerpo configuración de la tool: vista custom (lazy) o wizard genérico.
 * Usa `React.lazy` (refres-safe con HMR) en vez de guardar el componente en
 * estado; el loader llega del registro y resuelve a `{ default }`.
 */
function ToolBody({
  action,
  artifact,
  defaults,
  onSubmit,
}: {
  action: Action
  artifact: Artifact
  defaults?: Record<string, unknown>
  onSubmit: (config: ActionConfig, files?: Artifact[]) => void
}) {
  const LazyView = useMemo(() => {
    const loader = getToolView(action.id)
    return loader ? lazy(loader) : null
  }, [action.id])

  if (LazyView === null) {
    return (
      <WizardForm
        schema={action.schema}
        defaults={defaults}
        onSubmit={onSubmit}
        submitLabel="Continuar"
      />
    )
  }

  return (
    <Suspense fallback={<Skeleton className="h-40 w-full rounded-xl" />}>
      <LazyView action={action} artifact={artifact} onSubmit={onSubmit} />
    </Suspense>
  )
}

/**
 * Espacio de la herramienta seleccionada: crece in-place y ocupa casi todo el
 * panel derecho (bajo "Qué puedes hacer"):
 *  - arriba-izquierda: botón para volver a las categorías admitidas por el formato;
 *  - icono + título + subtítulo de la acción;
 *  - el resto del espacio es la UI propia de la herramienta (wizard → progreso → resultado).
 */
export function ToolWorkspace({ action, artifact, onBack }: ToolWorkspaceProps) {
  const {
    step,
    progress,
    result,
    error,
    setStep,
    setProgress,
    setResult,
    setError,
    reset: resetWorkflow,
  } = useWorkflow()

  // Verificación posterior a la limpieza devuelta por el motor (solo meta.strip).
  const [verification, setVerification] = useState<VerificationResult | undefined>(undefined)

  // Al montar la tool (padre usa key={action.id}): workflow limpio en 'config'.
  useEffect(() => {
    resetWorkflow()
    setStep('config')
    setVerification(undefined)
  }, [resetWorkflow, setStep])

  function handleBack() {
    resetWorkflow()
    setVerification(undefined)
    onBack()
  }

  async function handleSubmit(config: ActionConfig, files?: Artifact[]) {
    setStep('running')
    setProgress({ phase: 'Preparando', percent: 0 })
    try {
      const out = await runTool(action.id, { artifact, config, files }, { onProgress: setProgress })
      setVerification(out.verification)
      setResult({
        id: crypto.randomUUID(),
        name: out.name,
        kind: out.kind,
        size: out.size,
        source: 'file',
        file: new File([out.blob], out.name, { type: mimeForKind(out.kind) }),
        blob: out.blob,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo completar la operación.')
    }
  }

  function handleRetry() {
    resetWorkflow()
    setVerification(undefined)
    setStep('config')
  }

  function handleRestart() {
    resetWorkflow()
    setVerification(undefined)
    setStep('config')
  }

  async function handleDownload(artifact: Artifact) {
    const blob = artifact.file ?? artifact.blob
    if (!blob) {
      toast.error('El resultado ya no está disponible, vuelve a procesarlo')
      return
    }
    await saveResult(blob, artifact.name)
    toast.success('Descarga iniciada')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5">
      {/* Volver a las categorías admitidas por el formato */}
      <Button
        variant="ghost"
        size="sm"
        onClick={handleBack}
        aria-label="Volver a categorías"
        className="w-fit gap-1.5 self-start px-2 text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Volver
      </Button>

      {/* Icono + título + subtítulo (+ atribución de las tools de encriptado) */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-accent text-primary">
            <action.icon className="size-6" aria-hidden="true" />
          </span>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-xl font-semibold tracking-tight">{action.name}</h2>
              <Badge variant="secondary" className="rounded-full px-2 py-0.5 text-xs">
                {CATEGORY_LABELS[action.category]}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">{action.description}</p>
            {action.needsGpu ? (
              <Badge variant="outline" className="mt-0.5 w-fit rounded-full px-2 py-0.5 text-xs">
                IA local · WebGPU (fallback CPU)
              </Badge>
            ) : null}
          </div>
        </div>

        {/* Crédito del diseño (solo en las tools de encriptado y de metadata) */}
        {(action.id.startsWith('crypto.') || action.id === 'meta.strip') && (
          <div className="hidden shrink-0 text-right text-[11px] leading-snug text-muted-foreground sm:block">
            {action.id === 'meta.strip' ? (
              <>
                Método inspirado en{' '}
                <a
                  href="https://github.com/jvoisin/mat2"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  MAT2
                </a>
                <br />
                Identificación C2PA/XMP inspirada en{' '}
                <a
                  href="https://github.com/iAnonymous3000/metadata-remover"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  metadata-remover
                </a>
              </>
            ) : (
              <>
                Inspirado en{' '}
                <a
                  href="https://privacytools.io/encrypt"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  VERNAM
                </a>
                {' · '}
                <a
                  href="https://privacytools.io"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                >
                  PrivacyTools.io
                </a>
              </>
            )}
          </div>
        )}
      </div>

      {/* Cuerpo de la herramienta: ocupa casi todo el espacio */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-border bg-card p-5 md:p-6">
        {!hasProcessor(action.id) ? (
          /* Sin motor todavía: aviso de fase próxima (header se mantiene). */
          <div className="flex h-full flex-col items-center justify-center gap-3 py-10 text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-accent text-primary">
              <Construction className="size-7" aria-hidden="true" />
            </span>
            <Badge variant="secondary" className="rounded-full px-2 py-0.5 text-xs">
              Próximamente
            </Badge>
            <p className="max-w-sm text-sm text-muted-foreground">
              Esta herramienta forma parte del catálogo, su motor llegará en una fase próxima.
            </p>
            <Button type="button" disabled>
              Procesar
            </Button>
          </div>
        ) : !artifact.file ? (
          /* La tool necesita un archivo real para ejecutarse. */
          <Alert>
            <AlertTitle>Se necesita un archivo</AlertTitle>
            <AlertDescription>
              Se necesita un archivo para procesar esta operación.
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {step === 'idle' || step === 'config' ? (
              <ErrorBoundary>
                <ToolBody
                  action={action}
                  artifact={artifact}
                  onSubmit={handleSubmit}
                />
              </ErrorBoundary>
            ) : null}

            {step === 'running' ? (
              <ProgressBar
                phase={progress?.phase ?? 'Procesando'}
                percent={progress?.percent ?? 0}
              />
            ) : null}

            {step === 'done' && result ? (
              <ResultPanel
                artifact={result}
                verification={verification}
                onDownload={handleDownload}
                onRestart={handleRestart}
              />
            ) : null}

            {step === 'error' ? (
              <Alert variant="destructive" className="flex flex-col items-start gap-3">
                <AlertTitle>No se pudo completar</AlertTitle>
                <AlertDescription>
                  {error ?? 'Algo salió mal durante el procesamiento. Inténtalo de nuevo.'}
                </AlertDescription>
                <Button variant="outline" size="sm" onClick={handleRetry} className="gap-1.5">
                  <RefreshCw className="size-4" aria-hidden="true" />
                  Reintentar
                </Button>
              </Alert>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}