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

## 4. Qué está probado y qué no

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

## 5. Protocolo para continuar sin desviaciones

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

## 6. Próximo bloque de trabajo

**Prioridad inmediata:** implementar o habilitar una prueba de navegador real para el HTML persistido del proyecto de prueba, idealmente mediante una extensión segura de `codelab_project_inspect` o una acción de QA explícita. La prueba debe:
- cargar el HTML guardado en Chromium;
- esperar DOM listo;
- confirmar título, encabezado y botón;
- pulsar el botón y comprobar el texto de estado;
- repetir con viewport de escritorio y móvil;
- reportar errores de consola y excepciones de página;
- distinguir entre render aislado del HTML (`page.setContent`) y navegación por la URL pública real.

No declarar “web verificada” hasta completar ambos niveles: render/interacción del HTML y carga de la ruta pública.

---
**Regla de mantenimiento:** esta bitácora prevalece sobre recuerdos informales o explicaciones anteriores cuando describan de forma distinta la arquitectura o los resultados observados. Si algo cambia, corregir este documento con fecha y evidencia; no borrar el historial de decisiones importantes.
