/**
 * ADEI-ONE — Vista de "Eliminar metadata" (`meta.strip`).
 *
 * Escanea el archivo y muestra el INVENTARIO COMPLETO de su metadata: cada
 * entrada que el lector es capaz de ver, incluida la desconocida (sin curaduría
 * ni ocultación). El inventario se agrupa por contenedor (`entry.where`) en
 * secciones plegables, se puede buscar y deja ver el valor y, si es binario, su
 * hex corto.
 *
 * El plan de borrado se muestra UNA sola vez por grupo, en su cabecera, con
 * estos colores (nunca como único canal):
 *  - verde  = `individual`     → se elimina por sí sola.
 *  - ámbar  = `with-container` → se elimina, pero arrastra su contenedor.
 *  - gris   = `never`          → se conserva (dato técnico o no eliminable por el limpiador).
 * El MODO por defecto (`light`) es NO DESTRUCTIVO: elimina toda la metadata que
 * se pueda quitar por cirugía estructural y NUNCA toca el archivo. El switch
 * "Permitir modificar el archivo" habilita el modo `deep` (re-codificar la
 * imagen, rasterizar el PDF), con advertencias inline de lo que se pierde.
 * Cuando en `light` se conserva algo porque quitarlo exigiría modificar el
 * archivo (p. ej. la orientación EXIF de una foto), se explica y se señala el
 * switch como la vía para eliminarlo. Sin avisos no se renderiza ruido.
 *
 * Si un grupo mezcla resultados, cada fila declara el suyo para no mentir. El
 * resumen (total / se eliminan / se conservan / alto riesgo) usa el MISMO
 * criterio que pinta las filas.
 *
 * Si el kind aún no enumera de forma exhaustiva (PDF, Office, imágenes), el
 * inventario viene vacío y se cae con gracia a la vista por BLOQUES de siempre.
 * El contrato de envío no cambia: `onSubmit({ mode, blocks })`.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { motion } from 'motion/react'
import {
  AlertTriangle,
  ChevronDown,
  FileSearch,
  ScanSearch,
  Search,
  ShieldCheck,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { cn, formatBytes } from '@/lib/utils'
import { EMPTY_REPORT } from './domain'
import type {
  ActionConfig,
  MetaEntry,
  MetadataBlock,
  MetadataReport,
  RegenerationRisk,
  ToolViewProps,
} from '@/core/types'

type Mode = 'light' | 'deep'

/** Etiquetas de sensibilidad para el tooltip del punto (verde/gris según borrabilidad). */
const SENS_LABELS: Record<string, string> = {
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
}

/** Cómo se presenta una entrada según su `removal` (punto + texto + matiz). */
type RowPlan = { dot: string; text: string; detail: string }

const REMOVAL_INFO: Record<MetaEntry['removal'], RowPlan> = {
  individual: {
    dot: 'bg-emerald-500',
    text: 'Se elimina',
    detail: 'se puede borrar por sí sola',
  },
  'with-container': {
    dot: 'bg-amber-500',
    text: 'Se elimina',
    detail: 'se borra junto con su contenedor',
  },
  never: {
    dot: 'bg-muted-foreground/40',
    text: 'Se conserva',
    detail: 'dato técnico o que el limpiador actual no elimina: se conserva',
  },
}

/** Plan de una entrada que el modo Ligero no llega a borrar (no hay bloque que enviar). */
const PRESERVED_IN_MODE: RowPlan = {
  dot: 'bg-muted-foreground/40',
  text: 'Se conserva',
  detail: 'el modo Ligero no elimina esta entrada',
}

/** ¿Este bloque se puede eliminar? ('never' = técnico/estructural). */
function isDeletable(block: MetadataBlock): boolean {
  return block.removableIn !== 'never'
}

/**
 * ¿Una entrada se eliminará con el envío del modo dado? Es el MISMO criterio
 * que decide el submit: Profundo elimina todo lo eliminable; Ligero solo
 * elimina si el envío lleva al menos un bloque eliminable (de lo contrario el
 * botón está deshabilitado y el strip no borra nada).
 */
function willRemove(entry: MetaEntry, mode: Mode, hasDeletable: boolean): boolean {
  if (entry.removal === 'never') return false
  return mode === 'deep' || hasDeletable
}

/** Plan visual coherente con `willRemove` para el modo seleccionado. */
function rowPlan(entry: MetaEntry, mode: Mode, hasDeletable: boolean): RowPlan {
  if (entry.removal === 'never') return REMOVAL_INFO.never
  if (mode === 'light' && !hasDeletable) return PRESERVED_IN_MODE
  return REMOVAL_INFO[entry.removal]
}

/** ¿Coincide una entrada con el texto buscado? Busca en clave, etiqueta, valor y ruta. */
function entryMatches(entry: MetaEntry, query: string): boolean {
  return [entry.key, entry.label ?? '', entry.value, entry.where].some((text) =>
    text.toLowerCase().includes(query),
  )
}

/**
 * Avisos de regeneración de ESTE archivo que aplican a un modo. `affects`
 * decide la tarjeta ('deep' → Profundo; 'light' → Ligero). Vacío = sin ruido.
 */
function risksFor(risks: RegenerationRisk[] | undefined, affects: 'deep' | 'light'): RegenerationRisk[] {
  return (risks ?? []).filter((risk) => risk.affects === affects)
}

/**
 * Entradas que el modo por defecto CONSERVA porque quitarlas exigiría modificar
 * el archivo: el escaneo las marca `removal: 'never'` con `preservedNote`. No es
 * lo mismo que un dato técnico `never` (ICC, formato), que se conserva en
 * cualquier modo y no se anuncia aquí. La marca es explícita (campo dedicado),
 * no se infiere del texto de la etiqueta.
 */
function preservedToAvoidModification(entries: MetaEntry[]): MetaEntry[] {
  return entries.filter(
    (entry) => entry.removal === 'never' && entry.preservedNote !== undefined,
  )
}

/* ── Subcomponentes (fuera del componente: evita remontajes) ── */

/**
 * Lista inline de avisos concretos de un modo, DENTRO de su tarjeta. El color
 * del icono acompaña; la forma (triángulo vs punto) y el texto son el canal que
 * nunca engaña. Sin avisos no se renderiza nada (ningún recuadro vacío).
 */
function RiskList({ risks }: { risks: RegenerationRisk[] }): ReactNode {
  if (risks.length === 0) return null
  return (
    <span className="mt-2 flex flex-col gap-1.5">
      {risks.map((risk) => {
        const high = risk.severity === 'high'
        return (
          <span key={risk.id} className="flex items-start gap-1.5">
            {high ? (
              <AlertTriangle
                className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
            ) : (
              <span
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber-500/70"
                aria-hidden="true"
              />
            )}
            <span
              className={cn(
                'text-xs leading-relaxed',
                high
                  ? 'font-medium text-amber-700 dark:text-amber-300'
                  : 'text-muted-foreground',
              )}
            >
              {risk.detail}
            </span>
          </span>
        )
      })}
    </span>
  )
}

/**
 * Aviso NEUTRO (nada alarmante) de lo que el modo por defecto conserva porque
 * quitarlo exigiría modificar el archivo (p. ej. la orientación EXIF de una
 * foto). Surfacea la etiqueta explicativa del escaneo y señala el switch como
 * la vía para eliminarlo también. Sin entradas, no se renderiza nada.
 */
function PreservedNotice({ entries }: { entries: MetaEntry[] }): ReactNode {
  if (entries.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border bg-muted/30 p-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <ShieldCheck
          className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
          aria-hidden="true"
        />
        Se conserva sin tocar el archivo
      </p>
      <ul className="flex flex-col gap-1">
        {entries.map((entry) => (
          <li key={`${entry.where}-${entry.key}`} className="flex items-start gap-1.5">
            <span
              className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
              aria-hidden="true"
            />
            <span className="text-xs leading-relaxed text-muted-foreground">
              {entry.label ?? entry.key}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Quitarlo exigiría modificar el archivo. Activa «Permitir modificar el archivo» para
        eliminarlo también.
      </p>
    </div>
  )
}

/** Cuadro del resumen: número grande + etiqueta. El color acompaña, nunca es el único canal. */
function SummaryStat({
  value,
  label,
  accent,
}: {
  value: number
  label: string
  accent?: string
}): ReactNode {
  return (
    <div className="flex flex-col rounded-xl border bg-card px-3 py-2">
      <span className={cn('text-lg font-semibold tabular-nums', accent)}>{value}</span>
      <span className="text-xs leading-tight text-muted-foreground">{label}</span>
    </div>
  )
}

/** ¿Dos textos coinciden salvo por espacios o mayúsculas? */
function sameText(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase()
}

/** Insignia compacta del plan de borrado: se reutiliza en la cabecera del grupo y, solo si mezcla, en cada fila. */
function PlanBadge({ plan, className }: { plan: RowPlan; className?: string }): ReactNode {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-background/70 px-2 py-0.5 text-xs font-medium text-foreground',
        className,
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', plan.dot)} aria-hidden="true" />
      {plan.text}
    </span>
  )
}

/**
 * Fila de una entrada del inventario, con el VALOR como ancla visual
 * (monoespaciado, primer plano) y la etiqueta + clave cruda como subtítulo
 * apagado. La clave cruda solo se pinta cuando aporta algo frente a la
 * etiqueta (nunca se repite el mismo texto dos veces). La ruta del contenedor
 * y el plan de borrado viven en la cabecera del grupo; el plan solo baja a la
 * fila (`mixed`) cuando el grupo mezcla resultados.
 */
function EntryRow({
  entry,
  plan,
  id,
  open,
  mixed,
  onToggleHex,
}: {
  entry: MetaEntry
  plan: RowPlan
  id: string
  open: boolean
  mixed: boolean
  onToggleHex: (id: string) => void
}): ReactNode {
  const hexId = `meta-hex-${id}`
  const caption = entry.label ?? entry.key
  // La clave cruda solo se pinta si difiere de lo que ya se ve (la etiqueta):
  // así nunca se repite la misma cadena en la fila, pero se conserva el valor
  // experto cuando la clave real aporta algo distinto (p. ej. "EXIF:ExposureTime").
  const rawKey = sameText(entry.key, caption) ? null : entry.key
  const sens = SENS_LABELS[entry.sensitivity] ?? 'Baja'

  return (
    <li className="flex flex-col gap-1 border-t px-3 py-2 first:border-t-0">
      <div className="flex items-start gap-2">
        {/* El color conserva la semántica del plan (verde/ámbar/gris); el nombre
            accesible y el title evitan depender del color y anuncian la
            sensibilidad. */}
        <span
          className={cn('mt-1.5 size-2 shrink-0 rounded-full', plan.dot)}
          role="img"
          title={`Sensibilidad: ${sens}`}
          aria-label={`${plan.text}. Sensibilidad: ${sens}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {entry.value ? (
              <span className="break-words font-mono text-sm font-semibold tracking-tight text-foreground">
                {entry.value}
              </span>
            ) : (
              <span className="text-xs italic text-muted-foreground">Sin valor legible</span>
            )}
            {entry.size !== undefined ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatBytes(entry.size)}
              </span>
            ) : null}
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span className="min-w-0 break-words">{caption}</span>
            {rawKey ? (
              <>
                <span aria-hidden="true">·</span>
                <span className="font-mono">{rawKey}</span>
              </>
            ) : null}
            {mixed ? <PlanBadge plan={plan} /> : null}
            {entry.hex ? (
              <button
                type="button"
                onClick={() => onToggleHex(id)}
                aria-expanded={open}
                aria-controls={hexId}
                className="rounded font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {open ? 'Ocultar bytes' : 'Ver bytes'}
              </button>
            ) : null}
          </div>

          {entry.hex ? (
            <pre
              id={hexId}
              hidden={!open}
              className="mt-1.5 overflow-x-auto rounded-md border bg-muted/40 p-2 font-mono text-xs text-muted-foreground"
            >
              {entry.hex}
            </pre>
          ) : null}
        </div>
      </div>
    </li>
  )
}

/**
 * Sección plegable por contenedor (`where`): cabecera-botón real + lista de
 * entradas. La ruta se muestra UNA vez aquí, junto al recuento y —si todas las
 * filas comparten plan— UNA única insignia de plan (y, en grupos
 * `with-container`, la nota de inseparabilidad). Solo si el grupo mezcla
 * resultados se degrada a una insignia mínima por fila.
 */
function GroupSection({
  where,
  items,
  collapsed,
  groupId,
  openHex,
  mode,
  hasDeletable,
  onToggleGroup,
  onToggleHex,
}: {
  where: string
  items: { entry: MetaEntry; id: string }[]
  collapsed: boolean
  groupId: string
  openHex: Set<string>
  mode: Mode
  hasDeletable: boolean
  onToggleGroup: (where: string) => void
  onToggleHex: (id: string) => void
}): ReactNode {
  let uniformPlan: RowPlan | null = null
  let mixed = false
  for (const { entry } of items) {
    const plan = rowPlan(entry, mode, hasDeletable)
    if (uniformPlan === null) uniformPlan = plan
    else if (plan.text !== uniformPlan.text) {
      mixed = true
      break
    }
  }

  const isWithContainerGroup =
    !mixed &&
    uniformPlan !== null &&
    uniformPlan.text === 'Se elimina' &&
    items.every(({ entry }) => entry.removal === 'with-container')

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <button
        type="button"
        onClick={() => onToggleGroup(where)}
        aria-expanded={!collapsed}
        aria-controls={groupId}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 bg-muted/30 px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronDown
          className={cn('size-4 shrink-0 transition-transform', collapsed && '-rotate-90')}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 break-words font-mono text-xs font-medium">{where}</span>
        {!mixed && uniformPlan ? <PlanBadge plan={uniformPlan} /> : null}
        {isWithContainerGroup ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {REMOVAL_INFO['with-container'].detail}
          </span>
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground">
          {items.length} {items.length === 1 ? 'entrada' : 'entradas'}
        </span>
      </button>
      <ul id={groupId} hidden={collapsed}>
        {items.map(({ entry, id }) => (
          <EntryRow
            key={id}
            entry={entry}
            plan={rowPlan(entry, mode, hasDeletable)}
            id={id}
            open={openHex.has(id)}
            mixed={mixed}
            onToggleHex={onToggleHex}
          />
        ))}
      </ul>
    </div>
  )
}

/** Filas de un bloque (vista de respaldo). */
function blockFieldRows(block: MetadataBlock): ReactNode {
  const dot = isDeletable(block) ? 'bg-emerald-500' : 'bg-muted'
  return (
    <ul className="flex flex-col gap-1.5 border-t px-3 py-2.5">
      {block.fields.map((field, idx) => (
        <li key={`${block.id}-${idx}`} className="flex items-start gap-2 text-sm">
          <span
            className={`mt-1.5 size-1.5 shrink-0 rounded-full ${dot}`}
            title={`Sensibilidad: ${SENS_LABELS[field.sensitivity] ?? 'Baja'}`}
          />
          <span className="min-w-0">
            <span className="font-medium">{field.name}: </span>
            <span className="break-words text-muted-foreground">{field.value}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Respaldo honesto para los kinds que aún no enumeran entradas (PDF, Office,
 * imágenes): se muestra la vista por BLOQUES de siempre para no regresar.
 */
function BlocksFallback({ blocks }: { blocks: MetadataBlock[] }): ReactNode {
  const deletable = blocks.filter(isDeletable)
  const preserved = blocks.filter((block) => !isDeletable(block))

  return (
    <div className="flex flex-col gap-4">
      {deletable.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Se puede eliminar
          </p>
          <div className="max-h-60 overflow-hidden overflow-y-auto rounded-xl border border-primary/60 bg-accent/40">
            {deletable.map((block) => (
              <div key={block.id}>
                <div className="px-3 pt-2.5 text-sm font-medium">{block.label}</div>
                {blockFieldRows(block)}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {preserved.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            no se elimina
          </p>
          <div className="max-h-60 overflow-hidden overflow-y-auto rounded-xl border bg-card opacity-80">
            {preserved.map((block) => (
              <div key={block.id}>
                <div className="px-3 pt-2.5 text-sm font-medium">{block.label}</div>
                {blockFieldRows(block)}
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Datos técnicos del propio archivo (formato, dimensiones, perfil ICC de color, duración,
            códec…) o datos que el limpiador actual no elimina. Se mantienen en cualquier modo.
          </p>
        </div>
      ) : null}
    </div>
  )
}

/* ── Componente principal ── */

export function MetaStripView({ artifact, onSubmit }: ToolViewProps) {
  const [report, setReport] = useState<MetadataReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<Mode>('light')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [openHex, setOpenHex] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    let active = true
    async function run() {
      setLoading(true)
      try {
        if (!artifact.file) {
          if (active) setReport(EMPTY_REPORT)
          return
        }
        const bytes = new Uint8Array(await artifact.file.arrayBuffer())
        const engine = await import('./engine')
        const result = await engine.scanMetadata({ bytes, kind: artifact.kind })
        if (!active) return
        setReport(result)
      } catch {
        if (active) setReport(EMPTY_REPORT)
      } finally {
        if (active) setLoading(false)
      }
    }
    void run()
    return () => {
      active = false
    }
  }, [artifact])

  /** Grupos por `where`, en orden de primera aparición (nada se reordena ni se oculta). */
  const groups = useMemo(() => {
    const order: string[] = []
    const byWhere = new Map<string, { entry: MetaEntry; id: string }[]>()
    const all = report?.entries ?? []
    for (let index = 0; index < all.length; index++) {
      const entry = all[index]
      const id = `e${index}`
      const list = byWhere.get(entry.where)
      if (list) {
        list.push({ entry, id })
      } else {
        byWhere.set(entry.where, [{ entry, id }])
        order.push(entry.where)
      }
    }
    return order.map((where) => ({ where, items: byWhere.get(where) ?? [] }))
  }, [report])

  const normalizedQuery = query.trim().toLowerCase()

  /** Grupos visibles tras el buscador (una coincidencia de ruta muestra el grupo entero). */
  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return groups
    return groups.flatMap((group) => {
      if (group.where.toLowerCase().includes(normalizedQuery)) return [group]
      const items = group.items.filter(({ entry }) => entryMatches(entry, normalizedQuery))
      return items.length > 0 ? [{ where: group.where, items }] : []
    })
  }, [groups, normalizedQuery])

  // El contrato de envío no cambia: solo los ids de bloques eliminables.
  const deletable = useMemo(() => (report?.blocks ?? []).filter(isDeletable), [report])
  const deletableIds = useMemo(() => deletable.map((block) => block.id), [deletable])
  const hasDeletable = deletable.length > 0

  /** Resumen calculado con el MISMO criterio que pinta las filas. */
  const summary = useMemo(() => {
    const all = report?.entries ?? []
    let removed = 0
    let preserved = 0
    let high = 0
    for (const entry of all) {
      if (willRemove(entry, mode, hasDeletable)) removed++
      else preserved++
      if (entry.sensitivity === 'high') high++
    }
    return { total: all.length, removed, preserved, high }
  }, [report, mode, hasDeletable])

  const visibleCount = visibleGroups.reduce((count, group) => count + group.items.length, 0)

  const entryCount = report?.entries.length ?? 0
  const hasMetadata = entryCount > 0 || (report?.blocks.length ?? 0) > 0
  const useInventory = entryCount > 0
  const canSubmit = mode === 'deep' || deletable.length > 0

  /** Avisos concretos de ESTE archivo que solo se materializan con el switch activo (deep). */
  const deepRisks = useMemo(() => risksFor(report?.risks, 'deep'), [report])
  /** Lo que el modo por defecto conserva para no modificar el archivo (p. ej. orientación EXIF). */
  const preservedEntries = useMemo(
    () => preservedToAvoidModification(report?.entries ?? []),
    [report],
  )

  function handleSubmit(): void {
    if (!canSubmit) return
    // Ligero borra todos los bloques eliminables; Profundo además regenera.
    const blocks = mode === 'deep' ? [] : deletableIds
    onSubmit({ mode, blocks } as ActionConfig)
  }

  function handleModeChange(allowModify: boolean): void {
    setMode(allowModify ? 'deep' : 'light')
  }

  function toggleGroup(where: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(where)) next.delete(where)
      else next.add(where)
      return next
    })
  }

  function toggleHex(id: string): void {
    setOpenHex((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex flex-col gap-5"
    >
      {/* Archivo origen */}
      <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent text-primary">
          <FileSearch className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{artifact.name}</p>
          <p className="font-mono text-xs text-muted-foreground">
            {artifact.kind} · {formatBytes(artifact.size)}
          </p>
        </div>
      </div>

      {/* Escaneo / inventario de metadata */}
      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-1/2 rounded-lg" />
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      ) : !hasMetadata ? (
        <Alert>
          <ScanSearch className="size-4" aria-hidden="true" />
          <AlertTitle>No hay metadata detectada</AlertTitle>
          <AlertDescription>
            No hemos encontrado campos clásicos (autor, fechas, GPS…) en este archivo. Aun así puedes
            usar el modo <strong>Profundo</strong> para regenerar el archivo y descartar restos ocultos.
          </AlertDescription>
        </Alert>
      ) : useInventory ? (
        <div className="flex flex-col gap-4">
          {/* Resumen para cualquiera: de un vistazo, sin jerga */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <SummaryStat value={summary.total} label="Entradas encontradas" />
            <SummaryStat
              value={summary.removed}
              label="Se eliminarán"
              accent="text-emerald-600 dark:text-emerald-400"
            />
            <SummaryStat value={summary.preserved} label="Se conservarán" />
            <SummaryStat
              value={summary.high}
              label="De alto riesgo"
              accent={summary.high > 0 ? 'text-amber-600 dark:text-amber-400' : undefined}
            />
          </div>

          {/* Buscador del inventario */}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="meta-search" className="text-xs uppercase tracking-wide text-muted-foreground">
              Buscar en el inventario
            </Label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                id="meta-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Clave, valor o ruta del contenedor…"
                className="pl-9"
              />
            </div>
          </div>

          {/* Inventario completo, agrupado por contenedor */}
          {visibleGroups.length === 0 ? (
            <Alert>
              <ScanSearch className="size-4" aria-hidden="true" />
              <AlertTitle>Sin resultados</AlertTitle>
              <AlertDescription>
                Ninguna entrada del inventario coincide con «{query.trim()}».
              </AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col gap-2.5">
              {normalizedQuery ? (
                <p className="text-xs text-muted-foreground">
                  Mostrando {visibleCount} de {summary.total} entradas.
                </p>
              ) : null}
              {visibleGroups.map((group, index) => (
                <GroupSection
                  key={group.where}
                  where={group.where}
                  items={group.items}
                  collapsed={normalizedQuery ? false : collapsed.has(group.where)}
                  groupId={`meta-group-${index}`}
                  openHex={openHex}
                  mode={mode}
                  hasDeletable={hasDeletable}
                  onToggleGroup={toggleGroup}
                  onToggleHex={toggleHex}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <BlocksFallback blocks={report?.blocks ?? []} />
      )}

      {/* Modo de limpieza: por defecto NO se toca el archivo; el switch habilita modificarlo. */}
      <div className="flex flex-col gap-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Modo de limpieza</p>
        <div className="flex flex-col gap-3 rounded-xl border bg-card p-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="meta-modify-switch" className="leading-snug">
                Permitir modificar el archivo
              </Label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {mode === 'deep'
                  ? 'El archivo puede re-codificarse o rasterizarse: su contenido puede cambiar.'
                  : 'Por defecto no se toca el archivo: solo se elimina metadata por cirugía estructural.'}
              </p>
            </div>
            <Switch
              id="meta-modify-switch"
              checked={mode === 'deep'}
              onCheckedChange={handleModeChange}
              aria-label="Permitir modificar el archivo"
            />
          </div>

          {mode === 'deep' ? (
            <RiskList risks={deepRisks} />
          ) : (
            <PreservedNotice entries={preservedEntries} />
          )}
        </div>
      </div>

      <Button onClick={handleSubmit} disabled={!canSubmit}>
        Eliminar toda la metadata
      </Button>
    </motion.div>
  )
}
