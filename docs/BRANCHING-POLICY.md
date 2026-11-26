# CodeLab — Branching Policy

## Regla única: una sola rama de trabajo derivada de main

**CodeLab mantiene una sola rama principal: main, y permite una sola rama de trabajo activa a la vez, creada desde main.**

El trabajo nuevo no se desarrolla directamente sobre main. Se crea una única rama temporal de trabajo a partir del último main, y allí se implementa, documenta y prueba la tarea completa.

No deben existir varias ramas de trabajo activas en paralelo. Esto aplica a features, fixes, tests, regresiones, experimentos, documentación, PixelForge, Illustration, Pixel, Animation, Video Composer, Headless, Agent, importación y exportación.

La rama de trabajo es temporal: se integra en main cuando cumple los controles y luego se elimina. No se convierte en una rama permanente.

## Flujo obligatorio

~~~text
main actualizado
    ↓
crear UNA rama de trabajo desde main
    ↓
implementar + documentar + probar en esa rama
    ↓
revisar diferencias de código Y documentación contra main
    ↓
reconciliar cualquier diferencia o contradicción
    ↓
ejecutar CI / Actions y verificar resultados
    ↓
merge a main
    ↓
eliminar la rama temporal
    ↓
siguiente tarea: nueva rama desde el main actualizado
~~~

**Solo puede haber una rama de trabajo activa a la vez.** No se inicia otra tarea en una segunda rama mientras la rama de trabajo actual siga abierta o pendiente de integrar/cerrar.

## Antes de empezar una tarea

Todo agente debe:

1. Consultar el estado actual de main y confirmar su SHA.
2. Comprobar que no haya otra rama de trabajo activa para otra tarea.
3. Crear una sola rama temporal desde el último main.
4. Hacer todo el trabajo de esa tarea en esa rama, incluidos tests y documentación.
5. No crear ramas adicionales para dividir la tarea ni para ejecutar pruebas.
6. Mantener la rama actualizada con main si main cambia durante el trabajo y reconciliar los cambios antes de integrar.

## Documentación: requisito obligatorio antes del merge

**Antes de fusionar, la documentación de la rama de trabajo y la documentación existente en main deben estar reconciliadas y no deben diferir de forma contradictoria, incompleta o desactualizada.**

La comparación no significa que ambos árboles deban tener archivos idénticos: significa que todos los documentos relacionados, en ambos lados, deben describir el mismo comportamiento, contratos, nombres, límites, formatos y flujos que tendrá el código después del merge.

Antes de aprobar el merge hay que:

- revisar los documentos relevantes existentes en main y los cambios documentales de la rama;
- integrar en la rama cualquier actualización documental necesaria;
- resolver duplicados, contradicciones y descripciones obsoletas;
- confirmar que la documentación refleja la implementación final y no una etapa intermedia;
- comprobar que ningún documento de main que siga vigente contradiga la nueva documentación;
- repetir la revisión después de resolver conflictos o actualizar la rama con main.

**No se fusiona mientras la documentación de ambas partes no esté reconciliada.** La documentación es parte del cambio, no una tarea opcional posterior al merge.

## Pruebas y verificación

Las pruebas se ejecutan en la única rama de trabajo activa, que debe partir del main vigente.

1. Registrar el SHA base de main.
2. Implementar y ejecutar las pruebas necesarias en la rama de trabajo.
3. Corregir fallos en esa misma rama.
4. Ejecutar nuevamente las pruebas afectadas y las regresiones relevantes.
5. Verificar los Actions/checks del SHA exacto que se pretende fusionar.
6. Revisar el diff final de código y documentación contra main.
7. Solo entonces fusionar.

No se crea una rama separada para tests, para resultados de CI, para experimentos ni para una segunda etapa de la misma tarea.

## Ramas antiguas: clasificación para eliminación

Las siguientes ramas fueron identificadas durante la limpieza y **no forman parte del flujo vigente**. Son candidatas a eliminación por estar obsoletas, divergidas de main o corresponder a trabajos ya integrados/cerrados:

- feat/pixelforge-tiled-package-export
- test/pixelforge-raster-tools-e2e
- test/pixelforge-animation-browser-e2e
- test/video-composer-actions-worker
- feat/pixelforge-ui-tools-e2e
- feature/pixelforge-core-tool-regressions
- feature/pixelforge-raster-regression-tests
- integration/reconcile-main-2026-11-03

La rama feat/pixelforge-tiled-spritesheet-export ya fue integrada en main. Si aún existe como referencia remota, es histórica y también debe eliminarse.

Antes de borrar una rama antigua, comprobar si contiene commits o cambios exclusivos que aún sean necesarios. Rescatar únicamente lo necesario, aplicarlo a la rama de trabajo única creada desde main, verificarlo y después eliminar la rama histórica. Nunca reanudar el desarrollo sobre una rama obsoleta.

## Qué hacer si main cambia mientras se trabaja

Si otro cambio se integra en main mientras la rama temporal está activa:

- detener cualquier intento de abrir una segunda rama;
- actualizar/rebasar la única rama de trabajo desde main según el flujo seguro del repositorio;
- resolver conflictos;
- volver a revisar código, tests y documentación;
- repetir los checks requeridos antes del merge.

## Regla estricta para futuros agentes

Un agente no debe crear ramas paralelas porque la tarea sea grande, tenga varias etapas, necesite pruebas, sea experimental o tarde varios días.

**Una sola rama temporal de trabajo a la vez. Una sola rama principal: main.** Cada tarea se termina, verifica, documenta, fusiona y limpia antes de iniciar la siguiente rama de trabajo.

~~~text
main
  ↓
UNA ÚNICA RAMA TEMPORAL
  ↓
código + documentación + pruebas
  ↓
reconciliación y verificación
  ↓
merge a main
  ↓
eliminar rama temporal
~~~

La existencia de ramas antiguas en GitHub no modifica esta política.
