/**
 * ADEI-ONE — Lógica PURA (sin React) del formulario compartido de páginas.
 * La usan Recortar PDF (split), Eliminar páginas (delete) y Reordenar (reorder).
 * Cubierta por páginas-form.utils.test.ts.
 */

/** Tool que consume el formulario; 'split' = Recortar PDF. */
export type PagesFormKind = 'split' | 'delete' | 'reorder'

/** Preset de selección rápida (Pares / Impares / Todas). */
export type PresetName = 'pares' | 'impares' | 'todas'

/** Páginas del preset (1-indexed). Con total 0 devuelve [] (nada que marcar). */
export function presetPages(preset: PresetName, total: number): number[] {
  const all = Array.from({ length: total }, (_, i) => i + 1)
  if (preset === 'pares') return all.filter((p) => p % 2 === 0)
  if (preset === 'impares') return all.filter((p) => p % 2 === 1)
  return all // 'todas'
}

/**
 * ¿Están seleccionadas TODAS las páginas del rango 1..total?
 * Caso límite: total 0 con nada seleccionado → true (no hay nada que elegir).
 */
export function allPagesSelected(selected: number[], total: number): boolean {
  if (total === 0) return selected.length === 0
  if (selected.length !== total) return false
  const unique = new Set(selected)
  if (unique.size !== total) return false
  for (const page of unique) {
    if (page < 1 || page > total) return false
  }
  return true
}

/** Reglas de habilitación del botón Procesar según la tool. */
export function canSubmit(kind: PagesFormKind, selectedCount: number, total: number): boolean {
  // split/reorder: basta con que haya al menos una página marcada.
  if (kind !== 'delete') return selectedCount > 0
  // delete: no se permite eliminar todas las páginas del documento.
  return selectedCount > 0 && selectedCount < total
}

/** Label del botón de 'split' según la salida, con singular/plural correcto. */
export function splitSubmitLabel(selectedCount: number, output: 'unido' | 'separado'): string {
  const noun = selectedCount === 1 ? 'página' : 'páginas'
  return output === 'separado'
    ? `Descargar ${selectedCount} ${noun} (ZIP)`
    : `Recortar ${selectedCount} ${noun}`
}

/**
 * Mueve un elemento del orden de la posición `from` a la `to` (drag & drop).
 * Devuelve una copia nueva (no muta). Índices inválidos → copia intacta.
 */
export function moveInOrder(order: number[], from: number, to: number): number[] {
  if (from < 0 || from >= order.length || to < 0 || to >= order.length) return [...order]
  const next = [...order]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}