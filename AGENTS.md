# CodeLab — instrucciones obligatorias para agentes

Antes de trabajar en el repositorio, lee esta entrada y la política completa:
[docs/agent-ai-bridge-policy.md](docs/agent-ai-bridge-policy.md).

## Fuente de verdad operativa

El flujo actual de trabajo es:

`usuario → agente → entorno headless del agente → paquete .codelab → Neon → bridge/worker → CodeLab → resultado/evidencia → Neon → agente`.

- El agente trabaja primero en **su propio entorno headless**. Ese headless es independiente del headless/bridge que controla CodeLab.
- Si el entorno del agente no dispone de un headless compatible, puede obtenerlo desde el repositorio; eso no sustituye ni modifica el headless que permite controlar CodeLab.
- Neon conserva el estado canónico de órdenes, proyectos, revisiones, resultados y referencias a evidencias.
- El agente empaqueta el proyecto trabajado y lo transfiere a CodeLab mediante Neon cuando el flujo de entrega lo requiere.
- Si el proyecto necesita inspección dentro de la interfaz real de CodeLab, el agente solicita y recibe la evidencia visual correspondiente; después la inspecciona y decide la siguiente operación.
- La recuperación debe consultar el estado real antes de reintentar. Nunca dupliques una orden que siga activa.

## Reglas de ejecución

1. Solo una petición explícita del usuario inicia una nueva tarea del agente. Los workers pueden completar órdenes ya autorizadas, pero no iniciar nuevas tareas autónomas del agente.
2. Antes de actuar, consulta proyecto, revisión y órdenes activas.
3. Usa `project_id` y la última `server_revision` para continuar proyectos existentes.
4. Trabaja sobre el proyecto en el headless propio del agente y conserva allí el estado editable hasta que corresponda entregarlo.
5. Si CodeLab necesita ser inspeccionado en su interfaz real, solicita la evidencia visual necesaria; no trates esa evidencia como la fuente canónica del proyecto.
6. Inspecciona realmente la evidencia recibida y, según el resultado, continúa trabajando en el headless propio o entrega el proyecto al usuario.
7. No registres secretos, cookies, tokens ni contraseñas.
8. No cambies ni despliegues servicios ajenos al alcance solicitado.
9. No declares que Render/producción fue probado si solo se ejecutaron pruebas locales o CI.

## A/B: uso exclusivo de vídeo

A/B no forma parte del flujo general de CodeLab. Se conserva únicamente como ruta especializada para procesamiento/render/captura de vídeo por el límite de memoria de Render. Para cada trabajo se usa **una sola sesión A y una sola B procesadora**; nunca se lanzan múltiples B en paralelo ni lotes de estrés. Consulta [docs/VIDEO-PROCESSING-AB.md](docs/VIDEO-PROCESSING-AB.md) antes de tocar estos workflows. No inicies A/B para tareas normales de edición, persistencia o importación.

El flujo actual usa el bridge y el estado persistido en Neon, con activación bajo demanda cuando el bridge informa que está dormido. No mantengas pings periódicos, cron de keep-alive ni procesos artificiales para simular actividad.

## Identidad y sesiones locales

- Para operar sobre proyectos del usuario, conserva el contexto de cuenta/workspace que el sistema obtiene mediante la configuración y autenticación existentes del repositorio. No inventes, sustituyas ni hardcodees una identidad.
- Las sesiones locales/headless son útiles como entorno auxiliar aislado para pruebas y automatización. No las elimines por considerarlas cuentas demo.
- Una sesión local aislada no debe confundirse con una sesión autenticada del usuario ni utilizarse para afirmar que un cambio quedó guardado en su workspace real.
- Distingue siempre entre persistencia local, persistencia en Neon/servidor y lectura de vuelta del proyecto del usuario.

## Reglas de ejecución

1. Solo una petición explícita del usuario inicia una nueva tarea del agente. Los workers pueden completar órdenes ya autorizadas, pero no iniciar nuevas tareas autónomas del agente.
2. Antes de actuar, consulta proyecto, revisión y órdenes activas.
3. Usa `project_id` y la última `server_revision` para continuar proyectos existentes.
4. No uses screenshots o vídeos como fuente canónica del proyecto; son evidencia de inspección.
5. En dibujo/animación, genera evidencia visual y revísala realmente. Un `success` no basta.
6. No registres secretos, cookies, tokens ni contraseñas.
7. No cambies ni despliegues servicios ajenos al alcance solicitado.
8. No declares que Render/producción fue probado si solo se ejecutaron pruebas locales o CI.

## Sincronización obligatoria de documentación técnica

Cualquier cambio en conexión PostgreSQL, DATABASE_URL/TLS, pools, endpoint pooled/directo, LISTEN/NOTIFY, triggers, cola, acciones, estados, reconexión, ciclo de vida del worker, API de control, workspace, persistencia, revisiones, evidencia o consumo de datos debe actualizarse **en el mismo PR** en:
- `docs/CodeLab_Neon_comunicacion_extremo_a_extremo.md` (documento técnico de referencia y diagramas);
- `docs/CODELAB-NEON-ARCHITECTURE.md` (resumen de arquitectura);
- `README.md` (resumen operativo y enlace);
- pruebas de contrato correspondientes.

Antes de presentar el cambio al usuario, volver a leer los archivos modificados y comprobar que los diagramas representan el código real. Eliminar o corregir toda descripción obsoleta (por ejemplo, polling retirado, filtros de wake antiguos o rutas que ya no sean el mecanismo normal). Distinguir siempre CI, pruebas locales y producción.

## Documentos relacionados

- [Comunicación CodeLab ↔ Neon de extremo a extremo](docs/CodeLab_Neon_comunicacion_extremo_a_extremo.md)
- [Política del agente y bridge](docs/agent-ai-bridge-policy.md)
- [Flujo autónomo de dibujo y animación](docs/ANIMATION-AUTONOMOUS-WORKFLOW.md)
- [Formato ZIP de PixelForge y Reference Center](docs/PIXELFORGE-PROJECT-PACKAGE.md)
- [Recuperación de expiración de sesión](docs/SESSION-EXPIRATION-RECOVERY.md)
- [Cuenta y persistencia](docs/account-admin-and-persistence-policy.md)
