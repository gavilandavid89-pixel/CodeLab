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
| Animación PixelForge | `public/pixelforge/src/animation.mjs` | Timeline, frames, cels y metadatos de animación densa | Que la animación tiled sea ya el modelo canónico del editor |
| Almacenamiento sparse/tiled | `public/pixelforge/src/animation-tiles.mjs`, `raster-tiled-adapter.mjs` y módulos relacionados | Recursos RGBA dispersos, referencias, copy-on-write, lectura/escritura regional y adaptadores | Que el store en memoria sea almacenamiento durable o que todas las herramientas lo usen |
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
- La migración tiled sigue siendo parcial hasta que herramientas, historia, animación, serialización y persistencia tengan paridad comprobada.

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
| Capas y cels tiled | Adaptadores sparse y operaciones regionales implementadas | Todavía no son el modelo canónico completo del editor |
| Herramientas tiled | Brush/eraser, fill transaccional, selecciones geométricas y contornos de línea/rectángulo/elipse | Gradientes, magic wand y transforms requieren migración/paridad |
| Historia tiled | Historia de trazos en alcance limitado | Operaciones de metadatos de capa y operaciones generales aún requieren integración |
| Animación tiled | Adaptador de migración/manifiesto | La ruta densa del editor sigue siendo la ruta integrada; no afirmar paridad completa |
| Video nativo mixto | Compositor/exportador por capa conserva modo y sampling | Paquetes legacy aplanados no pueden recuperar metadatos por capa ausentes |
| Almacenamiento remoto tiled | Diseño y piezas aisladas | No asumir persistencia privada de tiles ni sync incremental end-to-end |

Este cuadro es una fotografía técnica y debe actualizarse con código y pruebas antes de cada gran hito.

## 7. Documentación canónica por dominio

- [Índice operativo de documentación](README.md)
- [Política del agente y bridge](agent-ai-bridge-policy.md)
- [Headless propio del agente](HEADLESS-AGENT-RUNTIME.md)
- [Arquitectura Neon resumida](CODELAB-NEON-ARCHITECTURE.md)
- [Comunicación CodeLab ↔ Neon extremo a extremo](CodeLab_Neon_comunicacion_extremo_a_extremo.md)
- [Protocolo Headless nativo](native-headless-protocol.md)
- [Paquete de proyecto PixelForge](PIXELFORGE-PROJECT-PACKAGE.md)
- [Migración raster tradicional](PIXELFORGE-TRADITIONAL-RASTER-MIGRATION.md)
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
- This is a first tiled tool integration, not full editor parity. Selection masks, magic wand, transforms, layer metadata history and tiled animation remain separate migration gates.


### Tiled shape outline boundary
- `raster-tiled-shapes.mjs` rasterizes precomputed document-coordinate line/rectangle/ellipse outline paths through the shared tiled brush primitive.
- A shape gesture preflights path coordinates and symmetry expansion against a bounded dab count, then uses one shared `TiledRasterStrokeHistory` transaction. The operation is serialized with tiled pointer gestures by the editor.
- Selection masks are inherited from the brush primitive; undo-budget overflow cancels the complete shape. This is outline support only: do not claim filled vector shapes, gradients or transform support from this module.

### Tiled geometric selection boundary
- `TiledRasterProjectDocument.setSelectionMask()` accepts a dimension-matched Uint8Array as a transient editor-owned reference (callers replace masks rather than mutating them). This avoids copying up to 16 MiB on every selection pointer update. Current mask storage is deliberately a bounded compatibility representation (one byte per pixel, up to 16 MiB under current canvas-area limits), not yet a packed sparse-mask resource format.
- Editor rectangular, elliptical and lasso selections can now be used on tiled projects. Brush/eraser dabs and transactional flood fill respect the active mask. Flood fill cannot cross an unselected pixel.
- Magic-wand selection remains blocked because its existing implementation requires a dense full-layer RGBA buffer. Do not enable it until a tile/region-aware color selection implementation exists.
