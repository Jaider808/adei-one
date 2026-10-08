import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Fallback personalizado: (error, reset) => ReactNode. */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * ErrorBoundary: captura errores de render de sus hijos para que un crash de
 * UNA herramienta (o nodo) no desmonte toda la app en blanco. Muestra un panel
 * con el mensaje + "Reintentar" (resetea el estado y vuelve a renderizar).
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] error capturado:', error, info.componentStack)
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    if (this.props.fallback) return this.props.fallback(error, this.reset)

    return (
      <div className="flex flex-col items-start gap-3 rounded-2xl border border-destructive/30 bg-card p-5">
        <p className="flex items-center gap-2 font-display font-semibold">
          <TriangleAlert className="size-4 text-destructive" aria-hidden="true" />
          Algo salió mal
        </p>
        <p className="text-sm text-muted-foreground">
          {error.message || 'Ocurrió un error inesperado al renderizar este componente.'}
        </p>
        <Button variant="outline" size="sm" onClick={this.reset}>
          Reintentar
        </Button>
      </div>
    )
  }
}