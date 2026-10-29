# CodeLab XD Studio Pro v2.6.6

Editor web multiproyecto con autoguardado, ramas, merge de 3 vías y **login OAuth (GitHub / Google)**.

Cero dependencias npm — solo Node.js nativo.

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
| `NODE_ENV` | `production` |

Si no configuras OAuth, la UI ofrece **perfil demo local** (sin login real).

### Persistent Disk

Monta un disco en `/var/data` y define `CODELAB_DATA_DIR=/var/data`. Sin disco, workspaces y sesiones se pierden al redeploy.

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

## Changelog v2.6.1.0

- Login real GitHub y Google (OAuth 2.0)  
- Workspaces ligados a la cuenta del usuario  
- Cookie de sesión HttpOnly  
- Fallback demo si OAuth no está configurado  
- Móvil, dashboard de conexiones, asistente IA local/API (v2.5)  


## Changelog v2.6.2

- Proxy copiloto `POST /api/ai/complete` + `GET /api/ai/status`
- Modo Auto / API / Local; key de servidor o del usuario
- Rate limit dedicado para IA


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

La cuadrícula visual admite tamaños de **4, 8, 16 o 32 px** y puede activarse el ajuste magnético para alinear una capa al soltarla. El ajuste se guarda con el proyecto; la rejilla visual y el ajuste magnético se pueden controlar por separado. Al seleccionar una capa aparece un tirador en la esquina inferior derecha para redimensionarla directamente con ratón o táctil; también acepta flechas del teclado (Shift mueve 10 px).

El panel de propiedades también permite **enviar capas detrás o traerlas al frente**; el orden se refleja en el lienzo y se puede deshacer.

El lienzo también admite capas de imagen: subir PNG/JPEG/WebP/GIF de hasta **2 MB** o usar una URL HTTP(S), editar el texto alternativo y elegir si la imagen se cubre, contiene o estira. Las imágenes se guardan en el proyecto y se incluyen en las exportaciones HTML/SVG y en la captura visual para IA; el JSON de contexto describe la imagen sin duplicar el payload base64.

También puedes añadir **elipses y círculos**. La forma se mantiene al exportar a SVG y HTML, y forma parte de la captura para IA.

Incluye plantillas visuales para **landing de producto**, **panel de control** y **portfolio**. Si ya hay capas, el editor pide confirmación antes de reemplazarlas; la acción queda en el historial para poder deshacerla.

## Capturas para IA

Los proyectos de diseño y web permiten elegir captura PNG a 1×, 2×, 3× o 4× (máxima densidad), junto con JSON estructurado de elementos/código y estilos. El render vectorial de los diseños se rasteriza directamente a la escala elegida para conservar bordes nítidos. Los proyectos web permiten además seleccionar escritorio, tablet o móvil. El contexto JSON registra la escala real y las dimensiones en píxeles correspondientes. Para evitar agotar la memoria del navegador, se bloquean capturas superiores a 32 millones de píxeles y se recomienda bajar la escala o el ancho si ocurre. Para seguridad, el render aislado de captura no ejecuta el JavaScript del proyecto ni contenido embebido; los efectos dinámicos de JS no se reflejan en el PNG.

## Biblioteca de componentes reutilizables

Desde el panel principal, **Componentes** abre una biblioteca con secciones HTML autónomas: navegación, hero de landing, tarjetas de características, métricas, precios, formulario de contacto, panel de proyecto y pie de página. Permite buscar y filtrar por categoría, previsualizar el HTML en un iframe aislado, copiar el fragmento, exportar una página HTML adaptable e insertar el fragmento seleccionado en el HTML del proyecto web activo. Los componentes incluyen sus estilos en un bloque local para funcionar sin una librería CSS externa. La inserción conserva el HTML existente y solo está disponible desde proyectos web, no desde proyectos de diseño.
