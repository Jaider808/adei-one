import { stripMetadataTool } from './strip-metadata/tool'
import type { Action } from '@/core/types'
/** Tools de Privacidad/Metadata (metadata para el catálogo). */
export const META_TOOLS: Action[] = [stripMetadataTool]