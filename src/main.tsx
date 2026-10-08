import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toaster } from 'sonner'
import '@/index.css'
import { ThemeProvider } from '@/lib/theme'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { App } from '@/App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <ThemeProvider>
        <App />
        <Toaster position="bottom-right" richColors closeButton />
      </ThemeProvider>
    </ErrorBoundary>
  </StrictMode>,
)