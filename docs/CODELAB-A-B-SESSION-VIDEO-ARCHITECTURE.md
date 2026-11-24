# CodeLab A/B — ADMIN Soldier Walk y Video Composer

**Contrato vigente:** A genera el vídeo con el Video Composer real. B solo solicita el trabajo a A, recibe el WebM, lo verifica y termina. A sigue vivo hasta su propio timeout, independientemente de B.

## Responsabilidades

### A — sesión persistente y generador

A es el único proceso autorizado para acceder a la sesión ADMIN y generar el vídeo.

1. Usa CODELAB_AGENT_BRIDGE_CONTROL_SECRET, disponible solo en el workflow A, para leer el snapshot del proyecto desde el bridge ADMIN.
2. Fija project_id, workspace_id, serverRevision y contentSha256; no sustituye el proyecto por una demo ni por una copia local.
3. Obtiene un handoff ADMIN de un solo uso y abre el proyecto real en PixelForge.
4. Mantiene abiertas la sesión ADMIN de PixelForge y la página real de Video Composer en un contexto Chromium persistente.
5. Cuando recibe una solicitud de B, ejecuta exportPixelForgeAnimationVideo dentro de ese contexto, usando el proyecto fijado y persist_evidence:false para devolver el archivo a B sin entregar credenciales.
6. Envía el WebM a B en bloques de base64, junto con SHA-256 y metadatos de la exportación.
7. Continúa atendiendo solicitudes y mantiene su sesión hasta CODELAB_SESSION_MINUTES, aunque B ya haya terminado.

A no recibe DATABASE_URL, claves de Neon ni claves de S3. El bridge token solo está en A. El handoff ADMIN es de un solo uso y no se comparte con B.

### B — solicitante y verificador

B no genera ni codifica animaciones.

1. Descubre o recibe el ID de una sesión A que ya está READY.
2. Envía a A una solicitud con el ID del proyecto y la revisión/hash fijados por A.
3. Recibe los bloques de vídeo, reconstruye el WebM y comprueba el SHA-256, tamaño y cabecera EBML.
4. Abre el archivo en Chromium y verifica que el navegador pueda decodificarlo, leer duración y dimensiones, y buscar varios puntos del vídeo.
5. Guarda el WebM y verification.json como artefacto de GitHub Actions.
6. Publica el resultado y termina inmediatamente; no espera a que A expire.

B no recibe ni usa CODELAB_AGENT_BRIDGE_CONTROL_SECRET, DATABASE_URL, Neon, S3, R2, cookies ADMIN ni tickets de handoff. B no importa exportPixelForgeAnimationVideo, no usa FFmpeg y no construye fotogramas.

## Transporte A → B

El buzón es el issue 492 del repositorio. A publica un comentario [CodeLab A Ready], B publica [CodeLab B Request], y A devuelve comentarios [CodeLab A Video Chunk] y [CodeLab A Export Result]. Los bloques están limitados a 30.000 caracteres para mantenerse por debajo del límite de comentarios de GitHub. B los reúne por sessionId y requestId y valida el hash antes de escribir el archivo.

## Workflows

| Workflow | Función |
|---|---|
| .github/workflows/codelab-independent-session-a.yml | Arranca A con el bridge secreto y mantiene la sesión hasta su timeout. |
| .github/workflows/codelab-independent-session-b.yml | B solicita la exportación, recibe el archivo, lo verifica y termina. No contiene secretos de bridge/Neon. |
| .github/workflows/codelab-ab-animation.yml | Prueba integrada: despacha A como workflow separado, ejecuta B y comprueba que A siga in_progress después de que B termina. |
| .github/workflows/codelab-b-a-context-cycle.yml | Alias heredado que ahora despacha la prueba A/B real; ya no ejecuta el generador demo. |

A puede durar hasta 360 minutos; B tiene su propio límite de espera. La concurrencia de B evita dos procesadores simultáneos.

## Bridge ADMIN

El servidor expone dos operaciones protegidas por CODELAB_AGENT_BRIDGE_CONTROL_SECRET:

- POST /api/agent/bridge/admin-handoff: emite un ticket ADMIN de un solo uso y de corta duración.
- GET /api/agent/bridge/pixelforge/projects/:projectId: devuelve el snapshot completo y metadatos del proyecto dentro del workspace ADMIN.

Ambas operaciones comprueban el bridge token en el servidor. El snapshot se limita a ws_local_admin. B no conoce estas rutas ni recibe el token. El ticket se consume en GET /api/auth/native-handoff y se convierte en una cookie normal del navegador A.

## Proyecto fijado

- Proyecto: PixelForge — Soldier Walk.
- ID: soldier-walk-60f-20261124 (el identificador histórico contiene “60f”; el proyecto persistido tiene 20 fotogramas).
- Workspace: ws_local_admin.
- Revisión documentada: 2.
- Timeline documentado: 20 fotogramas, 12 FPS, 4 capas.
- Hash de contenido documentado: 82db7ee3d5195063fdff109f7e0ad7a30089a8c907e7387e81d13b1742e8b67f.

A fija la revisión y el hash al iniciar. Si el proyecto cambia, una sesión A nueva debe leer y fijar la nueva revisión; no se permite mezclar fotogramas de revisiones distintas.

## Evidencia y estado

Se ejecutó previamente una exportación real mediante el worker nativo de Render y pixelforge-video-composer-export.mjs:
- Composer importó 20 fotogramas a 12 FPS.
- WebM generado: 115.027 bytes.
- Sin errores de página ni de consola.
- El archivo se guardó como evidencia en Neon y se pudo decodificar para extraer muestras.

La prueba integrada A/B se ejecutó el 2026-11-24 y pasó:

- Workflow A/B: [run 45363044941](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45363044941).
- Sesión A independiente: [run 45363094490](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45363094490).
- Workflow B independiente: [run 45364091746](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45364091746), completado con éxito; [artefacto B](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45364091746/artifacts/14906281619).
- Artefacto B: [descargar codelab-soldier-walk-webm-45363044941](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45363044941/artifacts/14904893307).
- Proyecto ADMIN: revisión 2, hash 82db7ee3d5195063fdff109f7e0ad7a30089a8c907e7387e81d13b1742e8b67f.
- Composer importó 20 fotogramas a 12 FPS; generó un WebM de 115.027 bytes y 1,66 s.
- B verificó SHA-256 0abf2c19450625de90731b86740858859178ca57ca3120e6a17b3d47bcbec82f.
- Chromium decodificó 1080 × 1350, readyState 4 y 5 de 5 muestras temporales.
- A no reportó errores de página ni de consola. B no ejecutó FFmpeg ni el generador.
- El paso “Verify A remains alive after B has finished” terminó correctamente. La sesión A seguía in_progress al comprobarla a las 09:14 UTC y tenía expiración prevista a las 09:43:35 UTC.

La aceptación integrada A/B está superada. El artefacto de B contiene el WebM recibido y verification.json. A permanece activa por su propio timeout; su estado no depende de que B haya terminado.

No se considera válido un createDemo, una grabación de pantalla de la sesión, un event ID aislado o un resultado success sin el WebM real.
