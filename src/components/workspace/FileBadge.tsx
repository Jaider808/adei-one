import {
  FileArchive,
  FileSpreadsheet,
  FileText,
  Image,
  Music,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import type { Artifact, FileKind } from '@/core/types'
import { cn, formatBytes } from '@/lib/utils'

interface FileBadgeProps {
  artifact: Artifact
  onClear: () => void
  className?: string
}

/** Icono representativo según el tipo de archivo detectado. */
const KIND_ICONS: Partial<Record<FileKind, LucideIcon>> = {
  pdf: FileText,
  docx: FileText,
  pptx: FileText,
  md: FileText,
  txt: FileText,
  xml: FileText,
  json: FileText,
  epub: FileText,
  xlsx: FileSpreadsheet,
  csv: FileSpreadsheet,
  jpg: Image,
  png: Image,
  webp: Image,
  gif: Image,
  svg: Image,
  tiff: Image,
  heic: Image,
  mp3: Music,
  flac: Music,
  m4a: Music,
  wav: Music,
  mp4: Video,
  mov: Video,
  mkv: Video,
  avi: Video,
  webm: Video,
  zip: FileArchive,
}

function artifactIcon(kind: FileKind): LucideIcon {
  return KIND_ICONS[kind] ?? FileText
}

/** Chip del artefacto cargado: icono, nombre, tamaño, tipo y botón para quitarlo. */
export function FileBadge({ artifact, onClear, className }: FileBadgeProps) {
  const Icon = artifactIcon(artifact.kind)

  return (
    <div
      className={cn(
        'inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm',
        className
      )}
    >
      <Icon className="size-4 shrink-0 text-primary" aria-hidden />

      <span
        className="max-w-40 truncate font-mono text-xs text-foreground"
        title={artifact.name}
      >
        {artifact.name}
      </span>

      <span className="font-mono text-xs text-muted-foreground">
        {formatBytes(artifact.size)}
      </span>

      <Badge variant="secondary" className="font-normal lowercase">
        {artifact.kind}
      </Badge>

      <button
        type="button"
        onClick={onClear}
        aria-label="Quitar archivo"
        className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  )
}