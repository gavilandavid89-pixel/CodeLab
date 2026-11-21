# CodeLab — instrucciones obligatorias para agentes

Antes de trabajar en el repositorio, lee esta entrada y la política completa:
[docs/agent-ai-bridge-policy.md](docs/agent-ai-bridge-policy.md).

## Fuente de verdad operativa

El flujo actual de trabajo es:

`usuario → agente → Neon (trabajo/estado) → bridge/worker → CodeLab → resultado/evidencia → Neon → agente`.

- Neon conserva el estado canónico de órdenes, proyectos, revisiones, resultados y referencias a evidencias.
- El bridge/worker entrega las órdenes a CodeLab; no es un segundo agente y no toma decisiones de producto.
- CodeLab ejecuta operaciones mediante sus interfaces programáticas. No automatices el trabajo principal simulando clics o gestos de la interfaz.
- El agente inspecciona el resultado persistido y la evidencia visual cuando corresponda antes de decidir la siguiente operación.
- La recuperación debe consultar el estado real antes de reintentar. Nunca dupliques una orden que siga activa.

## A/B y workflows históricos

Los workflows A/B (un workflow que alojaba una sesión y otro que se conectaba a ella) pertenecen a una arquitectura anterior. **No forman parte del flujo operativo actual ni son un requisito para ejecutar CodeLab.** Sus archivos pueden permanecer en el repositorio como herramientas históricas/de pruebas; no los invoques como camino normal ni describas su supervisión de 10 minutos como política vigente.

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

## Documentos relacionados

- [Política del agente y bridge](docs/agent-ai-bridge-policy.md)
- [Flujo autónomo de dibujo y animación](docs/ANIMATION-AUTONOMOUS-WORKFLOW.md)
- [Recuperación de expiración de sesión](docs/SESSION-EXPIRATION-RECOVERY.md)
- [Cuenta y persistencia](docs/account-admin-and-persistence-policy.md)
