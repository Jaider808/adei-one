import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import { Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { ActionConfig } from '@/core/types'
import { cn } from '@/lib/utils'

/**
 * WizardForm — formulario auto-generado a partir de un schema Zod v4.
 * Reflexiona `shape` y genera el control adecuado por campo:
 * enum → ToggleGroup (2–6) o Select (>6); boolean → Switch;
 * number → Input numérico (min/max/step de `checks`); string → Input.
 * Optional/default se resuelven con `unwrap()` y `.isOptional()`.
 */

interface WizardFormProps {
  /** ZodType<ActionConfig> | null (o cualquier objeto Zod) */
  schema?: unknown
  defaults?: Record<string, unknown>
  onSubmit: (config: ActionConfig) => void
  submitLabel?: string
}

/* ---------- Introspector de Zod v4 (reflexión defensiva) ---------- */

const WRAPPER_CTORS = new Set(['ZodOptional', 'ZodNullable', 'ZodDefault'])

interface ZodIssueLike {
  path: Array<PropertyKey>
  message: string
}
interface ZodSafeParseFailure {
  success: false
  error: { issues: ZodIssueLike[] }
  data?: undefined
}
interface ZodSafeParseSuccess {
  success: true
  data: unknown
  error?: undefined
}
type ZodSafeParseResult = ZodSafeParseSuccess | ZodSafeParseFailure

interface ZodObjectLike {
  shape: Record<string, unknown>
  safeParse: (value: unknown) => ZodSafeParseResult
}

type FieldKind = 'boolean' | 'enum' | 'number' | 'string' | 'unknown'

interface NumberRange {
  min?: number
  max?: number
  step?: number
}

interface SchemaField {
  key: string
  label: string
  required: boolean
  description?: string
  kind: FieldKind
  options?: string[]
  range?: NumberRange
}

/** Un objeto Zod v4 expone `.shape` (getter cacheado por instancia). */
function isZodObject(s: unknown): s is ZodObjectLike {
  if (!s || (typeof s !== 'object' && typeof s !== 'function')) return false
  const shape = (s as { shape?: unknown }).shape
  return typeof shape === 'object' && shape !== null
}

/** Desenvuelve Optional/Nullable/Default hasta el tipo base. */
function unwrap(t: unknown): unknown {
  let current: unknown = t
  let depth = 0
  while (current && depth < 6) {
    const ctor = (current as { constructor?: { name?: string } })?.constructor?.name
    if (ctor && WRAPPER_CTORS.has(ctor)) {
      const next = (current as { unwrap?: () => unknown }).unwrap?.()
      if (!next || next === current) break
      current = next
      depth += 1
      continue
    }
    break
  }
  return current
}

/** Descripción: vive en el wrapper o en un tipo interno tras `unwrap()`. */
function descriptionOf(t: unknown): string | undefined {
  const seen = new Set<unknown>()
  let current: unknown = t
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current)
    const description = (current as { description?: unknown }).description
    if (typeof description === 'string') return description
    const next = (current as { unwrap?: () => unknown }).unwrap?.()
    if (!next || next === current) break
    current = next
  }
  return undefined
}

/** Opciones de enum (string[]). ZodUnion también tiene `.options` pero son schemas. */
function optionsOf(base: unknown): string[] | undefined {
  if (!base || typeof base !== 'object') return undefined
  const options = (base as { options?: unknown }).options
  if (!Array.isArray(options)) return undefined
  const values = options as unknown[]
  if (values.every((value) => typeof value === 'string')) return values as string[]
  if ((base as { constructor?: { name?: string } })?.constructor?.name === 'ZodEnum') {
    return values.map(String)
  }
  return undefined
}

/** Clasifica el tipo base ya desenvuelto. */
function kindOf(base: unknown): FieldKind {
  const ctor = (base as { constructor?: { name?: string } })?.constructor?.name
  if (optionsOf(base)) return 'enum'
  if (ctor === 'ZodBoolean') return 'boolean'
  if (ctor === 'ZodNumber') return 'number'
  if (ctor === 'ZodString') return 'string'
  return 'unknown'
}

/** Extrae min/max/step de los `checks` de un ZodNumber (defensivo). */
function rangeOf(base: unknown): NumberRange | undefined {
  const ctor = (base as { constructor?: { name?: string } })?.constructor?.name
  if (ctor !== 'ZodNumber') return undefined
  const wrapped = base as { _zod?: { def?: { checks?: unknown } }; def?: { checks?: unknown } }
  const def = wrapped._zod?.def ?? wrapped.def
  const checks = Array.isArray(def?.checks) ? (def.checks as unknown[]) : []
  const range: NumberRange = {}
  for (const check of checks) {
    const checkDef = (check as { _zod?: { def?: { check?: string; value?: unknown } } })?._zod?.def
    if (!checkDef) continue
    if (checkDef.check === 'greater_than' && typeof checkDef.value === 'number') {
      range.min = checkDef.value
    } else if (checkDef.check === 'less_than' && typeof checkDef.value === 'number') {
      range.max = checkDef.value
    } else if (checkDef.check === 'multiple_of' && typeof checkDef.value === 'number') {
      range.step = checkDef.value
    }
  }
  return range.min !== undefined || range.max !== undefined || range.step !== undefined
    ? range
    : undefined
}

/** Valor por defecto de un ZodDefault (resolve funciones defensivamente). */
function defaultValOf(t: unknown): unknown {
  const seen = new Set<unknown>()
  let current: unknown = t
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current)
    const item = current as {
      constructor?: { name?: string }
      unwrap?: () => unknown
      _zod?: { def?: { defaultValue?: unknown } }
      def?: { defaultValue?: unknown }
    }
    if (item.constructor?.name === 'ZodDefault') {
      const def = item._zod?.def ?? item.def
      let value: unknown = def?.defaultValue
      if (typeof value === 'function') {
        try {
          value = (value as () => unknown)()
        } catch {
          value = undefined
        }
      }
      return value
    }
    if (!(item.constructor?.name && WRAPPER_CTORS.has(item.constructor.name))) break
    const next = item.unwrap?.()
    if (!next || next === current) break
    current = next
  }
  return undefined
}

/** Un Optional/Default/nullish cuenta como no obligatorio. */
function isOptionalField(t: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = t
  while (current !== null && current !== undefined && !seen.has(current)) {
    seen.add(current)
    const item = current as { isOptional?: () => boolean; unwrap?: () => unknown; constructor?: { name?: string } }
    let optional = false
    try {
      optional = typeof item.isOptional === 'function' && item.isOptional()
    } catch {
      optional = false
    }
    if (optional) return true
    if (!(item.constructor?.name && WRAPPER_CTORS.has(item.constructor.name))) break
    const next = item.unwrap?.()
    if (!next || next === current) break
    current = next
  }
  return false
}

/** `maxSizeMB` → "Max Size MB", `keepMeta` → "Keep Meta". */
function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function buildField(key: string, type: unknown): SchemaField {
  const base = unwrap(type)
  const kind = kindOf(base)
  return {
    key,
    label: humanize(key),
    required: !isOptionalField(type),
    description: descriptionOf(type),
    kind,
    options: kind === 'enum' ? optionsOf(base) : undefined,
    range: kind === 'number' ? rangeOf(base) : undefined,
  }
}

function initialValues(
  shape: Record<string, unknown> | null,
  defaults?: Record<string, unknown>,
): Record<string, unknown> {
  const initial: Record<string, unknown> = { ...defaults }
  if (!shape) return initial
  for (const [key, type] of Object.entries(shape)) {
    if (initial[key] !== undefined) continue
    const defaultValue = defaultValOf(type)
    if (defaultValue !== undefined) initial[key] = defaultValue
  }
  return initial
}

/* ---------- Control por campo ---------- */

interface FieldControlProps {
  field: SchemaField
  value: unknown
  error: string | undefined
  onChange: (value: unknown) => void
}

function FieldControl({ field, value, error, onChange }: FieldControlProps) {
  const id = `wizard-field-${field.key}`
  const errorId = `${id}-error`
  const optionalMark = !field.required ? (
    <span className="ml-1 font-normal text-muted-foreground">(opcional)</span>
  ) : null

  // Boolean → fila con Label + Switch (patrón settings)
  if (field.kind === 'boolean') {
    return (
      <div className="flex flex-col gap-1.5">
        <div
          className={cn(
            'flex items-center justify-between gap-4 rounded-md border bg-card px-3.5 py-3',
            error ? 'border-destructive' : 'border-input',
          )}
        >
          <div className="flex flex-col gap-0.5">
            <Label htmlFor={id} className="leading-snug">
              {field.label}
              {optionalMark}
            </Label>
            {field.description ? (
              <p className="text-xs text-muted-foreground">{field.description}</p>
            ) : null}
          </div>
          <Switch
            id={id}
            checked={value === true}
            onCheckedChange={onChange}
            aria-label={field.label}
          />
        </div>
        {error ? (
          <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  const label = (
    <Label htmlFor={id} className={cn(error && 'text-destructive')}>
      {field.label}
      {optionalMark}
    </Label>
  )

  let control: ReactNode = null
  if (field.kind === 'enum' && field.options) {
    const selected = field.options.includes(value as string)
      ? (value as string)
      : undefined
    control =
      field.options.length <= 6 ? (
        <ToggleGroup
          type="single"
          variant="outline"
          id={id}
          aria-label={field.label}
          className="flex-wrap justify-start"
          value={selected}
          onValueChange={(next) => {
            if (next !== undefined) onChange(next)
          }}
        >
          {field.options.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {option}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : (
        <Select value={selected} onValueChange={onChange}>
          <SelectTrigger
            id={id}
            aria-label={field.label}
            className={cn(error && 'border-destructive')}
          >
            <SelectValue placeholder="Selecciona una opción" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {field.options.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      )
  } else if (field.kind === 'number') {
    control = (
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={field.range?.min}
        max={field.range?.max}
        step={field.range?.step ?? 'any'}
        value={
          typeof value === 'string'
            ? value
            : value === undefined || value === null
              ? ''
              : String(value)
        }
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
    )
  } else {
    control = (
      <Input
        id={id}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      {label}
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
      {control}
      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/* ---------- Componente ---------- */

export function WizardForm({
  schema,
  defaults,
  onSubmit,
  submitLabel = 'Procesar',
}: WizardFormProps) {
  const hasSchema = !!schema && isZodObject(schema)
  const shape: Record<string, unknown> | null = hasSchema
    ? (schema as ZodObjectLike).shape
    : null
  const fields = useMemo(
    () => (shape ? Object.entries(shape).map(([key, type]) => buildField(key, type)) : []),
    [shape],
  )
  // Firma estable para resetear al cambiar de tool sin bucles de render.
  const shapeSignature = useMemo(
    () => (shape ? Object.keys(shape).sort().join('|') : ''),
    [shape],
  )

  const [values, setValues] = useState<Record<string, unknown>>(() =>
    initialValues(shape, defaults),
  )
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    setValues(initialValues(shape, defaults))
    setErrors({})
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeSignature])

  const setField = (key: string, value: unknown) => {
    setValues((previous) => ({ ...previous, [key]: value }))
    setErrors((previous) => {
      if (!(key in previous)) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!schema || !isZodObject(schema)) {
      setErrors({})
      onSubmit({})
      return
    }
    // Normaliza números antes de validar (el Input los entrega como string).
    const normalized: Record<string, unknown> = { ...values }
    for (const field of fields) {
      if (field.kind !== 'number') continue
      const raw = values[field.key]
      if (typeof raw === 'string' && raw.trim() !== '') {
        const num = Number(raw)
        normalized[field.key] = Number.isNaN(num) ? raw : num
      }
    }

    const result = schema.safeParse(normalized)
    if (!result.success) {
      const next: Record<string, string> = {}
      for (const issue of result.error.issues) {
        const first = issue.path[0]
        const key = typeof first === 'string' ? first : undefined
        if (key && !next[key]) next[key] = issue.message
      }
      setErrors(next)
      return
    }
    setErrors({})
    onSubmit(result.data as ActionConfig)
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-5">
      {fields.length === 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm text-foreground">Esta herramienta no requiere configuración.</p>
          <p className="text-xs text-muted-foreground">
            Pulsa el botón para procesar con los valores por defecto.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {fields.map((field) => (
            <FieldControl
              key={field.key}
              field={field}
              value={values[field.key]}
              error={errors[field.key]}
              onChange={(value) => setField(field.key, value)}
            />
          ))}
        </div>
      )}
      <Button type="submit" className="w-full">
        <Sparkles data-icon="inline-start" />
        {submitLabel}
      </Button>
    </form>
  )
}

export type { WizardFormProps }