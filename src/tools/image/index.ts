import { resizeTool } from './resize/tool'
import { cropTool } from './crop/tool'
import { compressTool } from './compress/tool'
import { toTextTool } from './to-text/tool'
import type { Action } from '@/core/types'

/**
 * Tools de Imagen (metadata para el catálogo). El motor vive lazy en cada engine.
 * NOTA: "Convertir formato" y "Eliminar metadata" NO están aquí: los cubren el
 * convertidor universal y la tool transversal "Eliminar metadata" (meta.strip).
 */
export const IMAGE_TOOLS: Action[] = [resizeTool, cropTool, compressTool, toTextTool]