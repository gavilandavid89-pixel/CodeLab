# Documentación de CodeLab — índice operativo

Este índice organiza la documentación por tarea. No reemplaza los contratos técnicos: indica cuál leer, en qué orden y cuál prevalece si dos textos discrepan.

## 1. Orden de autoridad

Si dos documentos se contradicen, aplicar este orden:

1. **AGENTS.md** — reglas obligatorias de sesión, seguridad, identidad, recuperación y alcance.
2. **docs/HEADLESS-AGENT-RUNTIME.md** — cómo obtener, instalar y ejecutar el Headless propio del agente.
3. **docs/agent-ai-bridge-policy.md** — límites entre agente, Headless propio, CodeLab, Neon y worker.
4. **Documento especializado del flujo** — animación, transporte, arquitectura o formato.
5. **README.md y documentos de resumen** — orientación general; no pueden cambiar las reglas anteriores.
6. **Auditorías e informes fechados** — evidencia histórica, no instrucciones actuales salvo incorporación expresa en una política vigente.

Un documento antiguo que contradiga esta jerarquía debe corregirse o marcarse como histórico; nunca se deben combinar procedimientos incompatibles.

## 2. Empezar una tarea

Leer en este orden:

1. [Instrucciones obligatorias](../AGENTS.md)
2. [Política operativa del agente y bridge](agent-ai-bridge-policy.md)
3. [Headless propio: instalación y ejecución](HEADLESS-AGENT-RUNTIME.md)
4. El procedimiento especializado de la tarea.

**Regla mental:** el agente es la IA que recibe la orden. Su entorno Headless es donde trabaja y anima. El Headless/worker de CodeLab es otro sistema, usado para recibir, importar, persistir y verificar el resultado.

## 3. Procedimientos por trabajo

| Necesidad | Documento principal | Qué resuelve |
|---|---|---|
| Crear o editar dibujo/animación | [Flujo autónomo de animación](ANIMATION-AUTONOMOUS-WORKFLOW.md) | Preparación, ejecución, espera, verificación, inspección visual y aceptación. |
| Instalar/ejecutar Headless del agente | [Headless Agent Runtime](HEADLESS-AGENT-RUNTIME.md) | Artefacto real, instalación en entorno local/efímero, ejecución y exportación. |
| Consultar todas las capacidades de Headless | [Referencia completa de Headless](HEADLESS-CAPABILITIES-REFERENCE.md) | Funciones raster, capas, selección, referencias, vector, animación, propuestas, límites, flujos y restricciones. |
| Transferir un proyecto editable | [Bridge inline de artefactos](inline-artifact-bridge.md) | Manifiesto, chunks, SHA-256, commit, importación y lectura de vuelta. |
| Historial de resolución de transferencia | [Informe de transferencia inline (24-11-2026)](INLINE-BRIDGE-TRANSFER-RESOLUTION-2026-11-24.md) | Correcciones aplicadas y evidencia de importación real en ADMIN. |
| Entender órdenes, Neon, LISTEN/NOTIFY y worker | [Arquitectura extremo a extremo](CodeLab_Neon_comunicacion_extremo_a_extremo.md) | Cola durable, activación, ejecución, resultados, revisiones y recuperación. |
| Consultar resumen de arquitectura | [Arquitectura CodeLab–Neon](CODELAB-NEON-ARCHITECTURE.md) | Vista compacta de componentes y límites. |
| Entender los componentes internos de CodeLab | [Arquitectura interna y mapa de componentes](CODELAB-INTERNAL-ARCHITECTURE.md) | Responsabilidades, fronteras, flujos, contratos y estado real de integración. |
| Consultar la API nativa del agente | [Protocolo Headless nativo](native-headless-protocol.md) | Cliente, mailbox, acciones nativas y modo navegador explícito. |
| Procesar/capturar vídeo | [Procesamiento A/B](VIDEO-PROCESSING-AB.md) | Única finalidad de A/B: una sesión A y una B procesadora por trabajo. |
| Alta resolución, almacenamiento y sincronización incremental PixelForge | [Arquitectura de alta resolución y sincronización](PIXELFORGE-HIGH-RESOLUTION-STORAGE-AND-INCREMENTAL-SYNC.md) | Límites verificados, cels por tiles, almacenamiento privado, parches con revisiones y migración segura. |
| Dibujo raster tradicional y migración integral de PixelForge | [Migración raster tradicional](PIXELFORGE-TRADITIONAL-RASTER-MIGRATION.md) | Contrato de compatibilidad para lienzo, herramientas, capas, animación, ZIP, importador/exportador, Headless, CodeLab y vídeo. |
| Comprender el formato PixelForge | [Paquete de proyecto PixelForge](PIXELFORGE-PROJECT-PACKAGE.md) | Estructura editable, frames, capas, cels y Reference Center. |
| Recuperar un ZIP del inbox PixelForge | [Recuperación del ZIP del inbox](PIXELFORGE-INBOX-ZIP-RECOVERY.md) | Reemplazo binario en la misma ruta, verificación SHA, Git Data API, workflow y límites de importación. |
| Incidente y recuperación Neon/PixelForge (24-11-2026) | [Incidente de importación y resolución de Neon](NEON-PIXELFORGE-IMPORT-INCIDENT-2026-11-24.md) | Causa raíz del listener, corrección de allowlist, expiración/reintento seguro y verificación de importación persistida en PixelForge ADMIN. |
| Consultar comandos disponibles | [Catálogo de comandos PixelForge](CODELAB-PIXELFORGE-COMMAND-CATALOG.md) | Contratos, capacidades y límites de operaciones. |
| Recuperar una sesión interrumpida | [Recuperación de sesión](SESSION-EXPIRATION-RECOVERY.md) | Consultar estado persistido, evitar duplicados y reanudar. |
| Identidad ADMIN y persistencia | [Política de cuenta y persistencia](account-admin-and-persistence-policy.md) | Contexto de cuenta/workspace y comprobación de guardado. |\n| Recuperar autenticación/bridge existente | [Recuperación ADMIN y bridge](ADMIN-AUTH-AND-BRIDGE-RECOVERY.md) | Reutilizar la conexión existente, resolver workspace y diagnosticar la capa exacta sin pedir secretos. |
| Operar el bridge UI de GitHub | [Agent Space GitHub Bridge](agent-space-github-bridge.md) | Comandos UI allowlisted, navegador temporal y evidencia. |

## 4. Modelo operativo resumido

### Trabajo creativo

Usuario → agente IA → Headless propio del agente → edición/animación → validación → exportación.

El agente instala y ejecuta el Headless obtenido del artefacto oficial de GitHub Actions dentro de su propio entorno, incluso si es efímero. No delega la edición normal a CI ni a CodeLab.

### Entrega y persistencia

Paquete .codelab → HTTPS inline bridge → staging temporal en Neon → orden durable → worker CodeLab → workspace destino → lectura de vuelta.

El Headless no recibe credenciales de Neon, S3 ni secretos internos. HTTP 202 solo significa que la importación fue encolada. La tarea no está terminada hasta comprobar la importación, la revisión persistida y la reapertura del proyecto.

### Evidencia visual

La evidencia se genera desde el proyecto/CodeLab real cuando corresponde y el agente la inspecciona. El vídeo final A/B es un entregable cuando la petición incluye vídeo; no reemplaza el documento editable persistido. El GIF local solo se entrega si el usuario lo pide expresamente.

### Vídeo A/B

A/B es la etapa integrada de procesamiento/render del vídeo final, después de que el agente haya transferido el proyecto editable y CodeLab lo haya persistido. El agente recupera, inspecciona y entrega el vídeo final al usuario. No se usa para crear ni importar el proyecto editable.

## 5. Documentos de referencia e históricos

- AGENT-WORKING-MODE.md describe el ciclo de feedback entre el agente y su Headless local. No describe una sesión A persistente de CodeLab ni el workflow A/B de vídeo.
- functional-audit-*.md y otros informes fechados son fotografías del estado en una fecha concreta. Antes de actuar, verificar el código y las políticas actuales.
- Los catálogos describen capacidades; no conceden permisos ni sustituyen la política de seguridad.

## 6. Mantener la documentación

Cuando cambie un flujo, actualizar en el mismo cambio el documento técnico que define el contrato, este índice si cambia la ruta de lectura, AGENTS.md si cambia una regla obligatoria, README.md si cambia la orientación principal y las pruebas de contrato que validan el comportamiento.

Evitar duplicar contratos técnicos. Los resúmenes deben enlazar al documento canónico y declarar su alcance.
