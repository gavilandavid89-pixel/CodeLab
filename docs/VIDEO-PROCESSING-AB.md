# Procesamiento de vídeo A/B — exportación real y verificación

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

## Evidencia previa y aceptación pendiente

Una exportación manual previa con el worker nativo de Render y el exportador real de Video Composer importó 20 fotogramas a 12 FPS y produjo un WebM de 115.027 bytes sin errores de página ni consola. El archivo quedó guardado en Neon como evidencia y se decodificó para obtener muestras.

Esta prueba confirma el generador real, pero no equivale a la aceptación del nuevo transporte A→B. La aceptación final requiere ejecutar codelab-ab-animation.yml y confirmar simultáneamente:
- A restaura la revisión ADMIN correcta y mantiene PixelForge/Composer abiertos.
- A genera el WebM con el Composer real.
- B recibe todos los bloques, reconstruye el mismo SHA-256 y decodifica el archivo.
- B publica el artefacto y termina.
- A continúa in_progress después de terminar B y solo expira al llegar a su timeout.

Un run verde, un comentario de estado, un event_id o una grabación de pantalla no sustituyen el WebM recibido y verificado. No se debe declarar entregado el vídeo hasta que el artefacto de B exista y pase las comprobaciones.
