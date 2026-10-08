# ADR-0003 — Historial local por caché (desechable, sin secretos)

- **Estado:** Aceptado
- **Fecha:** 2026-10-07

## Contexto
Los usuarios repiten los mismos pasos (subir archivo → elegir tool → configurar)
una y otra vez; no había memoria de uso. La petición es un historial de "lo que
más se usa" para saltarse pasos. A la vez, la privacidad absoluta es el producto:
un historial durable (IndexedDB, servidor, cuenta) la traicionaría, y el usuario
pidió explícitamente que el historial **desaparezca al borrar la caché**.

El historial nunca debe guardar datos del archivo: solo la *acción* ejecutada, su
`FileKind` y la configuración no sensible.

## Decisión
1. **Almacenamiento en capas, resuelto en cada operación:**
   - Primario: **Cache Storage**, bucket versionado `adei-one/history/v1`, con un
     `Request`/`Response` sintético que contiene un JSON (sin red real).
   - Fallback: **`localStorage`** (`adei-one:history:v1`) cuando `caches` no
     existe o lanza.
   - Último recurso: **memoria** de la sesión cuando tampoco hay `localStorage`.
   Si la persona vacía la caché del navegador, el historial se vacía con ella.
2. **Filtro de secretos en ESCRITURA:** se descarta toda clave de config que
   coincida con `/pass|secret|token|key/i` (cubre `crypto.file` → `passphrase`)
   antes de tocar cualquier nivel de almacenamiento.
3. **Solo se guarda** `{ actionId, kind, config(filtrada), ts, count }`. Nunca
   nombres, contenidos, bytes ni texto derivado.
4. **Best-effort:** toda falla de almacenamiento se traga; el historial jamás
   rompe una ejecución de tool. `clear()` vacía memoria y **ambos** niveles.
5. Un módulo puro (`src/core/history.ts`) es dueño de la política; un store
   zustand (`src/core/stores/history.ts`) solo hidrata y refleja. Sin `persist`.
6. UI mínima en la lista de acciones ("Recientes") + botón "Borrar historial"
   como escape de privacidad explícito.

## Consecuencias
- El historial es **desechable por diseño**: muere con la caché o al pulsar
  "Borrar historial". Eso es una característica, no un defecto.
- Las contraseñas y demás secretos **nunca** se persisten (verificado por test).
- La app funciona igual en modo privado o con almacenamiento denegado.
- La pre-carga de configuración (`defaults`) llega **solo** al wizard genérico en
  v1; las vistas custom mantienen su propio estado.
- Sin red, sin telemetría, sin dependencias nuevas: el historial vive y muere en
  el navegador.
