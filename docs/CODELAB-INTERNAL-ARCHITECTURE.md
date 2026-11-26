# CodeLab — arquitectura interna y mapa de componentes

**Estado:** mapa técnico de orientación para agentes y desarrolladores.  
**Alcance:** describe los límites entre componentes, responsabilidades, flujos de datos y contratos que no deben romperse. No sustituye las especificaciones especializadas enlazadas abajo.  
**Regla de mantenimiento:** actualizar este documento cuando cambie una frontera entre componentes, el propietario de un estado, un protocolo o un flujo de persistencia. La implementación y sus pruebas siguen siendo la autoridad final.

> Este documento describe la arquitectura de la rama en la que se actualiza. No demuestra por sí solo que esa rama esté desplegada en producción. Antes de modificar una integración, inspeccionar el código y las pruebas actuales.

## 1. Modelo mental

CodeLab es una aplicación web Node.js con estudios/herramientas en el frontend, un servidor HTTP que coordina autenticación y persistencia, PostgreSQL/Neon como fuente durable de estado y procesos auxiliares para trabajos autorizados. PixelForge es un estudio creativo integrado, no un servicio aislado: comparte el servidor, la identidad/workspace, el transporte de artefactos y la persistencia de CodeLab.

Separar siempre estas responsabilidades:

1. **Interfaz:** presenta controles y estado al usuario; no es la autoridad de persistencia.
2. **Runtime de dominio:** aplica operaciones de edición sobre documentos (por ejemplo, PixelForge).
3. **API/servidor:** autentica, valida, autoriza y coordina las escrituras.
4. **Persistencia:** conserva estado durable, revisiones y referencias.
5. **Worker:** completa órdenes previamente autorizadas; no decide iniciar tareas creativas nuevas.
6. **Agente IA:** interpreta la petición, decide el trabajo creativo y utiliza su propio entorno Headless.
7. **CI/GitHub:** versiona y valida software; no es el almacén normal de proyectos editables.

## 2. Mapa de componentes

| Componente | Ubicación principal | Responsabilidad | No debe asumir |
|---|---|---|---|
| Aplicación HTTP | `server.js` | Servir la aplicación, autenticación, workspaces, APIs, validación y coordinación con PostgreSQL/worker | Que el filesystem efímero sea persistencia durable |
| Runtime compartido de estudios | `public/studio-core.js` | Reutilizar semántica de sesión, configuración de IA y peticiones same-origin entre estudios | Ser un backend o almacenar el estado canónico del proyecto |
| Frontend público | `public/` | UI, navegación y experiencias de estudio | Autorizar operaciones ni saltarse validaciones del servidor |
| PixelForge editor | `public/pixelforge/src/editor.js` | Orquestar edición, herramientas, capas, documento activo, modos y UI del editor | Que toda ruta tiled tenga ya paridad con el modelo denso |
| Modelo raster PixelForge | `public/pixelforge/src/core.js` | Documento raster y capas en el modelo denso heredado | Que el límite denso desaparezca por existir un adaptador sparse |
| Animación PixelForge | `public/pixelforge/src/animation.mjs` y `animation-tiled-adapter.mjs` | Timeline densa heredada y timeline sparse para documentos tiled | Que el adaptador dense-to-tiled se use para iniciar nuevas animaciones tiled |
| Almacenamiento sparse/tiled | `public/pixelforge/src/animation-tiles.mjs`, `raster-tiled-adapter.mjs`, `animation-tiled-adapter.mjs` y módulos relacionados | Recursos RGBA dispersos, ownership por píxel, referencias compartidas proyecto/animación, copy-on-write, lectura/escritura regional e historial por frame | Que el store en memoria sea almacenamiento durable remoto o que todas las herramientas densas estén migradas |
| Runtime Headless de PixelForge | `public/pixelforge/src/headless.js` y artefacto del workflow correspondiente | Exponer operaciones de proyecto para automatización/edición fuera de la UI | Que sea el worker de CodeLab o que reciba credenciales internas |
| Video Composer | `public/pixelforge/video-composer.js`, `src/video-capture-layout.mjs`, encoder y worker | Capturar/componer frames y codificar salida respetando geometría, sampling y timeline | Que cambiar FPS invente poses o que el formato de salida cambie el lienzo fuente |
| Bridge/worker de órdenes | `agent-bridge-worker.mjs` y coordinación desde `server.js` | Reclamar y completar órdenes persistidas y autorizadas; guardar resultados | Que una notificación sea la orden durable o que el worker sea el agente IA |
| Persistencia | Neon PostgreSQL y módulos de almacenamiento/validación | Estado de cuentas, workspaces, órdenes, proyectos, revisiones y metadatos | Que los vídeos/capturas sustituyan el documento editable |
| Evidencia/objetos | módulos de evidencia y almacenamiento configurado | Guardar bytes de evidencia y metadatos/referencias | Que el endpoint público de evidencia sea automáticamente válido para assets privados |
| CI | `.github/workflows/` | Ejecutar suites y publicar artefactos de build cuando corresponda | Que CI haya probado producción o que un artefacto equivalga a despliegue |

Los nombres de archivo son puntos de entrada, no una lista exhaustiva de todos los módulos. Seguir imports y pruebas al rastrear una responsabilidad.

## 3. Flujos principales

### 3.1 Solicitud web normal

```text
Navegador
  → frontend/estudio
  → petición same-origin
  → server.js
  → autenticación + autorización + validación
  → Neon / servicio de dominio
  → respuesta al frontend
```

El navegador puede mantener estado temporal o caché. El servidor debe volver a validar identidad, workspace, límites y permisos para toda operación persistente.

### 3.2 Trabajo creativo autónomo del agente

```text
Usuario
  → agente IA
  → Headless propio instalado en el entorno del agente
  → crear/editar/validar proyecto
  → exportar .codelab
  → agente transfiere por HTTPS inline bridge
  → staging durable + orden de importación
  → worker CodeLab
  → workspace/proyecto persistido
  → lectura de vuelta y verificación
```

El Headless propio del agente y el worker/Headless de CodeLab son sistemas distintos. El agente crea y edita; CodeLab recibe, importa, persiste y presenta el proyecto. El Headless no recibe credenciales Neon, R2, cookies ni secretos internos. HTTP 202 significa que una operación fue encolada, no que ya se guardó.

### 3.3 Cola durable y activación del worker

```text
INSERT/UPDATE orden queued en Neon
  → trigger PostgreSQL
  → NOTIFY codelab_agent_bridge_wake
  → listener dedicado en server.js
  → inicia/despierta agent-bridge-worker.mjs
  → worker reclama fila durable con bloqueo transaccional
  → ejecuta acción autorizada
  → guarda estado, resultado y evidencia
```

La fila SQL es la fuente durable; NOTIFY es solo una señal de activación. El worker reclama órdenes existentes, no crea nuevas tareas del agente. No reintroducir polling continuo, cron de keep-alive ni pings de reposo sin una decisión de arquitectura y pruebas.

### 3.4 Proyecto PixelForge

```text
UI / Headless
  → documento PixelForge + capas + frames/cels
  → serialización / paquete nativo
  → API CodeLab validada
  → Neon: proyecto + revisión + hash
  → lectura de vuelta / reapertura
```

El proyecto editable y su revisión son la fuente de verdad. PNG, capturas y vídeo son representaciones o evidencia, no reemplazos del documento editable.

## 4. Contratos de frontera que deben preservarse

### Identidad y workspace
- Reutilizar la sesión y la identidad/workspace resueltos por CodeLab; no inventar IDs ni hardcodear el workspace del usuario.
- El cliente no puede decidir por sí solo qué workspace está autorizado.
- No pedir ni imprimir secretos; no copiar credenciales internas al Headless del agente.

### Estado y persistencia
- Distinguir estado local, staging temporal, estado persistido en workspace y lectura de vuelta.
- Una respuesta HTTP exitosa o un estado queued no demuestra persistencia final.
- Las escrituras con revisión deben detectar conflictos; nunca sobrescribir silenciosamente una revisión más nueva.
- No usar capturas/vídeos como reconstrucción del estado editable si el proyecto nativo está disponible.

### Configuración de proveedores de IA
- Las claves/configuraciones de proveedores pertenecen al usuario que las configura en la sección **APIs** de la aplicación.
- No convertir variables de desarrollo personales (por ejemplo, claves usadas durante beta) en credenciales globales compartidas.
- No asumir que una clave del entorno del servidor está disponible para todos los usuarios. Mantener aislamiento por cuenta y respetar el flujo de configuración existente.

### PixelForge: modos de dibujo
- `illustration` y `pixel-art` son modos del mismo producto PixelForge, no dos aplicaciones separadas.
- El modo activo del proyecto es un valor por defecto de edición; no redefine retrospectivamente el contenido existente.
- El modo de autoría por capa/frame/cel debe sobrevivir al guardado, duplicación, importación/exportación y composición.
- Cambiar de modo no debe resamplear, aplanar ni modificar píxeles, geometría, capas o timing.
- En contenido mixto, el procesamiento visual debe resolver el modo por capa/cel; no aplicar un filtro global después de aplanar.
- El editor usa el modelo tiled para documentos de al menos 1.048.576 píxeles; la integración está activa pero la paridad de herramientas sigue siendo parcial. Consultar [la auditoría post-merge PixelForge](PIXELFORGE-POST-MERGE-AUDIT-2026-11-26.md) para la lista concreta de rutas habilitadas y bloqueadas.

### Video Composer
- El lienzo fuente mantiene su geometría. El formato de salida define el contenedor, no una deformación del proyecto.
- `contain` conserva toda la imagen con bandas cuando haga falta; `cover` llena recortando. Ninguno debe estirar de forma no uniforme.
- Ilustración usa sampling suave; pixel-art usa nearest-neighbor. Si conviven capas, aplicar sampling por capa.
- FPS de salida puede repetir poses existentes; no equivale a interpolación de movimiento.

## 5. Reglas para modificar componentes

Antes de editar:
1. Leer `AGENTS.md` y `docs/agent-ai-bridge-policy.md`.
2. Consultar [el índice documental](README.md) para elegir el contrato especializado.
3. Seguir el flujo desde UI/API hasta modelo, persistencia y lectura de vuelta.
4. Localizar pruebas unitarias, de contrato, integración y browser que cubran la misma frontera.
5. Confirmar si el componente es canónico, adaptador de compatibilidad, prototipo o camino legado.

Durante la edición:
- Mantener las responsabilidades separadas; no duplicar lógica de autorización en UI.
- No crear una segunda fuente de verdad para un estado que ya pertenece al modelo o a Neon.
- No cambiar formatos versionados in-place ni alterar el significado de campos existentes.
- Mantener compatibilidad de lectura con proyectos legacy cuando el contrato lo requiera.
- No habilitar en UI una operación que el modelo, la historia o la persistencia no puedan soportar de extremo a extremo.
- Para cambios de modo, capas, frames o cels, probar ida y vuelta y cambios intermedios, no solo el estado inicial.
- Para exportación, inspeccionar dimensiones y frames decodificados; comprobar que el proyecto fuente no cambió.

Después de editar:
- Ejecutar primero la suite más específica, luego las suites afectadas y finalmente la validación amplia aplicable.
- Inspeccionar el resultado de cada workflow; no llamar “verde” a uno en ejecución o cancelado.
- Si un flujo incluye artefactos, comprobar su contenido real y no solo que el workflow terminó.
- Documentar el estado como **implementado**, **parcial**, **planificado** o **no verificado**. No convertir un diseño futuro en capacidad actual.

## 6. Estado conocido de PixelForge (corte de esta revisión)

| Área | Estado | Precisión necesaria |
|---|---|---|
| Modos illustration/pixel-art | Persistencia y propagación en documentos densos, Headless y paquetes estructurados | No significa que todas las herramientas tiled estén migradas |
| Cambio de modo | No destructivo y basado en metadatos | No debe reescribir píxeles ni geometría |
| Capas y cels tiled | Documento tiled usado como modelo activo desde 1.048.576 píxeles; referencias sparse y operaciones regionales | Algunas herramientas densas y flujos auxiliares aún no tienen paridad; ver auditoría post-merge |
| Herramientas tiled | Brush/eraser, fill, gradientes, contornos geométricos, selección rectangular/elíptica/lasso, pan y eyedropper | Magic wand, transforms, clipboard, flip, color replacement y outline generation siguen bloqueados; consultar auditoría post-merge |
| Historia tiled | Historia transaccional de trazos y operaciones de metadatos de capa; timeline conserva un historial independiente por frame | No implica que todos los comandos densos tengan equivalente tiled |
| Animación tiled | Timeline integrada en el editor: frame switching por referencias compartidas, add/duplicate/delete/reorder, FPS/duración, onion skin regional, thumbnails sparse, playback, autosave y export por lotes | Mantener explícitas las limitaciones de herramientas tiled y no convertir cels a buffers RGBA completos |
| Ownership Illustration/Pixel Art | Plano sparse por píxel separado de RGBA; guardas en rutas raster dense/tiled y snapshots de historia/frame | No asumir cobertura de cada caller directo, patch remoto ni export RGBA legacy |
| Video nativo mixto | Compositor/exportador por capa conserva modo y sampling | Paquetes legacy aplanados no pueden recuperar metadatos por capa ausentes |
| Persistencia tiled | Snapshots completos más patch incremental de un cel de animación cuando el cambio es elegible; endpoint PostgreSQL con revisión/CAS e idempotencia | Cambios estructurales o múltiples cels usan snapshot; el patch no sustituye todos los caminos de guardado |

Este cuadro es una fotografía técnica y debe actualizarse con código y pruebas antes de cada gran hito.

### 6.1 Ownership mixto por píxel (Illustration + Pixel Art)

El modo activo y la propiedad del contenido son conceptos distintos. El modo activo selecciona el perfil de herramientas; **no** autoriza a modificar píxeles que pertenecen al otro estilo.

- `raster-style-ownership.mjs` define los owners: `0` = unowned/legacy, `1` = Illustration y `2` = Pixel Art. El plano de ownership es metadata separada de RGBA: no es un canal de color ni debe alterar el aspecto exportado.
- La propiedad es por píxel dentro del cel/frame, no solo por documento o capa. El modo de autoría/perfil por capa o frame recuerda preferencias de herramientas; no sustituye el ownership individual.
- Dibujo, fill, gradiente y contorno pueden modificar píxeles unowned o del mismo owner. Un píxel del otro estilo se bloquea byte por byte: no se mezcla, suaviza, reemplaza ni borra.
- Erase solo modifica píxeles del estilo activo. Si un píxel queda totalmente transparente, su owner vuelve a `0`. El primer write real sobre un píxel unowned reclama ese píxel para el modo activo.
- Los writes normales deben pasar por una frontera protegida y confirmar RGBA + ownership de forma atómica. Undo/redo/cancel/restore son operaciones privilegiadas explícitas y deben restaurar ambos planos juntos.
- Copy-on-write, duplicación de cel, cambio de frame, serialización de manifiestos, autosave/recovery e importación deben conservar el plano de ownership. Los proyectos legacy sin plano se leen como unowned; nunca inferir su estilo desde el modo global actual.
- El export RGBA-only no contiene ownership. Reimportar ese archivo no puede reconstruir la propiedad original; usar formatos nativos/manifiestos versionados para round-trip mixto.

**Implementación conocida en esta rama:** hay ownership sparse en el modelo raster denso y en cels tiled; las rutas brush/eraser, fill, gradient, shape outline, color replacement, paste/transform y batch writes tienen cobertura en distintos adaptadores, y la historia/animación conserva snapshots de ownership. Esto no elimina la obligación de auditar callers directos, AI/Headless/scripts y cada camino de persistencia antes de declarar cobertura total. Los detalles y la matriz de rutas están en [contrato de ownership](pixelforge-mixed-style-ownership.md) y [mapa de rollout](pixelforge-mixed-style-ownership-rollout.md).

### 6.2 Límites de sync remoto y evidencia visual

- El endpoint `POST /api/pixelforge/projects/:projectId/patches` ya recibe, valida y aplica de forma durable patches de cels tiled de animación bajo revisión/CAS e idempotencia PostgreSQL. No confundir este alcance con parches para cels base fuera de timeline.
- La persistencia admite snapshots JSONB completos (`PUT /api/pixelforge/projects` o `/uploads` por chunks) y patches incrementales de un cel de animación cuando el editor confirma que el delta es elegible. Los cambios estructurales, metadatos, múltiples cels y formatos no compatibles continúan por snapshot.
- **Envelope tiled con animación:** `pixelforge-tiled-project-validation.js` valida ahora `animation` cuando usa `pixelforge-tiled-animation` v1. Comprueba dimensiones, FPS, frame activo, IDs/orden de capas, límites de frames/duración, cels tiled y metadatos `authoringMode`; los tiles RGBA y ownership de todos los cels se validan bajo los mismos límites sparse. El proyecto y la animación se guardan juntos en el snapshot JSONB y pasan por la misma revisión/CAS.
- **Parches incrementales:** `POST /api/pixelforge/projects/:projectId/patches` requiere sesión, proyecto tiled con animación y `baseRevision` exacta. `pixelforge-patch-store.js` valida el target frame/layer, coordenadas, dimensiones edge, base64/SHA-256, ownership 0/1/2, y aplica RGBA + ownership bajo una transacción PostgreSQL con `SELECT ... FOR UPDATE`. `codelab_pixelforge_patch_operations` garantiza idempotencia por `operationId`: repetir el mismo payload devuelve el receipt; reutilizar el ID con otro payload devuelve conflicto. El cambio del proyecto, revisión, digest y receipt se confirman en la misma transacción.
- El cliente expone `applyCelPatch(project, patch)` y el coordinador de autosave de `editor.js` genera/aplica el patch cuando el snapshot difiere en exactamente un cel de animación y los metadatos estructurales permanecen estables. Los casos fuera de ese subconjunto usan snapshot save. El endpoint aplica parches a cels tiled de animación, no a cels base fuera de timeline.
- El workflow verde de unit/integration/validation no sustituye una prueba browser que demuestre playback visible. Para playback, la evidencia debe comparar frames realmente renderizados durante el reloj de animación y verificar que el timeline/fixture tiene al menos dos poses visualmente distintas. No reducir el requisito a un click ni desactivar la aserción si falla.
- Incidente E2E resuelto en el commit `55db5bd00b016ab3382cdf88d9a6a7ca1da8da69`: la página abría con `capture=video`, que iniciaba automáticamente la animación en modo no-loop; cuando el test pulsaba Play explícitamente, la reproducción podía haber llegado ya al último frame. El test ahora usa `capture=1` (solo layout) y controla el inicio de playback por sí mismo. El workflow `pixelforge-visual-animation.yml` también se activa para push y pull request de esta rama, en lugar de quedar limitado a otra rama. En ese SHA, las ejecuciones push y PR del workflow terminaron en success y publicaron el artefacto `reference-guided-soldier-animation`; el vídeo fue inspeccionado y contiene frames distintos a lo largo de la reproducción. Esto valida el fixture E2E y el playback visible de esta demo, no todas las animaciones posibles.

## 7. Documentación canónica por dominio

- [Auditoría post-merge PixelForge (26-11-2026)](PIXELFORGE-POST-MERGE-AUDIT-2026-11-26.md) — estado actual, evidencia CI y brechas concretas de paridad tiled.

- [Índice operativo de documentación](README.md)
- [Política del agente y bridge](agent-ai-bridge-policy.md)
- [Headless propio del agente](HEADLESS-AGENT-RUNTIME.md)
- [Arquitectura Neon resumida](CODELAB-NEON-ARCHITECTURE.md)
- [Comunicación CodeLab ↔ Neon extremo a extremo](CodeLab_Neon_comunicacion_extremo_a_extremo.md)
- [Protocolo Headless nativo](native-headless-protocol.md)
- [Paquete de proyecto PixelForge](PIXELFORGE-PROJECT-PACKAGE.md)
- [Migración raster tradicional](PIXELFORGE-TRADITIONAL-RASTER-MIGRATION.md)
- [Ownership mixto Illustration/Pixel Art](pixelforge-mixed-style-ownership.md)
- [Rollout de ownership mixto](pixelforge-mixed-style-ownership-rollout.md)
- [Almacenamiento sparse y sync incremental](PIXELFORGE-HIGH-RESOLUTION-STORAGE-AND-INCREMENTAL-SYNC.md)
- [Procesamiento y composición de vídeo](VIDEO-PROCESSING-AB.md)
- [Catálogo de comandos PixelForge](CODELAB-PIXELFORGE-COMMAND-CATALOG.md)

## 8. Cómo mantener este documento verdadero

- Cada afirmación de implementación debe tener respaldo en código o pruebas vigentes.
- Si una sección describe un objetivo futuro, etiquetarla explícitamente como diseño/plan, nunca como comportamiento existente.
- Cuando un módulo cambie de propietario, actualizar el mapa y los documentos especializados en el mismo PR.
- No copiar aquí esquemas SQL completos, endpoints exhaustivos ni formatos binarios: enlazar la especificación que los posee.
- Si dos documentos discrepan, respetar la jerarquía de autoridad de `docs/README.md` y corregir el documento desactualizado; no inventar una tercera interpretación.


### Sparse tiled fill and operation history
- `animation-tiles.mjs` owns immutable content-addressed tile resources and cel copy-on-write. `writeTileBatch()` stages all changed tiles in a cloned cel and exposes the new cel only after the complete batch succeeds.
- `raster-tiled-adapter.mjs` is the project-level owner of layer-to-cel references; it swaps a layer reference only after a successful store batch.
- `raster-tiled-history.mjs` records bounded before/after tile payloads for atomic operations. The fill command is one history item, not a sequence of per-pixel edits.
- `raster-tiled-fill.mjs` performs scanline discovery and stages changes before committing. It enforces an explicit queue limit and history byte budget. The UI dispatches tiled documents to this path from `editor.js`.
- This is a partial tiled editor integration, not full editor parity. Geometric selection and layer metadata history are integrated; magic wand and dense transform workflows remain separate migration gates.


### Tiled linear gradient boundary
- `raster-tiled-gradient.mjs` implements the tiled equivalent of the dense linear gradient: bounded row reads, tile-only staging, selection-mask clipping, alpha compositing and one tile-operation history command.
- It shares `TiledRasterStrokeHistory.applyTileOperation`; the configured history byte budget is enforced before any cel replacement. Do not route tiled gradients through `RasterDocument.fillGradient()` or a full-canvas pixel buffer.

### Tiled shape outline boundary
- `raster-tiled-shapes.mjs` rasterizes precomputed document-coordinate line/rectangle/ellipse outline paths through the shared tiled brush primitive.
- A shape gesture preflights path coordinates and symmetry expansion against a bounded dab count, then uses one shared `TiledRasterStrokeHistory` transaction. The operation is serialized with tiled pointer gestures by the editor.
- Selection masks are inherited from the brush primitive; undo-budget overflow cancels the complete shape. This is outline support only: do not claim filled vector shapes, gradients or transform support from this module.

### Tiled geometric selection boundary
- `TiledRasterProjectDocument.setSelectionMask()` accepts a dimension-matched Uint8Array as a transient editor-owned reference (callers replace masks rather than mutating them). This avoids copying up to 16 MiB on every selection pointer update. Current mask storage is deliberately a bounded compatibility representation (one byte per pixel, up to 16 MiB under current canvas-area limits), not yet a packed sparse-mask resource format.
- Editor rectangular, elliptical and lasso selections can now be used on tiled projects. Brush/eraser dabs and transactional flood fill respect the active mask. Flood fill cannot cross an unselected pixel.
- Magic-wand selection remains blocked because its existing implementation requires a dense full-layer RGBA buffer. Do not enable it until a tile/region-aware color selection implementation exists.


### Tiled layer metadata history

The tiled editor layer panel uses document-level layer transactions for add/duplicate/delete/rename, visibility, lock, opacity and reorder. Undo snapshots retain shared cel references and metadata only; they do not clone full-canvas pixel buffers. History ownership releases retained references when commands are discarded, cleared or disposed. The same configured byte/command bounds apply, and operations that cannot fit the metadata snapshot budget must restore their pre-operation state.


### Tiled animation timeline integration

- `TiledAnimationDocument.fromTiledProjectDocument()` creates the initial frame by cloning only cel references from the active tiled project. The animation and project share one `SparseTileCelStore`; no width × height RGBA frame buffer is allocated.
- `getFrameCelReference()` and `replaceFrameCelReference()` transfer copy-on-write cel ownership between the animation model and active project document. Geometry is checked before replacement.
- `editor.js` parks the active `TiledRasterStrokeHistory` by stable frame ID when switching frames and restores that frame's history on return. Histories retain their own immutable before/after tile snapshots; undo in one frame cannot mutate another frame.
- Frame operations preserve stable IDs, durations, authoring modes and per-layer metadata. Layer removal returns retained cel references; the editor keeps these as undoable orphans and releases them when no retained layer-state command can restore the layer.
- Timeline thumbnails are downsampled by bounded row reads and cached by frame/cel state. Onion skin composites only the visible document region for adjacent frames. Playback uses the stored frame durations and the timeline clock.
- Native autosave stores the tiled animation manifest beside the tiled project manifest. Restore validates layer order, dimensions, frame limits and cel geometry/hash before installing the active frame.
- ZIP animation and sprite-sheet exports composite 16-row batches into output canvases. Temporary JavaScript RGBA buffers are bounded; final PNG canvas dimensions necessarily match the requested export.
- Browser E2E coverage verifies the visible timeline on a tiled document: blank-frame isolation, frame-local undo, duplication, reorder/delete, onion skin and sparse autosave. Unit contracts verify shared store references, layer orphan restoration and independent history swaps.
- Magic-wand selection, dense transforms, AI vision snapshots and scene workspaces remain unavailable for tiled projects. Do not infer their support from the timeline integration.

### PixelForge incremental cel-patch persistence (current boundary)

- `pixelforge-patch-store.js` is the server-side authority for v2 `pixelforge-cel-patch` operations. It validates project/frame/layer identity, canvas and tile geometry, aligned coordinates, operation types, canonical base64, SHA-256 integrity, sparse ownership values (0/1/2), and duplicate operations within each plane.
- `server.js` exposes the authenticated project patch endpoint. The database path serializes writes by workspace, locks the project row, checks the expected server revision, records idempotent operation receipts, validates the resulting project and storage quota, and commits the snapshot and receipt together.
- `public/pixelforge/src/persistence.js` exposes `applyCelPatch(project, patch)` as a transport primitive. It requires the patch base revision to match the client's current `serverRevision` and updates that revision from the server receipt.
- **Editor integration (new):** `editor.js` now anchors tiled-animation autosave to the last server-confirmed project snapshot. `createCelPatch()` is used only when the snapshot differs in exactly one animation cel and all project/frame/layer metadata is stable; structural changes, metadata changes, multiple cels, unsupported formats, or empty deltas fall back to the full snapshot path. The patch carries the server-confirmed `baseRevision`.
- **Retry boundary:** the editor retains an uncertain patch and its exact payload/`operationId` after a transport failure. The next autosave replays that patch first (allowing the server's idempotency receipt to resolve an ambiguous commit), advances the local baseline, and only then diffs newer local state. A revision conflict remains an explicit error; it must not trigger a stale full-snapshot overwrite.
- **Browser-level persistence contract (new):** `tests/pixelforge-editor-visual-modes.e2e.test.mjs` now drives a real brush gesture in Chromium after reopening a tiled animation, observes the editor's `POST /api/pixelforge/projects/:projectId/patches` request, applies the tile/ownership operations to a mock persisted manifest, asserts that an eligible one-cel edit did not issue a full-project `PUT`, checks the server revision and stored tile digest, then reloads the editor and verifies the painted pixel is visible. The test writes `cel-patch-persistence-evidence.json` alongside the visual matrix artifacts.
- **Verification status:** the Chromium browser contract passed on commit `21fadf0f557361d49dd10bb648dd442b87fa379e` and passed again after removing temporary diagnostics on commit `267d25722314f8ede6cc3ad31f7be3791859c8fa`. In both runs, the eligible stroke used the patch endpoint, avoided a full-project `PUT`, advanced the revision, and survived reload. The associated server validation/atomicity/idempotence tests also completed successfully in those runs. The remaining workflow steps (headless/package/export parity) are separate CI coverage, not blockers for the demonstrated draw → patch → reload contract.
- Project state has a compatibility view: `animation.frames[].cels[].cel` is the frame-specific cel, while top-level `layers[].cel` represents the active frame's editable raster layer. A patch to the active frame must update both representations atomically in the resulting project; a patch to an inactive frame must leave the active top-level layer untouched. Tests in `tests/pixelforge-patch-store.test.mjs` enforce both cases. This prevents a later full-snapshot save from restoring stale active-frame pixels.
- Patch retries must preserve the same `operationId` and payload so the server can return the original receipt. A revision conflict is not permission to overwrite with a stale full snapshot; reload/rebase or surface the conflict explicitly.
