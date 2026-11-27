# CodeLab — Branching Policy

## Regla única: una rama principal y una rama permanente de pruebas

**CodeLab mantiene `main` como rama principal de integración y una única rama compartida y permanente para TODO el trabajo de pruebas: `test/pixelforge-illustration-impact-animation`.** El nombre conserva su origen histórico, pero su alcance queda generalizado: no es exclusiva de la animación Illustration.

El desarrollo de producto se prepara desde `main` siguiendo el flujo de integración vigente. La rama de pruebas es el único destino autorizado para ejecutar y mantener pruebas, validaciones, regresiones, experimentos de QA y evidencia de cualquier área del proyecto: PixelForge, Illustration, Pixel, Animation, Video Composer, Headless, Agent, importación/exportación, documentación y demás módulos.

No se crean ramas de prueba adicionales por tarea, módulo, tipo de test, experimento ni duración. La rama de pruebas NO se elimina después de cada tarea: se conserva y reutiliza para todas las pruebas futuras. Solo se elimina si el usuario cambia expresamente esta política y se establece una sustituta.

## Flujo obligatorio

~~~text
main (código fuente de integración)
    ↓
actualizar la rama compartida de pruebas desde main cuando corresponda
    ↓
test/pixelforge-illustration-impact-animation
    ↓
ejecutar TODAS las pruebas + regresiones + QA + evidencia
    ↓
revisar código y documentación frente a main
    ↓
reconciliar diferencias y verificar Actions
    ↓
reportar resultados; integrar cambios de producto por el flujo aprobado
~~~

**La única rama de pruebas es permanente y se reutiliza indefinidamente.** Una sola rama de pruebas activa significa que no se abren ramas paralelas para cada nueva tarea.

## Antes de empezar una tarea

Todo agente debe:

1. Consultar el estado actual de main y confirmar su SHA.
2. Confirmar que la rama compartida `test/pixelforge-illustration-impact-animation` existe y es la única rama de pruebas autorizada.
3. Actualizarla/reconciliarla con el `main` vigente de forma segura antes de validar cambios que dependan de código nuevo.
4. Ejecutar allí todos los tests, regresiones, experimentos y comprobaciones, sin crear ramas paralelas.
5. Mantener evidencia de qué SHA de `main` y qué SHA de la rama de pruebas se validaron.
6. No renombrar, eliminar ni sustituir la rama permanente sin autorización expresa del usuario.

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

Todas las pruebas se ejecutan en la rama permanente `test/pixelforge-illustration-impact-animation`, actualizada/reconciliada con el `main` vigente.

1. Registrar el SHA base de main.
2. Implementar y ejecutar las pruebas necesarias en la rama de trabajo.
3. Corregir fallos en esa misma rama.
4. Ejecutar nuevamente las pruebas afectadas y las regresiones relevantes.
5. Verificar los Actions/checks del SHA exacto que se pretende fusionar.
6. Revisar el diff final de código y documentación contra main.
7. Solo entonces fusionar.

No se crea ninguna rama adicional para tests, resultados de CI, experimentos, módulos nuevos ni etapas posteriores. La rama compartida conserva el historial y la evidencia de pruebas.

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

## Qué hacer si main cambia

Cuando `main` avance:

- no crear una rama de pruebas nueva;
- actualizar/reconciliar la rama permanente de pruebas con el nuevo `main` mediante merge o rebase seguro, sin descartar su historial de evidencia;
- resolver conflictos;
- revisar de nuevo código, tests y documentación;
- registrar los SHAs exactos de base y validación;
- repetir los checks afectados.

## Regla estricta para futuros agentes

Un agente no debe crear ramas paralelas porque la tarea sea grande, tenga varias etapas, necesite pruebas, sea experimental o tarde varios días.

**`main` + UNA ÚNICA RAMA PERMANENTE DE PRUEBAS.** La rama de pruebas nunca se elimina al cerrar una tarea; se reutiliza para todas las pruebas futuras. La integración de cambios de producto y la promoción a `main` siguen el flujo de revisión aprobado, pero los tests siempre se ejecutan en la rama compartida.

~~~text
main
  ↓ sincronizar/reconciliar
 test/pixelforge-illustration-impact-animation
  ↓
TODAS las pruebas, QA y regresiones
  ↓
reconciliar docs + revisar evidencia
~~~

La existencia de ramas antiguas en GitHub no modifica esta política.

## Alcance de la rama permanente

La rama `test/pixelforge-illustration-impact-animation` se creó inicialmente para la prueba de animación Illustration basada en la imagen aportada por el usuario. **Desde esta revisión, deja de ser una rama específica de esa prueba y pasa a ser la rama permanente para TODAS las pruebas futuras de CodeLab.**

La primera prueba que se ejecutará allí es la secuencia Illustration: preparación de poses, golpe, desplazamiento del personaje golpeado por el aire, caída y pose final en el suelo. El proyecto debe permanecer editable, con frames y capas; un vídeo externo por sí solo no demuestra la integración.

El modo de autoría de todos los frames/capas de esa prueba debe ser explícitamente `illustration` (o el identificador canónico del contrato vigente), sin inferirlo por índice ni convertirlo a Pixel. Después de esta prueba, la misma rama seguirá utilizándose para cualquier test futuro, sea o no de animación.
