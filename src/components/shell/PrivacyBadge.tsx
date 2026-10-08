import { ShieldCheck } from 'lucide-react'

/** Pill que comunica el valor central de ADEI-ONE: todo se procesa en el dispositivo. */
export function PrivacyBadge() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
      <ShieldCheck className="size-3.5 text-primary" aria-hidden="true" />
      100% local
    </span>
  )
}