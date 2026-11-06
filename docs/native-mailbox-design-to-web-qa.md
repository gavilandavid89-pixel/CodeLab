# CodeLab: flujo nativo de diseño a web y verificación

**Estado de esta bitácora:** 2026-11-06  
**Repositorio:** `gavilandavid89-pixel/CodeLab`  
**Rama de referencia:** `main`  
**Servicio autorizado:** Render `srv-db3bbc142hec7396fvvg` — https://codelab-pbw9.onrender.com/  
**Cuenta obligatoria:** `ADMIN` (`local`, rol `admin`, workspace `ws_local_admin`)

Esta bitácora es la referencia operativa para continuar el trabajo. Actualizarla al cerrar cada bloque de trabajo, con resultados observados y límites de verificación. No convertir hipótesis en hechos.

## 1. Arquitectura: dos caminos distintos

### 1.1 Buzón nativo de CodeLab — acciones sobre proyectos

El worker `agent-bridge-worker.mjs` consulta PostgreSQL en la tabla `public.codelab_agent_commands`. Reclama comandos pendientes con bloqueo transaccional (`FOR UPDATE SKIP LOCKED`), los ejecuta y registra estado, resultado y tiempos.

Para crear, convertir o inspeccionar proyectos de CodeLab se usa este buzón nativo. El flujo no necesita GitHub Issues ni GitHub Actions.

Acciones CodeLab admitidas por el esquema actual:
- `codelab_project_create`
- `codelab_project_convert_to_web`
- `codelab_project_inspect`

Los comandos se guardan con `workspace_id=ws_local_admin`. El worker resuelve el workspace a partir de la cuenta ADMIN real. No usar cuentas demo, invitadas, temporales ni perfiles de prueba.

### 1.2 GitHub Actions — validación del código fuente

Actions se reserva para:
- pruebas unitarias y de integración del repositorio;
- lint, build y comprobaciones estáticas;
- regresiones del worker y de la aplicación;
- validaciones de cambios de código antes/después del deploy.

No usar Actions como intermediario para crear o editar proyectos del workspace de CodeLab. No presentar un workflow verde como prueba de que un proyecto real se abrió o funcionó en el navegador.

## 2. Límites de infraestructura y seguridad

- Repositorio de trabajo: `gavilandavid89-pixel/CodeLab`, rama `main`.
- Único servicio Render autorizado en este flujo: `srv-db3bbc142hec7396fvvg` (`https://codelab-pbw9.onrender.com/`).
- No tocar PixelForge ni otros servicios Render.
- No cambiar la rama/experimento `headless`; no es el camino de ejecución de proyectos solicitado.
- PixelForge es un producto/espacio separado. No mover ni copiar proyectos PixelForge como parte de estas pruebas de CodeLab.
- Antes de una acción persistente, verificar ADMIN y workspace. Después, volver a leer el proyecto desde el workspace del servidor y comprobar revisión/persistencia.
- No ejecutar SQL destructivo ni cambios de esquema sin autorización explícita.
- No usar credenciales, secretos o tokens en documentación.

## 3. Prueba ejecutada: Diseño → Web

Proyecto de prueba persistido en el workspace ADMIN:

| Dato | Valor observado |
|---|---|
| Nombre | QA — Diseño a Web — Native Mailbox |
| ID | `proj_native_native-design-to-web-20261106-01` |
| Workspace | `ws_local_admin` |
| Revisión tras creación | 57 |
| Revisión tras conversión | 58 |
| Tipo tras conversión | `web` |
| Elementos de diseño | 3 |
| HTML generado | 2,575 bytes según resultado del comando |
| Proyecto total en workspace | 6 |

Elementos iniciales del diseño:
1. Encabezado “Diseña. Construye. Publica.”
2. Texto descriptivo.
3. Botón “Probar interacción”.

Comandos nativos ejecutados y resultados:
- `native-design-to-web-20261106-01` — `codelab_project_create` — `succeeded`.
- `native-design-to-web-20261106-02` — `codelab_project_convert_to_web` — `succeeded`.
- `native-design-to-web-20261106-03` — `codelab_project_inspect` — `succeeded`.

La inspección posterior confirmó `type=web`, revisión 58, tres elementos, HTML disponible, espacio de diseño y web presentes, y un control marcado con `data-codelab-demo`. Una consulta de estado del workspace confirmó el proyecto guardado en la revisión 58 y un manejador de clic incluido en el HTML.

URL directa del proyecto:
https://codelab-pbw9.onrender.com/?projectId=proj_native_native-design-to-web-20261106-01

## 4. Recorrido de capturas: hallazgo y corrección

### 4.1 Cómo funcionaba el flujo anterior

El worker ya tenía Chromium + Playwright y una rutina de captura llamada `capturePixelForgeInterface`. Esa rutina:
- inicia Chromium headless;
- navega a una URL fija: `/pixelforge/index.html`;
- escucha errores de consola y excepciones de página;
- captura la interfaz y el lienzo;
- puede subir PNG a Neon Object Storage;
- devuelve metadatos, `visionContext` y, cuando se solicita, `dataBase64` para que el consumidor pueda visualizar la imagen.

El buzón conservaba resultados en `codelab_agent_commands.result`. Se recuperaron comandos históricos con estado `succeeded`, método `playwright-chromium-real-browser`, capturas PNG y errores de página vacíos. Ejemplo: `chatgpt-mobile-720x1600-1793844780000` (viewport 720×1600). La imagen se recuperó desde el campo `result.images[0].dataBase64` y pudo mostrarse para inspección.

### 4.2 Desconexión detectada

La captura anterior estaba acoplada a PixelForge: URL fija, selector `#canvas` y captura del lienzo de PixelForge. No era una capacidad genérica de CodeLab Design/Web. Las acciones `codelab_project_inspect` solo devolvían metadatos JSON y nunca abrían Chromium. Por eso la prueba de diseño a web no podía producir capturas visuales aunque el worker tuviera Playwright instalado.

También existen dos buckets en Neon:
- `codelab-captures-public` (`public_read`), usado por capturas recientes;
- `codelab-captures` (`private`), legado. No asumir que ambos tienen el mismo acceso.

### 4.3 Corrección de código introducida

Se amplió `codelab_project_inspect` con una opción explícita `browser_test: true`. En ese modo:
- vuelve a leer el proyecto persistido del workspace ADMIN;
- carga su HTML guardado en Chromium con `page.setContent`;
- ejecuta el test en escritorio (1440×1000) y móvil (390×844);
- comprueba documento, viewport, frame, encabezado, botón, clic real, cambio de texto de estado, overflow horizontal y errores de consola/página;
- toma un PNG por viewport y lo devuelve en `result.browserTest.viewports[].screenshot.dataBase64`;
- etiqueta el método como `playwright-chromium-saved-html-setcontent` y deja claro que es un render aislado del HTML, no una navegación por la ruta pública.

La captura se incluye en el resultado del comando del buzón, por lo que el consumidor puede recuperar el base64 y mostrar la imagen. El test es opt-in para que las inspecciones normales no gasten CPU ni generen imágenes. El navegador reutiliza una sola página y cambia el viewport con `page.setViewportSize`; esto evita cerrar/crear varios contextos Chromium en el modo `--single-process` de `@sparticuz/chromium`.

### 4.4 Diagnóstico del primer intento y corrección

El primer test de navegador falló en Render con `browserContext.newPage: Target page, context or browser has been closed`. Los logs confirmaron que Chromium había arrancado. La primera implementación cerraba y recreaba contextos dentro del mismo navegador empaquetado en modo single-process. Se cambió a un único BrowserContext y una única Page reutilizada para escritorio y móvil, cambiando el viewport entre pasadas. El fallo original quedó registrado como fallido; no se sobrescribió como éxito.

### 4.5 Regresión de código

Se añadió `tests/codelab-native-browser-capture.test.mjs` y se incorporó al job de validación de código en `.github/workflows/codelab-command-bridge.yml`. La suite `CodeLab QA and command mailbox` terminó en verde para el commit `65d1874`; el job `code-tests` finalizó correctamente. La regresión también cubre la estructura del header Studio, la clasificación del sandbox y la recuperación/heartbeat de la cola. Actions solo valida sintaxis y pruebas del repositorio; no crea ni ejecuta el proyecto. El test de navegador real se dispara a través del buzón nativo.

## 5. Resultado final de la prueba visual y adaptación móvil

El primer test visual con el HTML antiguo detectó que el diseño absoluto se reducía proporcionalmente en móvil: CTA de 67 px y encabezado de 48 px dentro de un canvas escalado. La comprobación `mobileControlsReadable` falló aunque el HTML cargaba, el clic funcionaba y no había overflow.

Se corrigió `exportDesignToHtml` para que los diseños absolutos se reorganicen en una columna a menos de 768 px:
- encabezados con tamaño fluido `clamp(28px, 7vw, 40px)`;
- textos con tamaño legible y altura automática;
- botones con ancho adaptativo y máximo de 320 px;
- rectángulos, elipses e imágenes con reglas móviles específicas;
- desktop conserva el posicionamiento original.

Importante: actualizar el conversor no cambia HTML ya generado. Por eso se volvió a ejecutar `codelab_project_convert_to_web` sobre el mismo proyecto para persistir la revisión nueva.

Comandos finales:
- `native-design-to-web-reconvert-20261106-01` — conversión nativa — `succeeded`, revisión 59, HTML 3,977 bytes.
- `native-codelab-browser-qa-20261106-04` — inspección + Chromium — `succeeded`, `browserTest.passed=true`.

Resultado observado en revisión 59:
- Escritorio 1440×1000: todos los checks verdaderos.
- Móvil 390×844: todos los checks verdaderos.
- CTA móvil: 342 px de ancho, fuente 17 px.
- Encabezado móvil: 28 px.
- `horizontalOverflow=false`, `pageErrors=[]`, clic real y texto de confirmación presentes.

Las capturas PNG de ambas vistas se guardan en el resultado JSONB del comando, dentro de `result.browserTest.viewports[0|1].screenshot.dataBase64`. Se recuperaron desde PostgreSQL y se visualizaron. La captura es evidencia del HTML persistido en un navegador aislado; todavía no demuestra la carga de la ruta pública del proyecto.

## 6. Revisión del ciclo de vida de la cola y corrección

La revisión del flujo encontró dos riesgos operativos:
1. La recuperación de comandos `running` antiguos no filtraba por `workspace_id`, por lo que un worker podía reencolar comandos ajenos.
2. La recuperación usaba `started_at` como si fuera una concesión de ejecución; una tarea larga podía superar tres minutos y parecer abandonada aunque siguiera activa. Un deploy durante una ejecución también puede detener el proceso y dejar un comando en `running`.

Se corrigió el worker:
- las órdenes expiradas en cola o ejecución pasan a `expired` y reciben `finished_at`;
- recuperación de ejecuciones abandonadas limitada a `workspace_id=ws_local_admin`;
- el timeout de recuperación usa `updated_at`, no `started_at`;
- cada comando activo renueva `updated_at` cada 30 segundos mediante heartbeat;
- el heartbeat se detiene al terminar el comando;
- el test de regresión comprueba scope de workspace, expiración, heartbeat y limpieza del timer.

La interrupción real durante los deploys quedó observada: un comando permaneció `running` tras el reinicio y fue recuperado por el worker después del umbral de tres minutos. Ese evento sirvió para identificar el problema de lease; no se borró ni se maquilló el resultado histórico.

## 7. Verificación de la ruta pública y arreglo de layout

La prueba nativa `native-codelab-browser-qa-20261106-08` terminó `succeeded` con `browserTest.passed=true`. Después de añadir la comprobación de recarga, la ejecución `native-codelab-browser-qa-20261106-09` también terminó `succeeded` y confirmó la ruta pública desplegada. Ya no prueba solamente `page.setContent`: abre la ruta desplegada `/?projectId=...` en Chromium y carga el workspace ADMIN mediante las claves locales `codelab_xd_workspace_v4` y `codelab_xd_workspace_token_v1` (token HMAC generado dentro del worker; nunca se devuelve al resultado).

Comprobaciones de la ruta real:
- HTTP 200/OK.
- Workspace activo `ws_local_admin`.
- Proyecto abierto con el nombre esperado.
- Vista previa embebida renderizada.
- Botón de la vista previa pulsado y texto `Interacción funcionando ✓`.
- Sin overflow horizontal.
- Iframe de preview conserva `sandbox="allow-scripts allow-forms"`, sin `allow-same-origin`.
- Cero errores inesperados de página/consola.

Los cuatro errores de acceso a `localStorage` del documento sandboxed se clasifican aparte como restricciones esperadas del iframe aislado. No se añadió `allow-same-origin`: hacerlo debilitaría el aislamiento del código de usuario. El resultado conserva esos avisos en `expectedSandboxWarnings`, no los oculta.

La captura de la ruta detectó un bug de estructura HTML: el `<header>` principal de Studio no se cerraba antes de `#mainSplit`. El panel de trabajo terminaba con solo 242 px de alto y quedaba mucho espacio vacío. Se añadió el cierre correcto en `public/index.html` y una regresión que garantiza que el header cierre antes del main. Tras el deploy, Chromium midió:
- `#studioView`: 1440×1000.
- `#mainSplit`: 1440×953.
- `#previewPanel`: 712×906.
- `#previewIframe`: 712×869.

Las capturas finales están en `result.browserTest.routeTest.screenshot.dataBase64` (ruta real), `result.browserTest.viewports[0].screenshot.dataBase64` (HTML escritorio) y `result.browserTest.viewports[1].screenshot.dataBase64` (HTML móvil). Las tres se recuperaron del resultado del buzón y se visualizaron. La ejecución `-09` también recargó la URL pública y volvió a pulsar el botón. Sus cuatro checks fueron verdaderos: `httpOk`, `projectRestored`, `previewRestored` e `interactionWorks`. Tras la recarga, el título fue `QA — Diseño a Web — Native Mailbox`, el encabezado `Diseña. Construye. Publica.` y el estado `Interacción funcionando ✓`. Los checks de ruta completos también quedaron verdaderos: `httpOk`, `adminWorkspaceLoaded`, `projectOpened`, `previewRendered`, `interactionButtonPresent`, `interactionWorks`, `previewSandboxed`, `noHorizontalOverflow`, `reloadRestoresProject` y `noPageErrors`.


### Captura móvil del editor y navegación Código/Preview

La prueba nativa `native-codelab-browser-qa-20261106-11` detectó primero que el editor móvil usa pestañas: al entrar, `#previewPanel` está oculto de forma intencional y la vista previa se abre con `#mobileTabPreview`. La prueba se ajustó para seguir el flujo real: Código → Preview → Código. En el primer screenshot apareció un bug distinto: las acciones de `#webWorkspaceToolbar` se encogían y sus etiquetas se solapaban. No era un fallo de la pestaña Preview.

Se corrigió el toolbar móvil en `public/index.html`: los botones ya no se encogen, mantienen un mínimo de 44×44 px y la barra se desplaza horizontalmente sin ensanchar el documento. La prueba nativa `native-codelab-browser-qa-20261106-12` terminó `succeeded` con `browserTest.passed=true` después del deploy. Checks móviles verdaderos:
- proyecto ADMIN abierto y Studio visible;
- sin overflow horizontal del documento (390 px);
- pestaña Preview táctil (57 px de alto) y cambia al preview correcto;
- pestaña Código devuelve el editor;
- acciones del toolbar con mínimo 44×44 px;
- botones sin solaparse y barra con scroll horizontal en vez de comprimir controles.

La captura final de Código y la captura final de Preview se recuperaron del resultado del buzón y se visualizaron. En la captura de Preview aparece el contenido convertido y el estado `Diseño convertido · listo`. La prueba separada del HTML exportado ya comprueba el click del CTA también en viewport móvil; la ruta/editor móvil ahora comprueba el cambio de pestañas y la presencia real del preview.

## 8. Qué está probado y qué no

### Confirmado por resultados del buzón/DB
- Creación del proyecto en ADMIN.
- Conversión a tipo web.
- HTML guardado en el estado persistido del workspace.
- Tres elementos de diseño preservados.
- Documento HTML, meta viewport, lógica de interacción y persistencia detectados por comprobaciones estructurales del conversor.
- Lectura posterior del proyecto desde el workspace ADMIN.

### Pendiente
- Ampliar los controles de interacción del editor móvil (por ejemplo, ejecutar desde la barra inferior y validar el estado resultante), además de los cambios de pestaña ya probados.
- Si las capturas crecen en volumen, migrar PNG grandes desde JSONB a Neon Object Storage y conservar en la cola solo referencias y metadata.

## 11. Estado de validación del repositorio y límites de alcance

En el commit `9eb38e5`:
- `CodeLab QA and command mailbox`: **success**; el job `code-tests` terminó correctamente.
- `Validate CodeLab`: **failure** en pruebas del subsistema PixelForge, no en el buzón nativo ni en el flujo de conversión.
  - `tests/pixelforge-animation.test.mjs`: 17/18 pasaron; falla la aserción de pantalla de inicio de sesión de PixelForge en la línea 410.
  - `tests/pixelforge-integration.test.js`: la base PostgreSQL efímera del job no tiene inicializada la tabla `codelab_workspace_states`; el servidor aborta antes de ejecutar la integración.
- No se modificó PixelForge para intentar silenciar estos fallos. Quedan registrados como problemas separados y fuera del alcance de esta tarea.

El deploy del servicio CodeLab autorizado quedó **LIVE** para el commit `0475682` (la corrección del toolbar está en `bfa42b5`; la revisión de test en `0475682`). Después del deploy, el comando nativo `native-codelab-browser-qa-20261106-12` terminó **succeeded** con `browserTest.passed=true`, incluida la recarga completa de la URL pública y la navegación móvil Código/Preview/Código.

## 9. Protocolo para continuar sin desviaciones

1. Leer esta bitácora antes de ejecutar trabajo nuevo.
2. Confirmar repo, rama y servicio autorizado; no cambiar otros recursos.
3. Verificar cuenta ADMIN y workspace `ws_local_admin`.
4. Para operaciones de proyecto, insertar el comando permitido en `codelab_agent_commands` y esperar su resultado final. No sustituirlo por GitHub Actions.
5. Tras cada mutación, ejecutar inspección nativa y volver a leer el estado persistido.
6. Para probar comportamiento web, usar Chromium/Playwright sobre el HTML guardado o la ruta pública real. Separar claramente una prueba con `setContent` del test de la URL desplegada.
7. En navegador, comprobar escritorio y móvil, consola/page errors, presencia del contenido, click del CTA y resultado accesible del estado.
8. Si hace falta cambiar código, primero revisar el archivo completo y las pruebas relacionadas; no reemplazar archivos grandes con contenido parcial.
9. Si se cambia el código, Actions puede validar el código fuente. Después comprobar el deploy del único servicio permitido. Finalmente, volver a usar el buzón nativo para probar el proyecto real.
10. Actualizar esta bitácora con comandos, estados, revisiones, commit/deploy y evidencia. Marcar cada resultado como **confirmado**, **fallido** o **pendiente**.

## 10. Próximo bloque de trabajo

**Próxima mejora:** ampliar el test móvil de la aplicación CodeLab en sí (la prueba actual valida el HTML exportado en móvil y la ruta pública/editor en escritorio). Mantener separada la prueba del editor móvil de la prueba responsive del sitio exportado. Después, valorar mover PNG grandes a Object Storage y dejar referencias/metadata en JSONB si el volumen crece.
- cargar el HTML guardado en Chromium;
- esperar DOM listo;
- confirmar título, encabezado y botón;
- pulsar el botón y comprobar el texto de estado;
- repetir con viewport de escritorio y móvil;
- reportar errores de consola y excepciones de página;
- distinguir entre render aislado del HTML (`page.setContent`) y navegación por la URL pública real.

La conversión de prueba ya pasó ambos niveles: render/interacción del HTML y carga de la ruta pública. Para proyectos nuevos, repetir ambos niveles y visualizar las capturas; no basta con afirmar que existen.

---
**Regla de mantenimiento:** esta bitácora prevalece sobre recuerdos informales o explicaciones anteriores cuando describan de forma distinta la arquitectura o los resultados observados. Si algo cambia, corregir este documento con fecha y evidencia; no borrar el historial de decisiones importantes.
