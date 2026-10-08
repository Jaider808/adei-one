# ADR-0002 — Patrón "Action" declarativo + Sistema de tema por CSS variables

- **Estado:** Aceptado
- **Fecha:** 2026-09-28

## Contexto
El catálogo tendrá 60+ herramientas. Repetir UI por herramienta es inviable; los
colores hardcodeados rompen el modo oscuro y la consistencia.

## Decisión
1. **Action declarativa**: cada herramienta es un objeto `{ id, name, category,
   appliesTo, schema, processor, icon }`. El wizard se **genera del schema Zod**
   (`WizardForm(schema)`); las tarjetas se filtran por `appliesTo` (magic-bytes).
   Añadir tool = 1 schema + 1 processor (~30 líneas).
2. **Tema**: tokens semánticos como CSS variables en `index.css`
   (`:root` + `.dark` + `@theme inline`), tema `light | dark | system` con
   **`system` por defecto** (sigue al navegador), persistido en `adei-theme` y
   anti-FOUC inline en `index.html`.

## Consecuencias
- Nada de colores crudos ni `dark:` manuales en componentes: solo `bg-primary`,
  `text-muted-foreground`, etc.
- WizardForm mantiene una sola implementación reutilizable.
- Progreso de Processor expuesto como `AsyncIterable<ProgressEvent>` (UI nunca se bloquea).