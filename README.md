# 🚨 POLÍTICA DEL AGENTE IA — ENTRADA OBLIGATORIA

> Antes de cualquier trabajo sobre CodeLab, leer [AGENTS.md](AGENTS.md) y [la política operativa completa](docs/agent-ai-bridge-policy.md).
>
> **Mapa de lectura:** [Índice de documentación](docs/README.md). Define qué documento corresponde a cada tarea y cuál prevalece si hay contradicciones.
>
> **Distinción crítica:** el Headless propio del agente crea y exporta el proyecto, pero NO se conecta al intermediario. El agente IA recoge el archivo exportado fuera del Headless y lo transfiere a CodeLab. Si se pide vídeo, A/B es la etapa integrada que produce el vídeo final que recibe el usuario.

# CodeLab XD Studio Pro v2.7.0

## Documentos clave para agentes

- [AGENTS.md](AGENTS.md) — reglas obligatorias y flujo canónico.
- [Índice de documentación](docs/README.md) — mapa por tarea, orden de autoridad y documentos especializados.
- [Política del agente y bridge](docs/agent-ai-bridge-policy.md) — límites y responsabilidades entre agente, Neon, CodeLab y worker.
- [Headless propio del agente](docs/HEADLESS-AGENT-RUNTIME.md) — cómo obtener, instalar y ejecutar el artefacto en el entorno de la IA.
- [Flujo autónomo de animación](docs/ANIMATION-AUTONOMOUS-WORKFLOW.md) — ciclo de creación, verificación y aceptación.
- [Transporte inline](docs/inline-artifact-bridge.md) — entrega del paquete, staging, importación y persistencia.
- [Arquitectura CodeLab ↔ Neon](docs/CodeLab_Neon_comunicacion_extremo_a_extremo.md) — órdenes, LISTEN/NOTIFY, worker y estado durable.
- [Procesamiento A/B](docs/VIDEO-PROCESSING-AB.md) — ruta especializada exclusivamente para vídeo.

> Los documentos son complementarios, pero no tienen la misma autoridad. Si un resumen o una guía antigua contradice AGENTS.md o los procedimientos canónicos, prevalecen las reglas de entrada y debe corregirse el documento obsoleto.

Editor web multiproyecto con autoguardado, ramas, merge de 3 vías y **login OAuth (GitHub / Google)**.

**Runtime:** Node.js 22.17.0 o superior. El servidor utiliza `pg`, `@sparticuz/chromium` y `playwright-core`. Ejecuta `npm install` para instalar las dependencias y su postinstall de navegador; después inicia con `npm start`.

> Documentación técnica de conexión y funcionamiento: [CodeLab ↔ Neon extremo a extremo](docs/CodeLab_Neon_comunicacion_extremo_a_extremo.md). El diagrama y los detalles deben reflejar siempre el código actual.
> Catálogo de órdenes y operaciones del agente: [CodeLab + PixelForge command catalog](docs/CODELAB-PIXELFORGE-COMMAND-CATALOG.md), con contratos, capacidades Headless, aprobación y límites de cobertura.

## 🧠 Arquitectura de órdenes y entregas: agente → Headless aislado → intermediario → CodeLab → A/B (si se pidió vídeo) → usuario

**Importante: este diagrama describe la cola de órdenes del sistema, no el entorno donde el agente crea o anima.** El trabajo creativo se realiza en el Headless propio del agente y la entrega del paquete editable usa el HTTPS inline bridge; ambos están explicados en [el índice documental](docs/README.md).

**Arquitectura implementada del flujo de órdenes:** Neon guarda la orden; PostgreSQL la notifica directamente a CodeLab mediante LISTEN/NOTIFY. Cloudflare/R2 es una ruta de almacenamiento de evidencia cuando está configurada, no un salto obligatorio para entregar cada orden.

```text
AGENTE
  │ INSERT orden (queued) / consulta resultado
  ▼
NEON POSTGRESQL
  │ tabla durable codelab_agent_commands
  │ trigger AFTER INSERT/UPDATE → pg_notify()
  ▼
CODELAB SERVER (server.js)
  │ pg.Client: LISTEN codelab_agent_bridge_wake
  │ spawn del worker si no existe
  ▼
AGENT BRIDGE WORKER
  │ reclama orden con transacción + SKIP LOCKED
  │ ejecuta APIs/runtime headless de CodeLab
  │ valida, persiste resultado y genera evidencia
  ▼
NEON POSTGRESQL
  │ proyecto + revisión + hash + resultado + event_id
  ├─────────────► CLOUDFLARE/R2 o S3 (bytes de evidencia, si está configurado)
  │
  ▼
AGENTE
  │ consulta snapshot, inspecciona vídeo/imagen
  └─────────────► decide si envía otra orden
```

### Reglas de esta arquitectura

1. **Neon es la fuente durable** de órdenes, estado, proyectos persistentes, revisiones, resultados y metadatos de evidencia.
2. **La notificación de PostgreSQL despierta CodeLab directamente.** NOTIFY no transporta el proyecto ni sustituye la fila de la orden.
3. **Cloudflare/R2 no es un requisito para el transporte de órdenes.** Se utiliza para bytes grandes de evidencia cuando está configurado; Neon conserva las referencias.
4. **CodeLab ejecuta trabajos de forma programática** mediante el worker y sus APIs/runtime. No depende de clicks o deslizamientos manuales para procesar una orden.
5. **Una animación no se considera visualmente verificada solo porque la acción terminó.** Debe producir evidencia e inspeccionarse.
6. **La evidencia no sustituye el documento editable.** Para continuar se usa project_id y la última server_revision.
7. **El agente decide nuevas tareas.** El worker completa órdenes autorizadas; no inicia tareas autónomas nuevas.
8. **GitHub versiona y prueba el software.** No es el transporte de cada modificación ni de cada vídeo.
9. **No hay polling de cola cada 150 ms ni keep-alive por cron.** El worker espera LISTEN/NOTIFY cuando está ocioso.
10. **La recuperación se basa en el estado durable.** Antes de reintentar, consultar órdenes activas para no duplicarlas.

### Persistencia y evidencia

- **Neon Postgres:** cuentas, órdenes, proyectos, revisiones, hashes, resultados, eventos y referencias.
- **CodeLab server.js:** API HTTP, autenticación/workspaces, pool SQL, listener y launcher del worker.
- **agent-bridge-worker.mjs:** claim/execute/validate/finish, runtime headless y generación de evidencia.
- **Cloudflare/R2 o S3-compatible:** almacenamiento de bytes de vídeo/imagen cuando está configurado.
- **Agente:** inspección y decisión de la siguiente iteración.
- **GitHub Actions:** pruebas de código/contratos; no certifica por sí solo el despliegue en Render ni la conectividad actual de Neon.

El flujo de animación es: petición → fila queued en Neon → NOTIFY → worker → edición/render → evento de evidencia → upload binario opcional → Neon guarda revisión/resultado/referencia → agente inspecciona → nueva decisión.

### Activación y ciclo de vida del bridge

El servidor arma al iniciar un cliente PostgreSQL dedicado con `LISTEN codelab_agent_bridge_wake`. Un trigger AFTER INSERT OR UPDATE OF status publica NOTIFY cuando una orden pasa a `queued`. El listener arranca `agent-bridge-worker.mjs` bajo demanda; si ya está activo, no crea otro proceso.

Al armar/reconectar LISTEN, el servidor reconcilia cualquier orden queued no expirada, aunque el payload no tenga `wake:true`. Esto cubre la ventana en la que una notificación pudo producirse antes de registrar el listener.

El worker mantiene su propio listener. Reclama órdenes desde la tabla durable con una transacción y `FOR UPDATE SKIP LOCKED`. Si no encuentra trabajo, espera una notificación sin polling.

También existe la operación explícita `POST /api/agent/bridge/ensure` (GET como fallback), protegida por `x-codelab-agent-bridge-token` y `CODELAB_AGENT_BRIDGE_CONTROL_SECRET`. Sirve para iniciar el worker de forma controlada; no es el mecanismo normal de entrega ni un cron.

### Snapshot del bridge

`GET /api/agent/bridge/state` requiere el mismo token y devuelve:
- estado de bridge y señal `wake_required` / `signal_version`;
- últimas 20 órdenes con payload/result;
- últimos 20 proyectos PixelForge con revisión/hash;
- últimas 20 evidencias cuando la tabla existe.

No consultarlo continuamente: los payload/result y documentos pueden ser grandes. Usar el snapshot al iniciar o recuperar una tarea y preferir consultas pequeñas para seguimiento.

### Detalles de conexión

Los pools SQL normales de `server.js` y el worker usan `DATABASE_URL`. El pool del servidor tiene máximo 5 conexiones; el del worker, máximo 2. Los dos usan `CODELAB_DATABASE_SSL`: TLS por defecto y `disable` solo para pruebas locales. Los clientes dedicados LISTEN convierten el hostname `-pooler.` al endpoint directo equivalente y mantienen una conexión `pg.Client` estable.

El listener del servidor reintenta también si falla la conexión inicial y reconecta con backoff exponencial limitado a 60 segundos. El listener del worker reintenta tras 5 segundos y vuelve a reclamar desde la cola durable. Durante una ejecución, el worker actualiza el heartbeat de la orden cada 30 segundos.

La documentación técnica completa, con diagramas de componentes/secuencia, SQL, esquemas, acciones, expiración, locks, recuperación, workspace ADMIN, persistencia, evidencia, seguridad y auditoría de transferencia, está en [CodeLab ↔ Neon: comunicación técnica extremo a extremo](docs/CodeLab_Neon_comunicacion_extremo_a_extremo.md).

## Login OAuth (recomendado en Render)

Con OAuth, cada usuario obtiene un **workspace fijo** ligado a su cuenta. Así puedes abrir la app desde cualquier dispositivo y recuperar tus proyectos.

### 1. GitHub

1. GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App
2. Homepage URL: `https://TU-APP.onrender.com`
3. Authorization callback URL: `https://TU-APP.onrender.com/api/auth/github/callback`
4. Copia Client ID y Client Secret

### 2. Google

1. [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → OAuth 2.0 Client ID (Web)
2. Authorized redirect URI: `https://TU-APP.onrender.com/api/auth/google/callback`
3. Copia Client ID y Client Secret

### 3. Variables en Render

| Variable | Descripción |
|----------|-------------|
| `GITHUB_CLIENT_ID` | Client ID de GitHub |
| `GITHUB_CLIENT_SECRET` | Client Secret de GitHub |
| `GOOGLE_CLIENT_ID` | Client ID de Google |
| `GOOGLE_CLIENT_SECRET` | Client Secret de Google |
| `OAUTH_PUBLIC_URL` | URL pública exacta, ej. `https://TU-APP.onrender.com` (recomendado) |
| `CODELAB_DATA_DIR` | `/var/data` con Persistent Disk |
| `CODELAB_WORKSPACE_SECRET` | Cadena aleatoria larga |
| `CODELAB_TRUSTED_PROXY_HOPS` | Saltos de proxy inverso confiables que agregan X-Forwarded-For (default 1; ajusta a la cadena real del hosting) |
| `CODELAB_MAX_BODY_BYTES` | Tamaño máximo de solicitud JSON en bytes (default 10 MiB) |
| `CODELAB_MAX_PROJECTS` | Máximo de proyectos por workspace (default 50) |
| `CODELAB_UPSTREAM_TIMEOUT_MS` | Tiempo máximo de inactividad para llamadas HTTPS a proveedores (default 60000; entre 1000 y 300000 ms) |
| `CODELAB_AGENT_BRIDGE_CONTROL_SECRET` | Secreto que autoriza al agente a ejecutar la operación explícita `POST /api/agent/bridge/ensure` para levantar el consumidor Neon → CodeLab bajo demanda |
| `NODE_ENV` | `production` |

Si no configuras OAuth, la UI ofrece **perfil demo local** (sin login real).

### Persistent Disk

Monta un disco en `/var/data` y define `CODELAB_DATA_DIR=/var/data`. Sin disco, workspaces y sesiones se pierden al redeploy.

## Cuenta ADMIN y persistencia de pruebas

Las operaciones sobre proyectos reales del usuario deben conservar la identidad y el workspace **ADMIN** que CodeLab resuelve mediante la configuración y autenticación existentes. Las pruebas aisladas pueden utilizar sesiones locales/headless y directorios temporales; estas sesiones son útiles para automatización, pero no se deben presentar como persistencia en el workspace real. Antes de declarar un cambio del usuario como guardado, verifica la sincronización y vuelve a leer el proyecto desde el servidor. Consulta la [política de cuenta y persistencia](docs/account-admin-and-persistence-policy.md).

## Seguridad

- OAuth con `state` anti-CSRF
- Sesión en cookie **HttpOnly** + `SameSite=Lax` (+ `Secure` en producción)
- Workspace por usuario: `ws_{provider}_{id}`
- Acceso por token HMAC **o** sesión dueña del workspace
- Rate limit con saltos de proxy confiables configurables; se rechazan cadenas X-Forwarded-For malformadas para evitar desplazar la selección de IP confiable
- Validación de payload, límites de tamaño y path traversal bloqueado
- Preview en iframe sandbox + CSP

## Copiloto IA

El cliente llama a **`POST /api/ai/complete`** (proxy en el servidor). Así se evita CORS y la ruta queda lista para APIs OpenAI-compatible. Por seguridad, las URLs de proveedores deben usar HTTPS y resolver exclusivamente a IP públicas; se bloquean destinos locales/privados y se fija la IP validada para reducir SSRF y DNS rebinding.

| Variable | Descripción |
|----------|-------------|
| `AI_API_KEY` o `OPENAI_API_KEY` | Clave del proveedor (recomendado en Render) |
| `AI_BASE_URL` | Default `https://api.openai.com/v1` (Groq, OpenRouter, etc.) |
| `AI_MODEL` | Default `gpt-4o-mini` |
| `AI_MAX_TOKENS` | Default `4096` |
| `AI_RATE_MAX` | Max peticiones IA / minuto / IP (default 20) |

Sin key en el servidor, el usuario puede pegar la suya en **Ajustes del copiloto** (modo API). Sin ninguna key, se usan plantillas locales.
Las claves y preferencias del copiloto se guardan en el navegador bajo una clave separada por cuenta OAuth. Las claves heredadas de versiones anteriores que usaban un único espacio global no se reutilizan al entrar en una cuenta real, para evitar mezclar credenciales entre usuarios del mismo dispositivo.

Comprobar: `GET /api/ai/status` → `{ "serverKey": true, ... }`

## Desarrollo local

```bash
# Opcional: exporta GITHUB_* / GOOGLE_* y OAUTH_PUBLIC_URL=http://localhost:3000
node server.js
```

## Laboratorio de diseño visual

Desde **Herramientas** en el panel principal se abre el laboratorio de diseño. Incluye:

- Paleta con colores primario, secundario, acento, superficie, fondo y texto, con generación automática de tonos 50–900.
- Vista previa de componentes para revisar cómo conviven los colores antes de usarlos en una interfaz.
- Comprobador de contraste basado en la fórmula WCAG: AA para texto normal (4.5:1), AA para texto grande (3:1) y AAA para texto normal (7:1).
- Auditoría estática del HTML del proyecto abierto para detectar imágenes sin alt, campos sin etiqueta detectable, botones/enlaces sin nombre, ids duplicados, saltos de encabezados y metadatos básicos; permite exportar un informe JSON.
- Tokens ajustables para escala tipográfica, espaciado y radios de borde.
- Aplicación directa del bloque de tokens al CSS del proyecto web abierto, reemplazando solo el bloque administrado y preservando el resto del CSS.
- Exportación de variables CSS y JSON estructurado para reutilizar el sistema visual en proyectos.
- Guardado local de respaldo y sincronización del sistema visual con el workspace del usuario. Con OAuth real configurado, los ajustes se recuperan en otros dispositivos con la misma cuenta; si el servidor no está disponible, se conserva la copia local. La importación/exportación JSON sigue disponible para compartir o trasladar sistemas manualmente.

Las pruebas automáticas cubren los cálculos de contraste, generación de tokens, exportaciones y una prueba de interacción en Chromium.

## Exportación del editor visual

El editor visual permite exportar el diseño como HTML adaptable, SVG vectorial o respaldo JSON del proyecto (con sus elementos editables). El HTML ajusta el marco del diseño al ancho de la pantalla al abrirlo y recalcula la escala cuando cambia el tamaño de la ventana. Los valores de color se validan antes de insertarlos en el HTML exportado.

Atajos del lienzo: **Ctrl/Cmd + Z** deshacer, **Ctrl/Cmd + Shift + Z** o **Ctrl/Cmd + Y** rehacer, **Ctrl/Cmd + D** duplicar la capa seleccionada, **Supr/Backspace** eliminarla y las **flechas** moverla un píxel (con **Shift**, diez píxeles). Los atajos de movimiento no interceptan la escritura en campos de texto.

La cuadrícula visual admite tamaños de **4, 8, 16 o 32 px** y puede activarse el ajuste magnético para alinear una capa al soltarla. El ajuste se guarda con el proyecto; la rejilla visual y el ajuste magnético se pueden controlar por separado. Al seleccionar una capa aparece un tirador en la esquina inferior derecha para redimensionarla directamente con ratón o táctil; también acepta flechas del teclado (Shift mueve 10 px). Puedes seleccionar varias capas con **Shift + clic** desde el lienzo o la lista de capas, alinear sus bordes y centros entre sí, distribuir tres o más horizontal o verticalmente con espacios iguales y eliminar la selección múltiple de una sola vez.

El modo **Auto Layout** organiza las capas por orden de inserción, en fila con salto de línea o en columna. Permite configurar el espacio entre capas y el relleno exterior (0–200 px); el lienzo, la captura de IA y el contexto JSON usan las posiciones calculadas, mientras que HTML y la conversión a web exportan un flujo flex responsive que se apila en pantallas estrechas. Cambia a **Libre** cuando quieras volver a arrastrar capas a coordenadas manuales.

El panel de propiedades también permite **enviar capas detrás o traerlas al frente**; el orden se refleja en el lienzo y se puede deshacer. Las capas de tipo botón aceptan un destino HTTP(S): usa **Alt + clic** para probar la navegación en una pestaña nueva, o exporta/convierte el diseño a web para conservar el enlace. Los esquemas inseguros como `javascript:` se rechazan.

El lienzo también admite capas de imagen: subir PNG/JPEG/WebP/GIF de hasta **2 MB** o usar una URL HTTP(S), editar el texto alternativo y elegir si la imagen se cubre, contiene o estira. Las imágenes se guardan en el proyecto y se incluyen en las exportaciones HTML/SVG y en la captura visual para IA; el JSON de contexto describe la imagen sin duplicar el payload base64.

También puedes añadir **elipses y círculos**. La forma se mantiene al exportar a SVG y HTML, y forma parte de la captura para IA.

Incluye plantillas visuales para **landing de producto**, **panel de control** y **portfolio**. Si ya hay capas, el editor pide confirmación antes de reemplazarlas; la acción queda en el historial para poder deshacerla.

## Capturas para IA

Los proyectos de diseño y web permiten elegir captura PNG a 1×, 2×, 3× o 4× (máxima densidad), junto con JSON estructurado de elementos/código y estilos. El render vectorial de los diseños se rasteriza directamente a la escala elegida para conservar bordes nítidos. Los proyectos web permiten además seleccionar escritorio, tablet o móvil. El contexto JSON registra la escala real y las dimensiones en píxeles correspondientes. Para evitar agotar la memoria del navegador, se bloquean capturas superiores a 32 millones de píxeles y se recomienda bajar la escala o el ancho si ocurre. Para seguridad, el render aislado de captura no ejecuta el JavaScript del proyecto ni contenido embebido; los efectos dinámicos de JS no se reflejan en el PNG.

## Biblioteca de componentes reutilizables

La acción **Convertir a web** conserva las capas de imagen incrustadas, las elipses, los estilos y los enlaces seguros de los botones; la página generada ajusta el marco al ancho de pantalla y recalcula la escala al redimensionar la ventana.

Desde el panel principal, **Componentes** abre una biblioteca con secciones HTML autónomas: navegación, hero de landing, tarjetas de características, métricas, precios, formulario de contacto, panel de proyecto y pie de página. Permite buscar y filtrar por categoría, previsualizar el HTML en un iframe aislado, copiar el fragmento, exportar una página HTML adaptable e insertar el fragmento seleccionado en el HTML del proyecto web activo. Los componentes incluyen sus estilos en un bloque local para funcionar sin una librería CSS externa. La inserción conserva el HTML existente y solo está disponible desde proyectos web, no desde proyectos de diseño.

## Editor visual: interacción táctil y organización

- El zoom del lienzo es independiente del zoom de la interfaz. Usa el control de porcentaje para un ajuste preciso o pellizca con dos dedos sobre el área del lienzo en dispositivos táctiles.
- En móvil, el lienzo conserva el espacio principal; el Inspector reúne la lista de capas y los controles del elemento seleccionado en un único panel desplazable.
- En orientación horizontal se reduce la altura de la barra de herramientas y del Inspector para aprovechar el espacio disponible.
- El Inspector completo se puede plegar y volver a abrir desde la barra del editor para liberar el lienzo, por ejemplo al trabajar con diagramas y conexiones de nodos.
- Las operaciones de ramas y merge pertenecen al editor web, no al espacio de diseño.
- El panel separado de «Propiedades» y su botón se eliminaron; sus controles viven dentro del Inspector.

## Changelog

### v2.7.0
- El bridge Neon usa LISTEN/NOTIFY en servidor y worker; se elimina el polling de cola de 150 ms y se reconcilian órdenes queued al armar/reconectar el listener.
- El listener del servidor reintenta también ante fallos de conexión inicial con backoff exponencial; la recuperación no depende de reiniciar Render.
- Se documenta la topología real de conexiones pooled/directas, TLS, trigger, claim transaccional, heartbeat, estados, persistencia, evidencia, seguridad y consumo de transferencia.
- Se agregan pruebas de contrato para activación event-driven, reconciliación queued, reconexión inicial y consistencia de TLS/endpoints.

- Se sincroniza la documentación de versión y dependencias con `package.json`.
- Se actualiza CI a Node.js 22.17.0, acorde con el mínimo declarado por el proyecto.
- Se aclara la separación entre el flujo actual Neon/bridge y los antiguos workflows A/B.

### v2.6.6

- Flujo de trabajo del agente IA documentado como ciclo persistente Neon → CodeLab → evidencia → Neon → agente. Cloudflare/R2 queda como almacenamiento opcional de evidencia, no como transporte obligatorio de órdenes.
- La evidencia visual de animaciones forma parte del cierre de cada trabajo.
- El agente puede inspeccionar el resultado y encadenar nuevas decisiones sin depender de commits como mecanismo de transporte.
