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

### 4.4 Diagnóstico del primer intento y corrección\n\nEl primer test de navegador falló en Render con `browserContext.newPage: Target page, context or browser has been closed`. Los logs confirmaron que Chromium se lanzó y ejecutó la inyección de `page.setContent`, pero el ciclo que cerraba y recreaba contextos dentro del mismo navegador era frágil con el Chromium empaquetado en modo single-process. Se cambió a un único BrowserContext y una única Page reutilizada para escritorio y móvil, cambiando el viewport entre pasadas. El fallo quedó registrado como fallido; no se sobrescribió como éxito. La corrección requiere repetir el comando nativo para obtener evidencia nueva.\n\n### 4.5 Regresión de código

Se añadió `tests/codelab-native-browser-capture.test.mjs` y se incorporó al job de validación de código en `.github/workflows/codelab-command-bridge.yml`. La ejecución del job para el commit `c6a114a` terminó en verde: 11 tests aprobados, 0 fallos. La corrección posterior del ciclo de contextos también debe validarse en la siguiente ejecución. Actions solo valida sintaxis y pruebas del repositorio; no crea ni ejecuta el proyecto. El test de navegador real se dispara a través del buzón nativo.

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

## 7. Qué está probado y qué no

### Confirmado por resultados del buzón/DB
- Creación del proyecto en ADMIN.
- Conversión a tipo web.
- HTML guardado en el estado persistido del workspace.
- Tres elementos de diseño preservados.
- Documento HTML, meta viewport, lógica de interacción y persistencia detectados por comprobaciones estructurales del conversor.
- Lectura posterior del proyecto desde el workspace ADMIN.

### Pendiente de prueba real de navegador
- Abrir la URL pública del proyecto y confirmar que la ruta carga correctamente.
- Confirmar render visual del HTML convertido.
- Pulsar el botón y observar que el estado cambia a “Interacción funcionando ✓”.
- Repetir en viewport móvil y escritorio; revisar overflow horizontal, dimensiones y errores de consola.
- Verificar que al recargar la ruta el proyecto sigue abriendo con el mismo contenido.

La navegación pública intentada desde el cliente de investigación no pudo completarse (error interno/no accesible). Eso no demuestra que la web esté caída, pero tampoco permite afirmar que la ruta pública funciona. La prueba de navegador sigue pendiente. El worker ya importa `playwright-core` y `@sparticuz/chromium`, pero la acción `codelab_project_inspect` actual solo inspecciona el estado guardado; todavía no ejecuta Chromium sobre el HTML de CodeLab.

## 8. Protocolo para continuar sin desviaciones

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

## 9. Próximo bloque de trabajo

**Prioridad inmediata:** agregar una prueba separada de la ruta pública real del proyecto, con identidad ADMIN y sesión/workspace autenticados. No confundirla con el render aislado ya aprobado. La prueba debe:
- cargar el HTML guardado en Chromium;
- esperar DOM listo;
- confirmar título, encabezado y botón;
- pulsar el botón y comprobar el texto de estado;
- repetir con viewport de escritorio y móvil;
- reportar errores de consola y excepciones de página;
- distinguir entre render aislado del HTML (`page.setContent`) y navegación por la URL pública real.

No declarar “web verificada” hasta completar ambos niveles: render/interacción del HTML y carga de la ruta pública. Las capturas del buzón se deben recuperar desde `result.browserTest.viewports[].screenshot.dataBase64` y visualizar; no basta con afirmar que existen.

---
**Regla de mantenimiento:** esta bitácora prevalece sobre recuerdos informales o explicaciones anteriores cuando describan de forma distinta la arquitectura o los resultados observados. Si algo cambia, corregir este documento con fecha y evidencia; no borrar el historial de decisiones importantes.
