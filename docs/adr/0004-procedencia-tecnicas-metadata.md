# ADR-0004 — Procedencia de las técnicas de metadata (atribución honesta)

- **Estado:** Aceptado
- **Fecha:** 2026-10-07

## Contexto
La herramienta "Eliminar metadata" (`meta.strip`) no nace de cero: el enfoque
general y varias técnicas concretas están descritas públicamente por otros
proyectos. Queremos **acreditar sin exagerar y sin apropiarnos de nada**: decir
qué técnica adoptamos, de quién, bajo qué licencia y —sobre todo— **qué está
realmente implementado hoy frente a lo que solo está planificado**. También hay
que dejar claro que no existe afiliación ni respaldo.

El inventario exhaustivo de metadata y la identificación de cajas `uuid`
(C2PA/JUMBF y XMP) hacen que esta trazabilidad importe: el visor muestra esas
entradas, así que conviene documentar su origen.

## Decisión
Registrar la procedencia **por técnica**, con su estado real. Se adoptan
enfoques, no código: ningún fragmento se ha copiado ni portado.

1. **Eliminación de metadata y orientación EXIF** — inspirada en
   [`jvoisin/mat2`](https://github.com/jvoisin/mat2) (**LGPL-3.0**).
   Implementado: cirugía lossless de metadata por formato y el criterio de
   enderezar la foto al borrar `Orientation` (equivalente a
   `apply_embedded_orientation`). Es la atribución ya visible en la app
   ("Método inspirado en MAT2").
   Límite: no se copió código; por eso no se reproduce el texto de la LGPL-3.0
   (esa obligación aplica a la distribución de código derivado, que aquí no
   existe).

2. **Identificación de Content Credentials (C2PA/JUMBF) y cajas XMP `uuid`** —
   técnica adoptada de
   [`iAnonymous3000/metadata-remover`](https://github.com/iAnonymous3000/metadata-remover)
   (**MIT**).
   Implementado hoy: el lector recorre el contenedor, detecta las cajas `uuid`
   y las clasifica por su UUID en C2PA, XMP o desconocida, mostrándolas en el
   inventario con su ruta (`moov > udta > meta > ilst > ©xyz`, `moov > uuid`,
   `uuid`, …). Además, el strip YA elimina esas cajas `uuid`, pero como parte
   del bloque genérico de "basura" (`free`/`skip`/`wide`/`uuid`, un ítem de
   baja sensibilidad) y solo cuando ese bloque se selecciona o en modo
   profundo.
   **Planificado y aún NO implementado:** tratar Content Credentials (C2PA)
   como un bloque de privacidad propio, con su etiqueta y su control
   específicos. La distinción identificado ≠ privilegiado se mantiene: que la
   caja `uuid` sea visible y clasificable no implica que se ofrezca como un
   bloque de privacidad dedicado.
   Límite: no se copió código; el aviso MIT no se reproduce porque solo se
   distribuye el aviso cuando se distribuye código derivado.

3. **Referencia excluida** — [`lucasgelfond/exiftool-web`](https://github.com/lucasgelfond/exiftool-web)
   **no declara licencia**. Por eso **no se acredita como fuente** de código ni
   de técnica implementada, y no se insinúa su uso en ADEI-ONE.

4. **Sin afiliación ni respaldo.** ADEI-ONE no está afiliado, patrocinado ni
   respaldado por ninguno de los proyectos anteriores, ni a la inversa. La
   adaptación es independiente y los errores son responsabilidad exclusiva de
   ADEI-ONE.

5. **Materialización.** El `NOTICE` de la raíz recoge estas mismas reglas; la
   app muestra la atribución en el encabezado de la tool (`ToolWorkspace`).

## Consecuencias
- La atribución es **verificable y per-técnica**: cada afirmación se puede
  contrastar con lo que el código hace de verdad.
- El estado "identificado ≠ eliminado" para C2PA/JUMBF/XMP queda explícito: no
  se atribuye una eliminación que todavía no existe.
- No se arrastran obligaciones de licencia ajenas al no existir código portado;
  si en el futuro se portara código MIT/LGPL, habría que reproducir su licencia
  íntegra y revisar esta decisión.
- `exiftool-web` queda fuera por falta de licencia declarada, evitando una
  atribución que sugeriría un uso inexistente.
