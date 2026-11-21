# 🚨 POLÍTICA DEL AGENTE IA — ENTRADA OBLIGATORIA

> **Antes de cualquier trabajo sobre CodeLab, el agente debe leer `AGENTS.md`.** Ese archivo lleva a la política completa de `docs/agent-ai-bridge-policy.md` y resume las reglas que deben respetarse durante toda la sesión.
>
> **Solo el usuario puede iniciar al agente IA.** La evidencia visual debe inspeccionarse realmente. En dibujo/animación, las referencias pueden buscarse dinámicamente en Internet; no se debe depender de una imagen implantada como fuente obligatoria.

**[Abrir la política completa →](docs/agent-ai-bridge-policy.md)**

# CodeLab XD Studio Pro v2.7.0

Editor web multiproyecto con autoguardado, ramas, merge de 3 vías y **login OAuth (GitHub / Google)**.

**Runtime:** Node.js 22.17.0 o superior. Instala las dependencias con `npm install` y arranca el servidor con `npm start`.

Requiere **Node.js >=22.17.0**. El runtime usa `pg`, `@sparticuz/chromium` y `playwright-core`; `npm install` instala las dependencias declaradas y ejecuta el postinstall del runtime de navegador.

## 🧠 Arquitectura principal: agente → Neon → Cloudflare → CodeLab → evidencia → Neon → agente

**Esta es la arquitectura de ejecución que debe considerarse la fuente de verdad del sistema. No debe sustituirse por un flujo basado en clics, deslizamientos, commits intermedios o intervención manual del navegador.**

El ciclo completo funciona así:

```text
AGENTE
  │
  │ 1. crea una petición/trabajo
  ▼
NEON
  │
  │ 2. guarda la orden, estado, proyecto,
  │    revisión y contexto
  ▼
CLOUDFLARE
  │
  │ 3. transporta la petición mediante el
  │    puente de conexión
  ▼
CODELAB
  │
  │ 4. recibe la orden y la ejecuta directamente
  │    mediante sus interfaces de servidor
  │    sin deslizar, clickear ni usar la UI
  │    como mecanismo de automatización
  ▼
CODELAB
  │
  │ 5. termina el trabajo
  │
  ├── trabajo normal ───────────────► resultado
  │
  └── dibujo/animación
          │
          │ 6. renderiza y genera evidencia
          │    visual (vídeo y/o imágenes)
          ▼
CLOUDFLARE
  │
  │ 7. empaqueta/transfiere la evidencia
  │    por el mismo puente
  ▼
NEON
  │
  │ 8. guarda la confirmación, resultado,
  │    revisión y referencia al vídeo
  │
  │ 9. notifica al agente si sigue conectado
  ▼
AGENTE
  │
  │ 10. obtiene e inspecciona realmente
  │     el vídeo/evidencia
  │
  │ 11. toma la siguiente decisión
  └──────────────────────────────────────►
                    repetir
```

### Reglas de este flujo

1. **Neon es el punto de coordinación y persistencia del trabajo.**
2. **Cloudflare es el puente de transporte rápido entre Neon y CodeLab y el canal para la evidencia binaria.**
3. **CodeLab ejecuta trabajos de forma programática.** La automatización no debe depender de que un agente humano abra la web, deslice, pulse botones o confirme manualmente.
4. **Una animación no se considera terminada solo porque el código terminó.** Debe producir evidencia visual que permita comprobar el resultado.
5. **El vídeo es feedback del agente.** Después de recibir la confirmación, el agente debe inspeccionarlo y decidir si hace otra modificación.
6. **El ciclo puede repetirse tantas veces como sea necesario** hasta alcanzar el resultado correcto.
7. **La desconexión del agente no debe perder el trabajo.** Neon conserva el estado y la evidencia para que el agente pueda continuar cuando vuelva.
8. **Cada trabajo y cada evidencia deben estar correlacionados** mediante un identificador de trabajo/proyecto/revisión, evitando mezclar resultados de ejecuciones distintas.
9. **Los estados del trabajo deben ser explícitos**, por ejemplo: `queued → dispatched → running → rendering → uploading → completed/failed`.
10. **GitHub no es el transporte de cada cambio visual.** Los commits pueden servir para versionado del código, pero no deben ser un requisito para que una petición llegue a CodeLab o para entregar cada vídeo al agente.

### Arquitectura de persistencia y evidencia

- **Neon Postgres:** estado canónico del proyecto y de los trabajos, órdenes, revisiones, resultados, metadatos y referencias a evidencias.
- **Cloudflare Worker:** puente de transporte y punto de entrada/salida rápido para las operaciones del flujo.
- **Cloudflare R2:** almacenamiento de vídeos/imágenes y otros artefactos binarios de evidencia.
- **CodeLab:** ejecutor que modifica y procesa los proyectos.
- **Agente:** controlador del ciclo; analiza los resultados y decide las siguientes operaciones.
- **GitHub:** repositorio y versionado del software, no mecanismo obligatorio de transporte de cada trabajo.

> **Importante:** Neon Realtime es una posible vía de notificación en tiempo real, pero el sistema no debe depender exclusivamente de él. Si la infraestructura disponible no soporta Realtime, el estado persistido en Neon debe seguir permitiendo recuperar y continuar los trabajos.

### Flujo de una animación

Para una animación, la unidad completa de trabajo es:

```text
petición
  ↓
Neon registra job
  ↓
Cloudflare entrega job
  ↓
CodeLab modifica proyecto
  ↓
CodeLab ejecuta/renderiza animación
  ↓
genera vídeo
  ↓
Cloudflare transporta/almacena evidencia
  ↓
Neon registra completion + vídeo + revisión
  ↓
agente recibe aviso
  ↓
agente inspecciona vídeo
  ↓
decisión
  ↓
nueva petición si hace falta
```

**Una nueva decisión del agente puede iniciar inmediatamente otro ciclo. No debe ser necesario esperar un commit para cada iteración.**
### Puesta en marcha bajo demanda del bridge### Señal final de apagado del bridge
### Snapshot vital para el agente

El agente dispone de una instantánea consolidada en `GET /api/agent/bridge/state` (protegida con el mismo token de control). Devuelve el estado de vida del bridge, `wake_required`, motivo y versión de señal, runtime, las últimas órdenes y resultados, los proyectos PixelForge persistidos (ID, revisión y SHA) y las últimas evidencias visuales. Así el agente no necesita reconstruir el contexto desde un vídeo.

La regla de decisión es:

- `wake_required=false`: enviar la orden normalmente.
- `wake_required=true`: incluir `wake:true` y el `signalVersion` observado para dejar trazabilidad.
- Para continuar un proyecto existente, usar siempre `project_id` + su última `server_revision`; la evidencia visual es diagnóstico/auditoría, no la fuente de verdad.
- Antes de corregir una tarea antigua, consultar el snapshot y recuperar el proyecto persistido más reciente.

El snapshot también conserva el último comando ejecutado y un resumen de su resultado, incluyendo error, revisión y `evidenceEventId` cuando estén disponibles.

El consumidor nativo mantiene en Neon la tabla `codelab_agent_bridge_state` y emite una **última señal persistente antes de apagarse**. La señal usa `state=sleeping`, `wake_required=true`, `wake_reason` y un `signal_version` monotónico. Así el agente puede consultar el estado antes de crear la siguiente orden y, si `wake_required=true`, incluir `wake:true` en el payload de esa orden.

El servidor también escucha las inserciones/transiciones a `queued` de `codelab_agent_commands`. Cuando llega una orden, puede levantar el bridge bajo demanda; no se utiliza un temporizador para mantenerlo despierto. Al arrancar, el bridge marca `wake_required=false` y vuelve a estado `running`.

El orden recomendado queda:

```text
CodeLab → señal final en Neon (sleeping + wake_required=true)
       ↓
Agente consulta estado
       ↓
Nueva orden Neon (+ wake:true si corresponde)
       ↓
Neon → CodeLab wake → ejecución
       ↓
CodeLab → resultado/evidencia → Neon
```

La señal es de coordinación, no reemplaza el estado persistente de proyectos ni convierte el vídeo de evidencia en fuente de verdad.

El consumidor `agent-bridge-worker.mjs` **no se levanta por intervalo ni por cron**. El servidor expone una operación controlada para que el agente lo inicie únicamente cuando vaya a enviar/ejecutar trabajos por Neon:

`POST /api/agent/bridge/ensure`

Requiere el header `x-codelab-agent-bridge-token` con `CODELAB_AGENT_BRIDGE_CONTROL_SECRET`. Si ya está activo, la operación no crea otro proceso; devuelve su estado. Si el proceso termina, no se relanza mediante un temporizador: el siguiente `ensure` solicitado por el agente vuelve a levantarlo.

Esto mantiene separado el **control de ciclo de vida** del consumidor de cualquier polling de aplicación. No hay una pulsación periódica del agente para mantenerlo despierto.


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

Todas las pruebas, proyectos auxiliares y cambios de proyecto deben ejecutarse dentro de la cuenta real **ADMIN** del usuario. No se permite usar perfiles demo, invitados ni sesiones anónimas. Antes de operar se verifica la identidad y el workspace; después se confirma la sincronización y se vuelve a leer el proyecto desde el servidor. Si no se puede confirmar la cuenta ADMIN, la operación se detiene. Consulta la [política obligatoria de cuenta y persistencia](docs/account-admin-and-persistence-policy.md).

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

- Se sincroniza la documentación de versión y dependencias con `package.json`.
- Se actualiza CI a Node.js 22.17.0, acorde con el mínimo declarado por el proyecto.
- Se aclara la separación entre el flujo actual Neon/bridge y los antiguos workflows A/B.

### v2.6.6

- Flujo de trabajo del agente IA documentado como ciclo persistente Neon → Cloudflare → CodeLab → evidencia → Neon → agente.
- La evidencia visual de animaciones forma parte del cierre de cada trabajo.
- El agente puede inspeccionar el resultado y encadenar nuevas decisiones sin depender de commits como mecanismo de transporte.
