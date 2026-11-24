# Transporte inline de artefactos Headless → CodeLab

**Estado:** implementado en `server.js` y verificado en el servicio desplegado mediante una prueba real de manifest → chunk → commit → Neon. Esta prueba valida el transporte y la persistencia del fragmento; no equivale a importar un proyecto PixelForge completo.

## 1. Para qué existe

El transporte inline es el intermediario HTTPS que permite que el **agente**, desde su entorno Headless aislado, entregue un paquete editable `.codelab` a CodeLab sin dar al Headless acceso directo a Neon, a las credenciales de la base de datos ni a las APIs internas.

Se utiliza cuando el agente ya terminó o necesita transferir un proyecto desde su Headless propio hacia el workspace de PixelForge administrado por CodeLab. CodeLab recibe el archivo, lo almacena temporalmente en Neon, comprueba su integridad y encola la importación con el worker nativo existente.

La separación es intencional:

- El Headless propio del agente trabaja aislado y produce el paquete.
- El agente inicia la transferencia HTTPS hacia CodeLab.
- CodeLab autentica, recibe y almacena temporalmente el paquete en Neon.
- El worker existente importa el ZIP como proyecto PixelForge y lo persiste en el workspace de destino.
- El agente consulta el resultado real y, cuando se solicita, inspecciona el proyecto/evidencia antes de darlo por terminado.

El Headless no recibe credenciales Neon ni se conecta directamente a Neon Storage/S3. El transporte inline es el intermediario soportado que cruza ese límite.

## 2. Flujo de extremo a extremo

```text
Agente IA
  │
  ├─ trabaja en su Headless aislado
  ├─ empaqueta proyecto .codelab / ZIP compatible
  └─ calcula tamaño, número de partes y SHA-256
        │
        ▼ HTTPS + token de bridge
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

La tabla `codelab_agent_commands` sigue siendo la cola durable de trabajo. El artefacto no sustituye esa cola: el commit crea una orden normal `pixelforge_import_zip`, y el mecanismo existente LISTEN/NOTIFY despierta al worker.

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
| `import_request_id` | Obligatorio para `codelab_zip_upload`; identifica la solicitud de importación del buzón ADMIN |
| `self_test` | Solo para la prueba técnica: si es `true`, el commit valida y no encola importación |

El servidor verifica el manifiesto y que `total_chunks = ceil(total_bytes / 1 MiB)`. Responde HTTP 201 con `artifactId`, `chunkBytes`, tamaño, cantidad de partes y SHA esperado.

El artefacto queda asociado al workspace interno ADMIN que posee el buzón del bridge. El workspace de destino del proyecto se conserva en metadata; no se confunde con el workspace propietario del registro temporal.

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

El tipo usado para esta entrada es `pixelforge_zip_upload`. La metadata conserva `targetWorkspaceId`, `projectName`, `selfTest` y `transport: "inline-bridge"`.

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

En la verificación real del 23-11-2026 en Render/Neon de la organización Xsuperwarriorx:

- El build y el despliegue de prueba llegaron a estado `live`.
- Los logs registraron `[Inline Artifact Smoke] PASS manifest -> chunk -> commit -> Neon`.
- La consulta directa a Neon confirmó el manifiesto y la parte binaria, ambos con 1 byte y el mismo SHA-256.
- La autoprueba se diseñó para no encolar un ZIP ficticio ni contaminar el workspace con un proyecto falso.

**Alcance de esa evidencia:** demuestra el transporte y la integridad de un fragmento. No demuestra por sí sola una importación completa.

La integración PostgreSQL de CI ejecuta además el recorrido de extremo a extremo con un ZIP v2 real: crea una solicitud del buzón ADMIN, transfiere el paquete por las rutas HTTP públicas, confirma el SHA-256, verifica que `codelab_project_import` quede encolada, arranca el worker nativo real, espera su resultado y comprueba que el proyecto aparece en el selector de la cuenta destinataria. Después lo abre, guarda una edición, vuelve a abrirlo y comprueba píxeles y timeline. Todo ocurre en PostgreSQL efímero del workflow, no en Neon production.

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
