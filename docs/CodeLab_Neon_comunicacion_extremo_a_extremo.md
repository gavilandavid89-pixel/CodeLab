# CodeLab ↔ Neon — comunicación extremo a extremo

## Alcance

Este documento describe la comunicación **real que se pudo verificar en el repositorio `gavilandavid89-pixel/CodeLab` (rama `main`)**, especialmente el puente nativo agente → Neon → CodeLab y el subsistema de evidencia. No contiene secretos, contraseñas, tokens ni valores privados de entorno.

**Fuente principal inspeccionada:** `README.md`, `package.json`, `server.js`, `agent-bridge-worker.mjs`, `neon-pixelforge-evidence.js`, `pixelforge-upload-store.js`.

La documentación del propio proyecto declara como arquitectura de ejecución:

`agente → Neon → Cloudflare → CodeLab → evidencia → Neon → agente`.

---

## 1. Mapa general real

```text
                         ┌──────────────────────┐
                         │        AGENTE        │
                         │ controlador del ciclo│
                         └──────────┬───────────┘
                                    │
                     crea/consulta │ órdenes y resultados
                                    │
                                    ▼
                         ┌──────────────────────┐
                         │   NEON POSTGRESQL    │
                         │                      │
                         │ codelab_agent_commands
                         │ codelab_agent_bridge_state
                         │ proyectos / cuentas  │
                         │ eventos de evidencia │
                         └───────┬──────────────┘
                                 │
                LISTEN/NOTIFY    │  SQL
                                 │
                 ┌───────────────┘
                 ▼
       ┌─────────────────────────────┐
       │       CODELAB SERVER         │
       │          server.js          │
       │                             │
       │ pg.Pool                    │
       │ pg.Client                  │
       │ Native Bridge launcher      │
       │ API / workspace             │
       └──────────────┬──────────────┘
                      │
             spawn    │
                      ▼
       ┌─────────────────────────────┐
       │ agent-bridge-worker.mjs     │
       │                             │
       │ pg.Pool                    │
       │ claim/execute/finish        │
       │ headless PixelForge         │
       │ browser automation explícita│
       └──────────────┬──────────────┘
                      │
                      │ modifica/lee
                      ▼
             ┌─────────────────┐
             │     CODELAB     │
             │ workspace API   │
             │ proyectos web   │
             └─────────────────┘

Evidencia visual:

CodeLab → Cloudflare/R2 (si está configurado)
        ↓
URL / objectKey
        ↓
Neon: codelab_pixelforge_change_events
        ↓
Agente
```

---

## 2. La pieza central: `DATABASE_URL`

CodeLab obtiene la conexión PostgreSQL desde:

`process.env.DATABASE_URL`

En `server.js` se crea:

```js
const accountPool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_SSL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;
```

El worker `agent-bridge-worker.mjs` también lee la misma variable y crea su propio pool:

```js
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: ...,
  max: 2,
  idleTimeoutMillis: 15000,
  connectionTimeoutMillis: 10000
});
```

Por tanto, el flujo no es:

`CodeLab → API propietaria de Neon → PostgreSQL`.

Es:

`CodeLab → driver PostgreSQL (pg) → endpoint PostgreSQL de Neon → PostgreSQL`.

La documentación de Neon confirma que una connection string contiene usuario, contraseña, hostname del endpoint, puerto, base y opciones SSL; los endpoints pooled utilizan el sufijo `-pooler`.

---

## 3. Conexiones directas y pooled

El servidor usa `pg`.

Para tráfico normal, `DATABASE_URL` puede ser un endpoint pooled.

Para el listener de `LISTEN/NOTIFY`, `server.js` tiene una función específica:

`databaseUrlForWakeListener()`

Si el hostname contiene `-pooler.`, sustituye ese segmento para obtener el endpoint directo equivalente.

Motivo: `LISTEN/NOTIFY` necesita una conexión backend estable; el propio código evita usar el pooler para ese listener.

Así quedan dos caminos:

```text
TRÁFICO SQL NORMAL
CodeLab → pg.Pool → DATABASE_URL → Neon pooled endpoint → PostgreSQL

WAKE LISTENER
CodeLab → pg.Client → endpoint directo Neon → PostgreSQL
                     │
                     └─ LISTEN codelab_agent_bridge_wake
```

El pool normal de `server.js` está limitado a 5 conexiones. El pool del worker está limitado a 2.

---

## 4. Qué hace `server.js` con Neon

`server.js` cumple simultáneamente varias funciones:

1. Mantiene el pool de PostgreSQL.
2. Gestiona cuentas locales/ADMIN.
3. Persiste sesiones/cuentas en PostgreSQL.
4. Crea y mantiene las tablas del bridge.
5. Instala el mecanismo de `LISTEN/NOTIFY`.
6. Escucha órdenes `queued`.
7. Arranca el proceso `agent-bridge-worker.mjs` bajo demanda.
8. Expone la API de workspace usada por el worker.
9. Gestiona autenticación OAuth.
10. Gestiona el proxy de IA.
11. Gestiona proyectos PixelForge y evidencias.

---

## 5. Tabla `codelab_agent_commands`

Es el buzón persistente de órdenes.

El esquema creado por CodeLab contiene:

```text
command_id      text PK
workspace_id    text
action          text
payload         jsonb
status          text
result          jsonb
proposal        jsonb
proposal_token  text
created_at      timestamptz
started_at      timestamptz
finished_at     timestamptz
expires_at      timestamptz
updated_at      timestamptz
```

Estados admitidos:

```text
queued
running
awaiting_approval
succeeded
rejected
failed
expired
```

Existe un índice de cola:

```text
(status, created_at)
WHERE status = 'queued'
```

y otro por workspace/fecha.

### Acciones verificadas

Entre otras:

```text
status

pixelforge_create
pixelforge_list
pixelforge_inspect
pixelforge_propose
pixelforge_approve
pixelforge_discard
pixelforge_animation_frame_context
pixelforge_export_image
pixelforge_capture_interface
pixelforge_export_animation_video
pixelforge_intelligence

codelab_project_create
codelab_project_convert_to_web
codelab_project_inspect
codelab_project_connect
codelab_project_get_code
codelab_project_update_code
codelab_project_capture_png
codelab_project_record_video
codelab_ui_execute
```

---

## 6. Cómo una orden despierta CodeLab

No depende de un cron para mantener el bridge activo.

En `server.js`:

1. Se abre un `Client` PostgreSQL.
2. Se crea/asegura `codelab_agent_commands`.
3. Se crea/asegura `codelab_agent_bridge_state`.
4. Se crea la función PostgreSQL `codelab_agent_bridge_wake()`.
5. La función ejecuta `pg_notify(...)`.
6. Se instala el trigger `codelab_agent_bridge_wake_trigger`.
7. CodeLab ejecuta:

```sql
LISTEN codelab_agent_bridge_wake
```

Cuando entra una orden `queued`, PostgreSQL emite:

```text
NOTIFY codelab_agent_bridge_wake
```

con JSON que contiene, como mínimo:

```text
commandId
workspaceId
```

El listener de CodeLab recibe la notificación y llama:

```text
startAgentBridge()
```

que hace spawn de:

```text
agent-bridge-worker.mjs
```

### Flujo exacto

```text
Agente
  │
  │ INSERT/UPDATE orden → status=queued
  ▼
Neon PostgreSQL
  │
  │ trigger
  ▼
codelab_agent_bridge_wake()
  │
  │ pg_notify()
  ▼
LISTEN de server.js
  │
  ▼
startAgentBridge()
  │
  │ child_process.spawn()
  ▼
agent-bridge-worker.mjs
```

---

## 7. Por qué el listener usa endpoint directo

El propio código documenta esta decisión:

```text
Neon pooled endpoints → tráfico de requests
endpoint directo → LISTEN/NOTIFY estable
```

Cuando `DATABASE_URL` apunta a un host `-pooler`, CodeLab crea una variante para el listener eliminando `-pooler.`.

El listener tiene:

```text
application_name = codelab-agent-bridge-wake-listener
```

Esto permite identificar esa conexión en PostgreSQL.

---

## 8. Arranque y recuperación del bridge

Al iniciar el listener, CodeLab hace una reconciliación de estado.

Busca órdenes:

```text
status='queued'
expires_at > now()
payload.wake = true
```

Esto cubre una carrera de arranque: una notificación podría haberse producido antes de que `LISTEN` estuviera activo.

Después, el worker escribe el estado en:

`codelab_agent_bridge_state`.

---

## 9. Tabla `codelab_agent_bridge_state`

Es el estado persistente del puente.

Campos principales:

```text
state_id
workspace_id
state
wake_required
wake_reason
signal_version
last_signal_at
updated_at
metadata
```

Estados:

```text
starting
running
sleeping
stopping
error
```

La señal de apagado final es especialmente importante:

```text
state = sleeping
wake_required = true
wake_reason = ...
signal_version = monotonically incremented
```

Así el agente puede saber que el bridge se apagó y debe despertarlo cuando vaya a enviar la siguiente orden.

---

## 10. `agent-bridge-worker.mjs`

Este es el ejecutor real.

Al arrancar:

```text
DATABASE_URL
   ↓
pg.Pool
   ↓
resolveAdminWorkspace()
   ↓
ensureBridgeSignalSchema()
   ↓
writeBridgeSignal('running')
   ↓
claimCommand()
```

El worker tiene:

```text
POLL_MS = 150
```

Ese polling es interno al worker para recoger trabajo persistente. No es el mecanismo usado para mantener el bridge despierto: el despertar se hace mediante PostgreSQL `LISTEN/NOTIFY`.

---

## 11. Claim de una orden

El worker usa una transacción y:

```sql
SELECT ...
FROM codelab_agent_commands
WHERE status='queued'
  AND expires_at > now()
  AND workspace_id=$1
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1
```

Después cambia la orden:

```text
queued → running
```

Esto evita que dos consumidores reclamen simultáneamente la misma orden.

---

## 12. Heartbeat

Mientras una orden está ejecutándose, el worker actualiza:

```text
updated_at
```

cada 30 segundos para la orden `running`.

Si una orden queda `running` y su `updated_at` lleva más de 3 minutos, el worker puede devolverla a `queued` si todavía no expiró.

Esto permite recuperar trabajos abandonados.

---

## 13. Finalización

`finish()` actualiza:

```text
status
result
proposal
proposal_token
finished_at
updated_at
```

y después escribe una señal en:

`codelab_agent_bridge_state`.

El resumen de señal incluye, cuando existe:

```text
error
message
projectId
revision/serverRevision
evidenceEventId
commandId
commandStatus
```

---

## 14. Persistencia de cuentas

`server.js` usa PostgreSQL para las cuentas nativas.

La tabla consultada es:

```text
codelab_accounts
```

El código obtiene:

```text
username
id
role
salt
password_hash
created_at
password_changed_at
must_change_password
```

El bootstrap ADMIN depende de:

```text
ADMIN_BOOTSTRAP_PASSWORD
```

y de que exista `DATABASE_URL`.

El rol `ADMIN` determina el workspace administrativo que utiliza el bridge:

```text
ws_local_<id-del-ADMIN>
```

---

## 15. Workspace API interna

El worker no modifica directamente todos los archivos del workspace desde PostgreSQL.

Tiene una API interna:

```text
http://127.0.0.1:<PORT>/api/workspace/...
```

y genera un token HMAC con:

```text
CODELAB_WORKSPACE_SECRET
```

El flujo es:

```text
agent-bridge-worker
       │
       │ HTTP local
       │ x-workspace-token
       ▼
server.js
       │
       ▼
workspace persistido
```

Esto es una comunicación interna CodeLab → CodeLab, pero forma parte del camino extremo a extremo.

---

## 16. Persistencia de PixelForge

El worker utiliza tablas PostgreSQL para los proyectos.

Una tabla central es:

```text
codelab_pixelforge_projects
```

El código utiliza:

```text
workspace_id
project_id
name
width
height
updated_at
last_opened_at
project
byte_size
server_revision
content_sha256
```

El documento del proyecto se guarda como `jsonb`.

Cada modificación incrementa:

```text
server_revision
```

y recalcula:

```text
content_sha256
```

Esto proporciona una fuente de verdad persistente independiente del navegador.

---

## 17. Control de concurrencia

Para operaciones críticas el código utiliza:

```sql
SELECT pg_advisory_xact_lock(hashtext($1))
```

donde la clave se basa en el workspace.

También verifica:

```text
expected server_revision
```

antes de guardar una modificación.

Si la revisión cambió:

```text
Revision conflict
```

Esto evita sobrescribir una modificación concurrente.

---

## 18. Propuestas y aprobación

Para operaciones PixelForge, el worker puede crear una propuesta aislada.

Flujo:

```text
agente
  ↓
pixelforge_propose
  ↓
worker carga proyecto
  ↓
ejecuta batch en memoria
  ↓
calcula diff
  ↓
crea proposal_token
  ↓
status=awaiting_approval
  ↓
NO se modifica todavía el proyecto guardado
```

Después:

```text
pixelforge_approve
  ↓
valida token
  ↓
valida expiración
  ↓
comprueba server_revision
  ↓
reproduce acciones
  ↓
acceptProposal()
  ↓
UPDATE proyecto
  ↓
server_revision + 1
```

El token de propuesta es temporal.

---

# 19. Evidencia visual

El módulo:

`neon-pixelforge-evidence.js`

crea la tabla:

```text
codelab_pixelforge_change_events
```

Campos relevantes:

```text
event_id
workspace_id
project_id
revision
change_kind
image_key
video_key
image_url
video_url
status
metadata
image_data
video_data
image_mime_type
video_mime_type
created_at
updated_at
```

Hay un índice por:

```text
workspace_id
project_id
revision DESC
created_at DESC
```

---

## 20. Relación proyecto → revisión → evidencia

El concepto es:

```text
Proyecto
   │
   ├── revision 41
   │      └── evidence event A
   │             ├── image
   │             └── video
   │
   └── revision 42
          └── evidence event B
                 ├── image
                 └── video
```

El `event_id` identifica la evidencia concreta.

El resultado de una orden puede contener:

```text
evidenceEventId
```

para correlacionar ejecución y evidencia.

---

## 21. Cloudflare

El proyecto contempla Cloudflare como puente/almacenamiento de evidencia.

Las variables relevantes son:

```text
CLOUDFLARE_EVIDENCE_BASE_URL
CLOUDFLARE_EVIDENCE_SIGNING_SECRET
```

Cuando están configuradas, el módulo de evidencia utiliza el camino Cloudflare.

El código genera una URL de subida con:

```text
PUT
/evidence/<objectKey>
?expires=<timestamp>
&sig=<HMAC>
```

La firma se calcula sobre:

```text
PUT
objectKey
expires
contentType
```

y utiliza HMAC-SHA256.

---

## 22. Evidencia: flujo de extremo a extremo

```text
CodeLab
   │
   │ crea change event
   ▼
Neon
   │
   │ event_id
   ▼
CodeLab genera objeto de evidencia
   │
   │ presigned/signed PUT
   ▼
Cloudflare / R2
   │
   │ objeto binario
   ▼
URL pública o referencia
   │
   ▼
CodeLab
   │
   │ UPDATE change_event
   ▼
Neon
   │
   │ video_url / video_key / status
   ▼
Agente
   │
   │ inspecciona evidencia
   ▼
decisión de siguiente tarea
```

---

## 23. Cloudflare no reemplaza Neon

La separación es:

```text
Neon
  = estado estructurado
  = órdenes
  = revisiones
  = proyectos
  = metadatos
  = referencias a evidencia

Cloudflare/R2
  = bytes grandes
  = vídeo
  = imágenes
  = artefactos binarios
```

El proyecto puede conservar también `BYTEA` para datos de imagen/vídeo, pero el camino Cloudflare está preparado para almacenamiento externo de evidencia.

---

## 24. Almacenamiento alternativo

`neon-pixelforge-evidence.js` también contempla un endpoint S3-compatible.

Variables:

```text
NEON_STORAGE_ENDPOINT
NEON_STORAGE_REGION
NEON_STORAGE_ACCESS_KEY_ID
NEON_STORAGE_SECRET_ACCESS_KEY
```

El código puede firmar solicitudes AWS Signature V4.

Por tanto existen dos modos conceptuales:

```text
modo Cloudflare:
CodeLab → Cloudflare/R2 → URL → Neon metadata

modo S3-compatible:
CodeLab → endpoint S3 → object → Neon metadata
```

Cuando Cloudflare está configurado, el módulo lo prefiere.

---

## 25. Upload de proyectos PixelForge

`pixelforge-upload-store.js` implementa subida por chunks.

Constantes verificadas:

```text
CHUNK_BYTES = 6 MiB
UPLOAD_TTL = 24 horas
MAX_ACTIVE_UPLOADS_PER_ACCOUNT = 2
MAX_STAGED_UPLOAD_BYTES = 256 MiB
```

Las tablas son:

```text
codelab_pixelforge_project_uploads
codelab_pixelforge_project_upload_chunks
```

Cada chunk tiene:

```text
upload_id
chunk_index
chunk_data
chunk_sha256
```

La integridad se comprueba con SHA-256.

---

## 26. Flujo de upload

```text
cliente
  │
  │ beginUpload
  ▼
Neon
  │
  │ crea manifest
  ▼
upload_id
  │
  ├── chunk 0 + sha256 ──► Neon
  ├── chunk 1 + sha256 ──► Neon
  ├── ...
  └── chunk N + sha256 ──► Neon
                              │
                              ▼
                         assembleUpload
                              │
                              ▼
                         SHA-256 final
                              │
                              ▼
                         proyecto
```

El código comprueba tamaño, número de chunks, hashes y revisión esperada.

---

## 27. Estado persistente del proyecto

La arquitectura no utiliza el vídeo como fuente de verdad.

El orden de autoridad es:

```text
PostgreSQL project JSON
       +
server_revision
       +
content_sha256
       ↓
fuente de verdad del proyecto

video/image evidence
       ↓
diagnóstico/auditoría visual
```

Esto coincide con la política escrita en `README.md`.

---

# 28. GitHub

GitHub está separado del transporte principal del bridge.

La documentación del proyecto declara:

```text
GitHub = repositorio/versionado
Neon   = coordinación/persistencia de trabajos
```

Por tanto el flujo de una orden NO requiere:

```text
Agente → GitHub commit → CodeLab