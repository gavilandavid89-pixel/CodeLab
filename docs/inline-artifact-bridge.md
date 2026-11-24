# Transporte inline de artefactos Headless → CodeLab

**Estado:** implementado en `server.js`. El servicio desplegado ha verificado el transporte manifest → chunk → commit → Neon; CI verifica además la importación completa desde el artefacto Headless descargado en un PostgreSQL efímero. La prueba de servicio y la prueba de importación tienen alcances distintos.

## 0. Identidad ADMIN y diagnóstico de autenticación

La autenticación del endpoint HTTP descrita más abajo es un requisito del servidor; no significa que el agente deba pedirle al usuario el secreto ni que deba buscarlo dentro del Headless. Antes de declarar un bloqueo, el agente debe reutilizar la conexión administrativa ya disponible, resolver la cuenta ADMIN y el workspace destino, inspeccionar las acciones autorizadas disponibles y diagnosticar la capa concreta que rechazó la operación. No confundir el buzón interno ADMIN del bridge con el workspace de destino. No exponer ni solicitar secretos. Procedimiento obligatorio: [ADMIN-AUTH-AND-BRIDGE-RECOVERY.md](ADMIN-AUTH-AND-BRIDGE-RECOVERY.md).

## 1. Para qué existe

El transporte inline es el intermediario HTTPS que permite que el **agente IA, fuera del Headless**, entregue un paquete editable `.codelab` a CodeLab sin dar al Headless acceso directo a Neon, a las credenciales de la base de datos ni a las APIs internas.

Se utiliza cuando el agente ya terminó o necesita transferir un proyecto desde su Headless propio hacia el workspace de PixelForge administrado por CodeLab. CodeLab recibe el archivo, lo almacena temporalmente en Neon, comprueba su integridad y encola la importación con el worker nativo existente.

La separación es intencional:

- El Headless propio del agente trabaja aislado y produce/exporta el paquete; no se conecta al intermediario ni conoce sus endpoints.
- El agente IA recoge el archivo exportado fuera del Headless e inicia la transferencia HTTPS hacia CodeLab.
- CodeLab autentica, recibe y almacena temporalmente el paquete en Neon.
- El worker existente importa el paquete con el editor indicado por el manifiesto y lo persiste en el workspace de destino.
- El agente consulta el resultado real y, cuando se solicita, inspecciona el proyecto/evidencia antes de darlo por terminado.

El Headless no recibe credenciales Neon ni se conecta directamente a Neon Storage/S3. El transporte inline es el intermediario soportado que cruza ese límite.

## 2. Flujo de extremo a extremo

```text
Agente IA
  │
  ├─ trabaja en su Headless aislado
  └─ recibe/toma el archivo .codelab que Headless exportó
        │ (Headless no tiene conexión al bridge)
        ▼
Agente IA, fuera del Headless
  ├─ calcula tamaño, número de partes y SHA-256
  └─ envía por HTTPS + token de bridge
CodeLab: POST /api/agent/bridge/artifacts
  │   crea manifiesto y artifact_id
  ▼
CodeLab: PUT /api/agent/bridge/artifacts/{artifact_id}/{index}
  │   recibe cada parte binaria
  ▼
Neon: codelab_agent_artifacts
     codelab_agent_artifact_chunks
  │
  ▼
CodeLab: POST /api/agent/bridge/artifacts/{artifact_id}/commit
  │   comprueba secuencia, hashes y tamaño
  ├─ si self_test=true: responde verified y NO encola importación
  └─ en uso real: inserta codelab_project_import (CodeLab) o pixelforge_import_zip (PixelForge)
        │
        ▼ PostgreSQL NOTIFY
Listener de server.js → agent-bridge-worker.mjs
        │
        ├─ lee y reconstruye el artefacto
        ├─ analiza el ZIP según su editor
        ├─ persiste proyecto/recursos en el workspace destino (no en el buzón ADMIN)
        ├─ elimina el artefacto temporal
        └─ completa la orden con el resultado
        ▼
Agente consulta estado/resultado y verifica la importación
```

La tabla `codelab_agent_commands` sigue siendo la cola durable de trabajo. El artefacto no sustituye esa cola: el commit crea `codelab_project_import` para paquetes `.codelab` o `pixelforge_import_zip` para ZIP PixelForge directos; LISTEN/NOTIFY despierta al worker.

## 3. API HTTP

Todas las rutas requieren el secreto de control del bridge. La forma recomendada es enviarlo en el header `x-codelab-agent-bridge-token`; el código también admite el parámetro `token` como compatibilidad, pero debe evitarse porque los query strings pueden quedar registrados en logs/proxies.

### 3.1 Crear manifiesto

`POST /api/agent/bridge/artifacts`

Content-Type: `application/json`

Campos aceptados por la implementación:

| Campo | Requisito / significado |
|---|---|
| `total_bytes` | Tamaño total del paquete, entero entre 1 y 256 MiB |
| `total_chunks` | Número total de partes, entero entre 1 y 256 |
| `sha256` | SHA-256 hexadecimal de los bytes completos (64 caracteres) |
| `filename` | Nombre del archivo; por defecto `pixelforge.codelab`, truncado a 180 caracteres |
| `target_workspace_id` | Workspace destino con formato `ws_...`; por defecto el workspace PixelForge guest configurado |
| `project_name` | Nombre opcional para el proyecto importado |
| `artifact_kind` | `pixelforge_zip_upload` para ZIP PixelForge directo; `codelab_zip_upload` para paquete `.codelab` importable |
| `editor_id` | Para `.codelab`: `web`, `design` o `pixelforge`; debe coincidir con el manifiesto del paquete |
| `source_project_id` | ID de origen opcional para la solicitud de importación |
| `import_request_id` | Opcional; si se omite para `.codelab`, CodeLab crea la solicitud y devuelve su ID en la respuesta del manifiesto |
| `self_test` | Solo para la prueba técnica: si es `true`, el commit valida y no encola importación |

El servidor verifica el manifiesto y que `total_chunks = ceil(total_bytes / 1 MiB)`. Responde HTTP 201 con `artifactId`, `importRequestId` cuando aplica, `chunkBytes`, tamaño, cantidad de partes y SHA esperado.

El artefacto queda asociado al workspace interno ADMIN que posee el buzón del bridge. Para `codelab_zip_upload`, CodeLab también crea una solicitud de importación en ese buzón si el agente no envía `import_request_id`; el ID se devuelve junto con `artifactId`. El workspace de destino del proyecto se conserva en metadata; no se confunde con el workspace propietario del registro temporal.

### 3.2 Subir cada parte

`PUT /api/agent/bridge/artifacts/{artifact_id}/{chunk_index}`

- Content-Type: `application/octet-stream`.
- Índices desde cero y sin saltos: `0` hasta `total_chunks - 1`.
- Tamaño máximo por petición: 1 MiB.
- No se aceptan partes vacías.
- Cada parte se almacena como `BYTEA` junto con su SHA-256.
- Repetir un índice reemplaza esa parte, lo que permite reintentar una transferencia parcial.

El servidor rechaza IDs inexistentes/expirados, artefactos fuera del workspace del bridge e índices fuera del manifiesto.

### 3.3 Confirmar y encolar importación

`POST /api/agent/bridge/artifacts/{artifact_id}/commit`

Content-Type: `application/json`

Body: `{ "sha256": "<SHA-256 del archivo completo>" }`

El commit:
1. Comprueba que estén presentes todas las partes.
2. Comprueba que los índices sean contiguos desde cero.
3. Recalcula el SHA-256 de cada parte y lo compara con el almacenado.
4. Reconstruye el hash global y comprueba tamaño total, SHA del manifiesto y SHA enviado al commit.
5. Si todo coincide, crea una orden con expiración de 15 minutos y estado `queued`: `codelab_project_import` para `codelab_zip_upload`, o `pixelforge_import_zip` para `pixelforge_zip_upload`.

En el caso normal devuelve HTTP 202 con `artifactId`, `commandId`, `status: "queued"`, bytes, partes y SHA-256. HTTP 202 significa que la importación fue encolada, no que el proyecto ya esté importado. El agente debe seguir la orden y comprobar su resultado.

Para `pixelforge_zip_upload`, el worker ejecuta `readNativeArtifact`, analiza el ZIP con `parsePixelForgeProjectZip` y persiste con `persistImportedPixelForgeProject`. Para `codelab_zip_upload`, ejecuta `readNativeArtifact` y `importCodeLabArtifact`, que valida el manifiesto `.codelab`, importa el documento/recursos y verifica el round-trip desde PostgreSQL. En ambos casos elimina el artefacto temporal y marca la orden como completada.

En una importación `.codelab`, `workspace_id` de la solicitud identifica el buzón interno ADMIN y autoriza al worker a consumir la orden. `target_workspace_id` es el destino real del proyecto. El worker debe pasar ese destino explícitamente al importador: los registros del proyecto, archivos, revisiones PixelForge e historial de importación se guardan bajo el workspace destinatario, nunca bajo el buzón ADMIN. La finalización de la orden, el proyecto guardado y su revisión son la evidencia de importación; un HTTP 202 por sí solo no basta.

## 4. Límites y almacenamiento

| Parámetro | Valor implementado |
|---|---:|
| Tamaño máximo del artefacto | 256 MiB |
| Tamaño de cada parte | 1 MiB (1.048.576 bytes) |
| Número máximo de partes | 256 |
| Expiración del artefacto temporal | 1 hora |
| Expiración inicial de la orden de importación | 15 minutos |

Tablas:

- `public.codelab_agent_artifacts`: manifiesto, workspace interno, tipo, nombre, MIME, tamaño, cantidad de partes, SHA-256, metadata, creación y expiración.
- `public.codelab_agent_artifact_chunks`: `artifact_id`, índice, bytes binarios `BYTEA` y SHA-256 de cada parte. La clave primaria es `(artifact_id, chunk_index)`; al borrar el manifiesto, sus partes se eliminan por cascada.

Para paquetes `.codelab`, el tipo de entrada es `codelab_zip_upload`; para ZIP PixelForge directos, `pixelforge_zip_upload`. La metadata conserva `targetWorkspaceId`, `projectName`, `importRequestId`, `selfTest` y `transport: "inline-bridge"`.

Los artefactos son staging temporal, no almacenamiento definitivo de proyectos. Una vez importado, el worker elimina el paquete temporal; el documento PixelForge queda guardado mediante la persistencia normal del proyecto.

## 5. Seguridad y separación de responsabilidades

- Las rutas requieren el secreto de control del bridge y comparan el token de forma segura.
- El secreto vive en variables de entorno de CodeLab; nunca debe escribirse en el repositorio, en logs ni en documentación.
- Usar el header de autorización, no query strings.
- El Headless aislado no obtiene `DATABASE_URL`, credenciales Neon ni tokens internos.
- CodeLab valida workspace, tipo, expiración, tamaños, índices y hashes antes de aceptar la importación.
- La metadata del destino no autoriza por sí sola al agente a acceder a ese workspace; el worker aplica las reglas de persistencia/importación existentes.
- No se debe usar este canal para enviar vídeos finales o evidencia pesada como sustituto del flujo de vídeo. La regla del proyecto sigue vigente: **A/B se reserva exclusivamente para empaquetar/renderizar/capturar vídeo**, por la limitación de memoria de Render, usando una sola B procesadora por trabajo. El inline sirve para transferir el paquete editable del proyecto a CodeLab, no para reemplazar ese flujo. Consulta [VIDEO-PROCESSING-AB.md](VIDEO-PROCESSING-AB.md).

## 6. Prueba técnica y qué demuestra

El servidor contiene una autoprueba opcional controlada por `AGENT_INLINE_ARTIFACT_SMOKE_TEST=1`. Al iniciar, llama por HTTP local a las mismas rutas públicas del transporte y realiza manifiesto → parte → commit usando un payload de un byte. Para esta prueba se habilita un secreto de prueba separado. Cuando el manifiesto lleva `self_test: true`, el commit devuelve `status: "verified"` sin crear una orden falsa de importación.

En la verificación real del 23-11-2026 en Render/Neon:

- El build y el despliegue de prueba llegaron a estado `live`.
- Los logs registraron `[Inline Artifact Smoke] PASS manifest -> chunk -> commit -> Neon`.
- La consulta directa a Neon confirmó el manifiesto y la parte binaria, ambos con 1 byte y el mismo SHA-256.

**Alcance:** esa autoprueba demuestra el transporte y la integridad de un fragmento; no demuestra por sí sola una importación completa.

### 6.1 Importación real de producción — 24-11-2026

El workflow `.github/workflows/inline-bridge-smoke-test.yml` se amplió para construir un paquete CodeLab Web v2 estructurado real, con `project.json`, HTML/CSS/JS, un recurso SVG, `integrity.json` y `manifest.json`. El job calcula el SHA-256 del ZIP, crea el manifiesto HTTP, sube todos los chunks binarios y confirma el commit con JSON generado por `jq`.

Ejecución verificada: [GitHub Actions run 45338080211](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45338080211), conclusión `success`.

La consulta posterior a Neon confirmó:

- solicitud `codelab-e2e-web-45338080211` con estado `succeeded`;
- workspace destino `ws_local_admin`, editor `web`;
- proyecto `bridge-e2e-web-45338080211`, nombre `Bridge E2E Web Import 45338080211`;
- artefacto temporal con estado `imported`, 1.649 bytes y SHA-256 `27ff053b5665678d8c2af1ca7d70ea316c55c7d15c6e47612a14bf510653623e`;
- contenido persistido con SHA-256 `0793920a0bd52619ddb176d17e24694719b84fdf7478d7215a1d9740747504e8`;
- workspace ADMIN en revisión 12 y lectura de vuelta con `reloadedFromPersistence: true`.

Esta prueba sí recorrió el endpoint HTTP autenticado, la recepción de chunks, el commit, la importación del worker y la lectura de vuelta desde la persistencia ADMIN. No fue una autoprueba `self_test`.

### 6.2 Importación PixelForge nativa — 24-11-2026

La ejecución [45344660920](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45344660920) generó el paquete desde el artefacto Headless oficial, lo transfirió mediante las rutas HTTP autenticadas y completó la importación nativa en ADMIN.

- Proyecto `soldier-walk-60f-20261124`, workspace `ws_local_admin`.
- Solicitud `codelab-soldier-walk-60f-fixed-45344660920`: `succeeded`.
- Artefacto: `imported`; orden del worker: `succeeded`.
- 20 fotogramas a 12 FPS, bucle de 1,667 segundos, 4 capas.
- Los 20 archivos de fotograma conservan cuatro rutas RGBA únicas y cuatro hashes de píxeles distintos.
- Cinco espacios de trabajo independientes, cada uno con cuatro fotogramas y una capa propia.
- Una referencia maestra en Reference Center.
- 110 archivos persistidos.
- Lectura de vuelta desde PostgreSQL: `reloadedFromPersistence: true`, `persistedAnimationFrameCount: 20`, `persistedReferenceCount: 1`.
- SHA-256 del contenido persistido: `82db7ee3d5195063fdff109f7e0ad7a30089a8c907e7387e81d13b1742e8b67f`.

Al reemplazar una versión, el importador comprueba primero que cada archivo nuevo coincide en ruta, tamaño, SHA-256 y bytes. Después elimina únicamente los archivos obsoletos del mismo proyecto/editor y verifica el recuento final. Esto mantiene sincronizado el conjunto persistido con el paquete importado.

El informe consolidado de las correcciones y de las dos importaciones reales está en [INLINE-BRIDGE-TRANSFER-RESOLUTION-2026-11-24.md](INLINE-BRIDGE-TRANSFER-RESOLUTION-2026-11-24.md).

La variable de autoprueba debe permanecer desactivada en operación normal. No dejar activo el secreto temporal de test una vez concluida la verificación.

## 7. Cuándo usarlo

Usar inline cuando:
- el agente terminó una edición en su Headless aislado;
- necesita entregar el proyecto editable a CodeLab;
- el archivo puede transferirse dentro del máximo de 256 MiB;
- se necesita que CodeLab importe y persista el proyecto en su workspace.

No usar inline para:
- obtener el Headless del agente (eso se hace descargando el artefacto del workflow GitHub Actions);
- que el Headless se conecte directamente a Neon/S3;
- ejecutar órdenes genéricas del worker sin un artefacto;
- transferir el vídeo final como ruta de render;
- sustituir la cola `codelab_agent_commands`, el worker, la verificación de importación o la inspección visual.

## 8. Archivos de implementación relacionados

- `server.js`: rutas HTTP, autenticación, staging de partes, commit, validación SHA-256 y autoprueba.
- `agent-bridge-worker.mjs`: acciones `codelab_project_import` y `pixelforge_import_zip`, lectura del artefacto, destino de workspace, persistencia y limpieza.
- `native-agent-artifacts.mjs`: esquema y helpers de artefactos nativos.
- `migrations/2026-11-23-pixelforge-agent-artifacts.sql`: tablas, límites y constraints.
- `docs/agent-ai-bridge-policy.md`: política del Headless aislado, transferencia y uso exclusivo de A/B para vídeo.
- `docs/CodeLab_Neon_comunicacion_extremo_a_extremo.md`: arquitectura general de Neon, órdenes y worker.


## 9. Límite de confianza: transferencia exclusiva por el agente

El Headless del agente **no se conecta al intermediario**. No debe contener cliente del bridge, URL del bridge, token de bridge ni credenciales de CodeLab/Neon. No realiza llamadas HTTP de importación ni intenta escribir directamente en sistemas externos.

La secuencia obligatoria tiene dos fases: (1) Headless crea/edita y exporta un archivo nativo `.codelab`, y termina; (2) fuera del Headless, el agente recoge ese archivo, calcula el manifiesto/hash, envía chunks al intermediario HTTPS y sigue el resultado hasta verificar la persistencia. El bridge es un límite de confianza que solo cruza el agente mediante una acción de transferencia separada.

Este documento regula el transporte del proyecto editable. No transporta el vídeo final ni sustituye A/B. Si la tarea incluye vídeo, seguir `VIDEO-PROCESSING-AB.md`, recuperar el archivo de vídeo producido y entregárselo al usuario.

## 8. Catálogo de proyectos PixelForge del repositorio

El inbox canónico es `projects/animation-inbox/<slug>/project.codelab`. Cada paquete debe ser un `.codelab` nativo de PixelForge, con `project.codelab-pixelforge`, `manifest.json` y `project.json` en la raíz del ZIP.

El workflow `.github/workflows/pixelforge-project-inbox.yml` se activa al cambiar archivos dentro de una carpeta de proyecto o manualmente con `project_slug`. El workflow (no A ni B) lee el paquete del repositorio, valida su estructura, calcula SHA-256 y lo transfiere por las rutas inline ya existentes como `codelab_zip_upload`, con destino ADMIN `ws_local_admin`. El commit crea la orden nativa `codelab_project_import`; HTTP 202/`queued` no demuestra que ya se haya importado. Debe comprobarse la orden y la aparición del proyecto en PixelForge antes de iniciar A/B.

La carpeta fuente del repositorio es la copia maestra y no se elimina. La importación crea una copia de trabajo ADMIN. Esa copia no se elimina automáticamente al terminar A o B: después de la entrega del WebM, la aplicación debe solicitar confirmación explícita antes de borrar la copia temporal. El WebM y `verification.json` se conservan independientemente. Nunca borrar la carpeta fuente como parte de la limpieza.

**Separación invariable:** el workflow de inbox es un importador de catálogo externo al sistema A/B. A no lee GitHub ni el repositorio; A solo ejecuta la web real y la operación concreta solicitada por B. B decide qué proyecto/operación pedir, envía la orden a A y recibe/verifica el WebM; B no genera ni anima.

