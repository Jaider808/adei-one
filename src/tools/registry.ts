import { getBytes, mainThreadRunner } from '@/core/ports'
import type { RunContext } from '@/core/ports'
import type {
  ActionConfig,
  Artifact,
  ProcessResult,
  ProcessorFn,
  ToolViewComponent,
} from '@/core/types'

/**
 * ADEI-ONE — Registro de tools del sistema "carpeta por herramienta".
 * Cada action apunta a su engine y view dentro de `src/tools/<cat>/<tool>/`.
 * La carga es DIFERIDA: el engine (pdf-lib, fflate, etc.) y la vista custom
 * solo se descargan al abrir/usar la herramienta (regla bundle-dynamic-imports).
 * Contrato de exports con las tools: engine → splitPdf / deletePages /
 * rearrangePages / stripMetadata; view → SplitView / DeletePagesView /
 * ReorderPagesView (meta.strip usa el wizard genérico: view = null).
 */

type RunLoader = () => Promise<ProcessorFn>
/** Loader de vista para `React.lazy`: resuelve a { default: Componente }. */
type ViewLoader = () => Promise<{ default: ToolViewComponent }>

interface ToolEntry {
  run: RunLoader
  view: ViewLoader | null
}

const LOADERS: Record<string, ToolEntry> = {
  'pdf.split': {
    run: () => import('@/tools/pdf/split/engine').then((m) => m.splitPdf),
    view: () => import('@/tools/pdf/split/view').then((m) => ({ default: m.SplitView })),
  },
  'pdf.delete-pages': {
    run: () => import('@/tools/pdf/delete-pages/engine').then((m) => m.deletePages),
    view: () =>
      import('@/tools/pdf/delete-pages/view').then((m) => ({ default: m.DeletePagesView })),
  },
  'pdf.rearrange': {
    run: () => import('@/tools/pdf/reorder-pages/engine').then((m) => m.rearrangePages),
    view: () =>
      import('@/tools/pdf/reorder-pages/view').then((m) => ({ default: m.ReorderPagesView })),
  },
  'meta.strip': {
    run: () => import('@/tools/meta/strip-metadata/engine').then((m) => m.stripMetadata),
    view: () => import('@/tools/meta/strip-metadata/view').then((m) => ({ default: m.MetaStripView })),
  },
  'pdf.merge': {
    run: () => import('@/tools/pdf/merge/engine').then((m) => m.mergePdf),
    view: () => import('@/tools/pdf/merge/view').then((m) => ({ default: m.MergeView })),
  },
  'pdf.compress': {
    run: () => import('@/tools/pdf/compress/engine').then((m) => m.compressPdf),
    view: null,
  },
  'pdf.extract-text': {
    run: () => import('@/tools/pdf/extract-text/engine').then((m) => m.extractPdfText),
    view: null,
  },
  'pdf.protect': {
    run: () => import('@/tools/pdf/protect/engine').then((m) => m.protectPdf),
    view: null,
  },
  'pdf.sign': {
    run: () => import('@/tools/pdf/sign/engine').then((m) => m.signPdf),
    view: null,
  },
  'convert.any': {
    run: () => import('@/tools/convert/engine').then((m) => m.convertAny),
    view: () => import('@/tools/convert/view').then((m) => ({ default: m.ConvertView })),
  },
  'image.resize': {
    run: () => import('@/tools/image/resize/engine').then((m) => m.resizeImage),
    view: null,
  },
  'image.crop': {
    run: () => import('@/tools/image/crop/engine').then((m) => m.cropImage),
    view: null,
  },
  'image.compress': {
    run: () => import('@/tools/image/compress/engine').then((m) => m.compressImage),
    view: null,
  },
  'image.to-text': {
    run: () => import('@/tools/image/to-text/engine').then((m) => m.extractImageText),
    view: null,
  },
  'crypto.file': {
    run: () => import('@/tools/crypto/file/engine').then((m) => m.cryptoFile),
    view: () => import('@/tools/crypto/file/view').then((m) => ({ default: m.CryptoView })),
  },
}

/** ¿La action tiene motor real? (síncrono, para la UI). */
export function hasProcessor(actionId: string): boolean {
  return actionId in LOADERS
}

/** Carga (diferida) y devuelve el procesador de una action, o null. */
export async function getProcessor(actionId: string): Promise<ProcessorFn | null> {
  const entry = LOADERS[actionId]
  return entry ? entry.run() : null
}

/**
 * ¿La tool tiene vista custom? Devuelve el loader lazy (`{ default }`, apto para
 * `React.lazy`), o null si usa el wizard genérico. Síncrono y refresh-safe.
 */
export function getToolView(actionId: string): ViewLoader | null {
  return LOADERS[actionId]?.view ?? null
}

/**
 * Ejecuta una tool de punta a punta: obtiene bytes del Artifact (puerto),
 * carga el engine (lazy) y lo corre vía el Runner (hoy main-thread).
 * `files` (opcional) alimenta tools multiarchivo: files[0] es el principal y el
 * resto van como `extras` del EngineInput (p. ej. Unir PDFs).
 * El día que el Runner sea un Web Worker, nada de esto cambia.
 */
export async function runTool(
  actionId: string,
  input: { artifact: Artifact; config: ActionConfig; files?: Artifact[] },
  ctx: RunContext,
): Promise<ProcessResult> {
  const entry = LOADERS[actionId]
  if (!entry) throw new Error('Esta herramienta aún no tiene motor')
  const engine = await entry.run()

  const mains = input.files ?? [input.artifact]
  const [main, ...rest] = mains

  const bytes = await getBytes(main)
  const extras = rest.length
    ? await Promise.all(
        rest.map(async (file) => ({ name: file.name, bytes: await getBytes(file) })),
      )
    : undefined

  return mainThreadRunner.run(
    engine,
    {
      bytes,
      name: main.name,
      kind: main.kind,
      config: input.config,
      extras,
    },
    ctx,
  )
}