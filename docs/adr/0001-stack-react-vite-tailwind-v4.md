# ADR-0001 — Stack: React + Vite + Tailwind v4, descartado Astro

- **Estado:** Aceptado
- **Fecha:** 2026-09-28

## Contexto
El producto es una toolbox 100% local (procesamiento WebGPU/WASM en el navegador,
sin backend). Se evaluó Astro vs React. Astro destaca en contenido estático/SEO;
el 100% de este producto son *apps interactivas* (upload → wizard → procesar →
descargar), sin capa de contenido que sirvir.

## Decisión
**React 19 + Vite + TypeScript + Tailwind v4 + shadcn/ui + Zustand + Motion.**
- Detección de tipos, workers y WASM tienen el mejor soporte en el ecosistema Vite/React.
- Astro añadiría fricción de dual-framework sin beneficio medible.

## Consecuencias
- SEO del catálogo es marginal (SPA de herramientas).
- Si un día hay landing/blog público, se hace en sitio separado, fuera de este repo.