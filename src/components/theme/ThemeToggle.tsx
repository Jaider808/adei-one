import { Check, Laptop, Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTheme, type Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'

const OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'Sistema', icon: Laptop },
  { value: 'light', label: 'Claro', icon: Sun },
  { value: 'dark', label: 'Oscuro', icon: Moon },
]

/** Selector de tema: auto (por defecto), claro u oscuro. */
export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const ActiveIcon = theme === 'system' ? Laptop : theme === 'dark' ? Moon : Sun

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-9"
          aria-label={`Tema actual: ${theme}. Cambiar tema`}
        >
          <ActiveIcon className="size-[18px]" data-icon="inline" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onClick={() => setTheme(value)}
            className={cn('gap-2.5', theme === value && 'text-foreground font-medium')}
          >
            <Icon className="size-4 text-muted-foreground" />
            <span className="flex-1">{label}</span>
            {theme === value && <Check className="size-4 text-primary" />}
            {value === 'system' && (
              <span
                className="size-2 rounded-full"
                data-theme-dot
                style={{
                  background:
                    resolvedTheme === 'dark' ? 'var(--primary)' : 'var(--muted-foreground)',
                }}
                title={resolvedTheme === 'dark' ? 'Actualmente oscuro' : 'Actualmente claro'}
              />
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}