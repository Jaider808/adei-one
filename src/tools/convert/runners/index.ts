import { textRunners } from './text'
import { dataRunners } from './data'
import { docRunners } from './documents'
import { imageRunners } from './images'
import { utilRunners } from './utils'
import { devRunners } from './devtools'
import { dataMoreRunners } from './data-more'
import { docMoreRunners } from './documents-more'
import type { RunnerDef } from '../runner-types'

/**
 * Agregador de TODOS los runners del convertidor.
 * Un dominio nuevo = crear `runners/xxx.ts` y AÑADIR su array aquí (nada más).
 * El engine importa SOLO este agregador → añadir un dominio no toca el orquestador.
 */
export const ALL_RUNNER_DEFS: RunnerDef[] = [
  ...textRunners,
  ...dataRunners,
  ...docRunners,
  ...imageRunners,
  ...utilRunners,
  ...devRunners,
  ...dataMoreRunners,
  ...docMoreRunners,
]