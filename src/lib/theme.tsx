import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

export type Theme = 'light' | 'dark' | 'system'

interface ThemeProviderState {
  /** Preferencia elegida por el usuario (auto por defecto). */
  theme: Theme
  /** Tema resuelto: 'light' | 'dark' (tras aplicar prefers-color-scheme). */
  resolvedTheme: Exclude<Theme, 'system'>
  setTheme: (theme: Theme) => void
  cycleTheme: () => void
}

const STORAGE_KEY = 'adei-theme'
const MEDIA = '(prefers-color-scheme: dark)'

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(MEDIA).matches
}

/** Aplica el tema al <html> y añade la clase de transición suave. */
function applyTheme(theme: Theme) {
  const root = window.document.documentElement
  const isDark = theme === 'dark' || (theme === 'system' && systemPrefersDark())

  root.classList.remove('light', 'dark')
  root.classList.add(isDark ? 'dark' : 'light')

  // Transición buttery solo durante el cambio (sin transiciones globales permanentes)
  root.classList.remove('theme-switching')
  void root.offsetWidth // reflow para reiniciar la transición
  root.classList.add('theme-switching')
  window.setTimeout(() => root.classList.remove('theme-switching'), 500)
}

/**
 * Lee la preferencia guardada. Si no hay, devuelve 'system' (auto por defecto).
 * Todas las escrituras se protegen con try/catch (modo incógnito).
 */
function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    /* storage no disponible */
  }
  return 'system'
}

function storeTheme(theme: Theme) {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    /* storage no disponible — no persiste pero funciona en sesión */
  }
}

const ThemeContext = createContext<ThemeProviderState | null>(null)

export function ThemeProvider({
  children,
}: {
  children: ReactNode
}) {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme)

  // Aplica el tema al montar y ante cualquier cambio
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // Si el usuario está en "system", reacciona a cambios del SO en vivo
  useEffect(() => {
    if (theme !== 'system') return
    const mql = window.matchMedia(MEDIA)
    const onChange = () => applyTheme('system')
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [theme])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    storeTheme(next)
  }, [])

  const cycleTheme = useCallback(() => {
    setThemeState((current) => {
      const order: Theme[] = ['system', 'light', 'dark']
      const next = order[(order.indexOf(current) + 1) % order.length]
      storeTheme(next)
      return next
    })
  }, [])

  const resolvedTheme: Exclude<Theme, 'system'> =
    theme === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : theme

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme, cycleTheme }),
    [theme, resolvedTheme, setTheme, cycleTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme debe usarse dentro de <ThemeProvider>')
  return ctx
}