import { PDF_TOOLS } from '@/tools/pdf'
import { META_TOOLS } from '@/tools/meta'
import { IMAGE_TOOLS } from '@/tools/image'
import { CRYPTO_TOOLS } from '@/tools/crypto'
import { convertAnyTool } from '@/tools/convert/tool'
import type { Action } from '@/core/types'

/** Todas las tools implementadas: metadata que alimenta el catálogo. */
export const TOOLS: Action[] = [
  ...PDF_TOOLS,
  ...IMAGE_TOOLS,
  ...CRYPTO_TOOLS,
  ...META_TOOLS,
  convertAnyTool,
]