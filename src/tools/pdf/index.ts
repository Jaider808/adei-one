/**
 * ADEI-ONE — Índice de las tools PDF (patrón carpeta por herramienta).
 * Exporta la metadata de cada tool; los motores viven lazy en su `engine.ts`
 * (y las vistas custom en su `view.tsx`) y se cargan bajo demanda.
 */
import { splitTool } from './split/tool'
import { deletePagesTool } from './delete-pages/tool'
import { reorderPagesTool } from './reorder-pages/tool'
import { mergeTool } from './merge/tool'
import { compressTool } from './compress/tool'
import { extractTextTool } from './extract-text/tool'
import { protectTool } from './protect/tool'
import { signTool } from './sign/tool'
import type { Action } from '@/core/types'

/** Tools de PDF (metadata para el catálogo). El motor vive lazy en cada engine. */
export const PDF_TOOLS: Action[] = [
  splitTool,
  deletePagesTool,
  reorderPagesTool,
  mergeTool,
  compressTool,
  extractTextTool,
  protectTool,
  signTool,
]