# Procesamiento de vídeo A/B — exportación real y verificación

## Documentos relacionados y fuente de estado actual

Este archivo es la **especificación técnica complementaria** del mecanismo A/B. Para el recorrido real de implementación, diagnóstico, fallos, correcciones, inspección visual y entrega, consultar [CODELAB-A-B-SESSION-VIDEO-ARCHITECTURE.md](./CODELAB-A-B-SESSION-VIDEO-ARCHITECTURE.md), que es el documento owner y la fuente de verdad del estado más reciente. Las reglas operativas que debe seguir el agente están en [ANIMATION-AUTONOMOUS-WORKFLOW.md](./ANIMATION-AUTONOMOUS-WORKFLOW.md), especialmente la sección 5.2.

**Importante:** la evidencia y los hashes históricos que aparecen más abajo describen la primera prueba de revisión 2. No representan la última revisión aceptada. El estado actual y la evidencia A/B más reciente están registrados en el documento owner.

## Selección de proyecto

A inicia una sesión con el input `project_id` del proyecto PixelForge que ya está persistido en ADMIN. B tiene su propio input `project_id` y solo emite la petición cuando coincide con el proyecto fijado por A. Para procesar otro proyecto, iniciar A con ese ID y B con el mismo ID. El default histórico sigue siendo Soldier Walk. B no consulta el repositorio ni obtiene credenciales; A no lee GitHub ni decide el proyecto a partir del inbox.

## Propósito

A/B es la etapa que exporta el vídeo final del proyecto PixelForge persistido en ADMIN. El contrato vigente es deliberadamente asimétrico:

- A mantiene la sesión completa de CodeLab/PixelForge, abre el Video Composer real y genera el WebM.
- B solo solicita a A la exportación, recibe el archivo, lo verifica y termina.
- A sigue vivo hasta su propio timeout aunque B haya terminado.

No se permite que B cree animaciones, construya fotogramas, ejecute el exportador, use FFmpeg ni tenga acceso a Neon, S3 o al bridge.

## Flujo

1. El proyecto editable queda persistido en el workspace ADMIN de Neon.
2. El workflow A usa el bridge autenticado para leer y fijar el snapshot exacto del proyecto, incluyendo workspace, ID, serverRevision y contentSha256.
3. A obtiene un handoff ADMIN de un solo uso, abre el proyecto en PixelForge y mantiene un contexto Chromium persistente con PixelForge y Video Composer cargados.
4. B se conecta a una sesión A que ya está READY y publica una petición con sessionId, projectId, serverRevision y contentSha256.
5. A ejecuta exportPixelForgeAnimationVideo en su contexto persistente. El generador importa el paquete real en CodeLab Video Composer y exporta WebM.
6. A transfiere el WebM a B en bloques de base64 por el buzón del issue 492. A incluye tamaño, hash, revisión, FPS, fotogramas y metadatos del Composer.
7. B reúne los bloques, comprueba SHA-256 y cabecera EBML, decodifica el vídeo en Chromium y verifica duración, dimensiones y varios puntos temporales.
8. B guarda el WebM y verification.json como artefacto de GitHub Actions, publica el resultado y termina.
9. A no se detiene cuando B termina; mantiene la sesión hasta que venza su propio tiempo configurado.

## Separación de credenciales

| Recurso | A | B |
|---|---:|---:|
| CODELAB_AGENT_BRIDGE_CONTROL_SECRET | Sí | No |
| Snapshot ADMIN a través del bridge | Sí | No |
| Handoff/cookie de ADMIN | Sí, temporal | No |
| DATABASE_URL / Neon credentials | No | No |
| S3 / R2 credentials | No | No |
| Exportador Video Composer | Sí | No |
| Decodificación de verificación Chromium | Opcional | Sí |
| FFmpeg / codificación | No | No |

El servidor protege POST /api/agent/bridge/admin-handoff y GET /api/agent/bridge/pixelforge/projects/:projectId con CODELAB_AGENT_BRIDGE_CONTROL_SECRET. A es el único workflow que recibe ese secreto. El ticket de handoff expira y se consume una sola vez. B recibe únicamente los bytes del WebM y metadatos de la exportación.

## Workflows y scripts

- .github/workflows/codelab-independent-session-a.yml — inicia A y la mantiene viva.
- .github/workflows/codelab-independent-session-b.yml — solicita a A, verifica el WebM y termina.
- .github/workflows/codelab-ab-animation.yml — prueba integrada que inicia A como workflow independiente y luego ejecuta B; comprueba que A siga in_progress tras terminar B.
- .github/workflows/codelab-b-a-context-cycle.yml — alias para la prueba A/B real.
- scripts/codelab-ab-session-host.mjs — host A, lectura autenticada del snapshot ADMIN, sesión Chromium persistente y exportación real.
- scripts/codelab-ab-session-request.mjs — cliente B, transferencia, hash y decodificación de WebM.

Los workflows A/B ya no llaman al host local guest ni al fallback de demo de scripts/codelab-b-a-context-cycle.mjs. El código antiguo queda fuera de este flujo y no puede considerarse evidencia de la animación Soldier Walk.

## Proyecto de validación

- PixelForge — Soldier Walk.
- project_id: soldier-walk-60f-20261124.
- workspace ADMIN: ws_local_admin.
- revisión documentada: 2.
- 20 fotogramas, 12 FPS, 4 capas.
- content SHA-256 documentado: 82db7ee3d5195063fdff109f7e0ad7a30089a8c907e7387e81d13b1742e8b67f.

El ID histórico menciona 60f, pero la revisión persistida tiene 20 fotogramas. A fija una revisión y un hash; si cambian, se inicia una sesión A nueva para la revisión actual. No se mezcla contenido de distintas revisiones.

## Evidencia y aceptación A/B superada

Una exportación manual previa con el worker nativo de Render y el exportador real de Video Composer importó 20 fotogramas a 12 FPS y produjo un WebM de 115.027 bytes sin errores de página ni consola. El archivo quedó guardado en Neon como evidencia y se decodificó para obtener muestras.

La prueba integrada se ejecutó el 2026-11-24 y pasó todos los puntos de aceptación:

- Workflow A/B: [run 45363044941](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45363044941).
- Sesión A independiente: [run 45363094490](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45363094490).
- Workflow B independiente: [run 45364091746](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45364091746), completado con éxito; [artefacto B](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45364091746/artifacts/14906281619).
- Artefacto de B: [codelab-soldier-walk-webm-45363044941](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45363044941/artifacts/14904893307).
- Proyecto: revisión 2; 20 fotogramas; 12 FPS; 4 capas.
- Composer exportó WebM de 115.027 bytes, duración 1,66 s.
- SHA-256 del vídeo: 0abf2c19450625de90731b86740858859178ca57ca3120e6a17b3d47bcbec82f.
- Chromium verificó 1080 × 1350, readyState 4 y 5 muestras temporales decodificadas.
- B no ejecutó FFmpeg ni generó animación; únicamente recibió y verificó el WebM.
- El paso de independencia confirmó que A seguía in_progress después de que B terminó. A siguió in_progress tras B; el run A permaneció activo y tenía expiración programada a las 09:43:35 UTC.

La aceptación del transporte A→B y del flujo completo está superada. El artefacto de B incluye el WebM y verification.json.

Un run verde, un comentario de estado, un event_id o una grabación de pantalla no sustituyen el WebM recibido y verificado.
