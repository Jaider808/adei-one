import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Formatea bytes a una lectura cómoda (B, KB, MB, GB) sin decimales basura. */
export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const k = 1024
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1)
  const value = bytes / k ** i
  const maxDecimals = units[i] === 'B' ? 0 : decimals
  const formatted = value.toFixed(maxDecimals).replace(/\.0+$/, '')
  return `${formatted} ${units[i]}`
}

/** Devuelve la extensión en minúsculas sin punto, o '' si no tiene. */
export function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}