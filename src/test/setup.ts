/**
 * Setup de tests — polyfills mínimos de browser APIs que usan los componentes
 * (ThemeProvider usa matchMedia; AppHeader usa IntersectionObserver).
 */
export {}

if (typeof globalThis.matchMedia === 'undefined') {
  globalThis.matchMedia = ((query: string) => ({
    matches: query.includes('prefers-color-scheme') && false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  class MockIntersectionObserver {
    readonly root = null
    readonly rootMargin = ''
    readonly thresholds = []
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
  globalThis.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  class MockResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
}

// Motion/framer usa Web Animations API; happy-dom la implementa y su promesa
// `finished` rechaza con AbortError al cancelar durante cleanup (ruido en tests).
// Sobrescribimos `animate` con un mock inerte para evitar rechazos no manejados.
if (typeof Element !== 'undefined') {
  Element.prototype.animate = function () {
    return {
      cancel() {},
      finish() {},
      pause() {},
      play() {},
      reverse() {},
      updatePlaybackRate() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false
      },
      finished: Promise.resolve(),
      ready: Promise.resolve(),
      currentTime: 0,
      effect: null,
      pending: false,
      playState: 'finished',
      playbackRate: 1,
      startTime: null,
      timeline: null,
      oncancel: null,
      onfinish: null,
      onremove: null,
    } as unknown as Animation
  }
}