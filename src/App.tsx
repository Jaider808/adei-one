import { AppHeader } from '@/components/shell/AppHeader'
import { WorkspaceScreen } from '@/components/home/WorkspaceScreen'

/**
 * ADEI-ONE — Shell de la app: pantalla única tipo workspace (h-dvh, sin footer).
 * ThemeProvider y Toaster viven en main.tsx.
 */
export function App() {
  return (
    <div id="top" className="flex h-dvh mx-auto container flex-col lg:overflow-hidden">
      <AppHeader />
      <main className="flex h-[calc(100dvh-64px)] items-center flex-col">
        <WorkspaceScreen />
      </main>
    </div>
  )
}