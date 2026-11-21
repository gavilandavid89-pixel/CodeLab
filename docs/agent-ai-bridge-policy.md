# Política operativa del agente IA y del bridge de CodeLab

**Estado: vigente.** Esta política describe el flujo actual Neon → bridge/worker → CodeLab. Los workflows A/B descritos en versiones anteriores son históricos y no forman parte de la ejecución normal.

## 1. Arquitectura y responsabilidades

Flujo canónico:

```text
Usuario
  ↓ petición explícita
Agente IA
  ↓ registra/consulta trabajo
Neon (órdenes, estado, proyecto, revisión)
  ↓ bridge/worker
CodeLab (ejecución programática)
  ↓ resultado y, cuando corresponda, evidencia visual
Neon (resultado persistido y referencias)
  ↓
Agente IA (inspección y siguiente decisión)
```

- **Agente IA:** interpreta la petición, decide las operaciones, inspecciona resultados y determina si corresponde corregir o continuar.
- **Neon:** fuente de verdad persistente para órdenes, estado de trabajos, proyectos, revisiones y referencias a evidencias.
- **Bridge/worker:** transporte y consumidor de órdenes. No es un segundo agente y no decide objetivos ni inicia tareas nuevas por su cuenta.
- **CodeLab:** ejecuta operaciones mediante interfaces programáticas.
- **Cloudflare:** facilita el transporte y la transferencia de evidencias cuando está configurado.
- **R2:** almacena artefactos binarios cuando el flujo lo utiliza.

No conviertas commits de GitHub en el transporte de cada modificación de proyecto. GitHub versiona el software; Neon y el bridge transportan los trabajos del flujo actual.

## 2. Inicio, activación y límites

- Solo una petición explícita del usuario puede iniciar una nueva tarea del agente IA.
- Un worker puede terminar una orden que ya fue autorizada, pero un resultado, webhook, cron, error o señal de bridge no debe iniciar por sí solo una nueva ejecución del agente.
- Si el estado persistido indica que el bridge está dormido y requiere activación, usa la operación explícita de ensure/wake documentada por el endpoint actual. Incluye la versión de señal observada cuando el protocolo lo requiera.
- No mantengas el servicio despierto con pings periódicos, bucles de keep-alive o cron artificiales. La activación debe ser bajo demanda.
- No confundas la ventana de supervisión del agente con un timeout del worker. Respeta los límites técnicos reales declarados por la operación; no mates procesos solo porque el agente dejó de esperar o la sesión de conversación se interrumpió.

## 3. Identidad, cuenta y sesiones locales

- Para proyectos del usuario, utiliza el contexto de identidad/workspace que proporciona el sistema mediante la configuración y autenticación existentes. No inventes usuarios ni reemplaces ese contexto con una identidad genérica.
- Las sesiones locales/headless son una herramienta auxiliar válida para ejecutar y probar CodeLab de forma aislada. No deben eliminarse por el mero hecho de ser locales.
- Una sesión local aislada no equivale a la sesión autenticada del usuario. No afirmes que un cambio local quedó persistido en el workspace real sin verificarlo mediante la lectura de vuelta del servidor/Neon.
- Las pruebas aisladas pueden utilizar su propio directorio de datos y fixtures. Deben mantenerse separadas de los proyectos y datos reales del usuario.
- No registres ni expongas credenciales, cookies, tokens o secretos.

## 4. Ciclo de trabajo y recuperación

Antes de enviar una orden:

1. Consulta el estado del bridge y las órdenes recientes.
2. Identifica el proyecto y su última `server_revision`.
3. Comprueba si ya existe una orden equivalente activa.
4. Reutiliza el estado de una orden activa; no la dupliques.
5. Envía la operación con los identificadores de correlación requeridos.

Después de enviarla:

1. Espera el resultado real de esa orden.
2. Comprueba su estado persistido en Neon.
3. Verifica la revisión y los cambios esperados.
4. Si corresponde, recupera e inspecciona la evidencia visual.
5. Decide si el trabajo está terminado o necesita otra operación.

Estados habituales pueden incluir `queued → dispatched → running → rendering → uploading → completed/failed`; usa los estados que realmente devuelva la implementación, no los supongas si el endpoint utiliza otros.

Si la sesión del agente se interrumpe:

- Recupera el snapshot del bridge, la orden, el proyecto y la revisión desde Neon.
- Si la orden sigue activa, continúa consultándola en lugar de crear otra.
- Si terminó, inspecciona resultado/evidencia antes de continuar.
- Si falló, diagnostica el error y reanuda desde la última revisión válida.
- No reconstruyas un proyecto desde memoria, capturas o vídeos.
- No reutilices tokens de propuestas expirados.

Consulta también [SESSION-EXPIRATION-RECOVERY.md](SESSION-EXPIRATION-RECOVERY.md).

## 5. Ejecución programática y verificación visual

- Las modificaciones principales deben utilizar las interfaces programáticas de CodeLab; la UI es para inspección y validación visual, no el mecanismo principal de automatización.
- Una respuesta HTTP exitosa, `success: true`, un workflow verde o una orden aceptada no demuestran por sí solos que el resultado sea correcto.
- Verifica persistencia y lectura de vuelta desde la fuente correspondiente.
- Para dibujo y animación, genera evidencia visual real. Inspecciona continuidad, composición, silueta, movimiento, frames, duración y exportación según el objetivo.
- Las referencias externas sirven para orientar el trabajo; no sustituyen el resultado editable ni el estado real del proyecto.
- Si el resultado es defectuoso, corrige y repite el ciclo sin pedir confirmaciones rutinarias entre pasos.

## 6. Workflows A/B históricos

Los workflows A/B se diseñaron para un entorno anterior: A mantenía una instancia/sesión de la web y B se conectaba a ella para enviar solicitudes. Ese esquema ya no es el flujo operativo vigente.

- No iniciar A/B como requisito para trabajar con CodeLab.
- No aplicar la antigua regla de ventanas independientes de 10 minutos/30 segundos como límite del flujo actual.
- Los workflows y scripts antiguos pueden conservarse para reproducibilidad o pruebas históricas hasta que se decida retirarlos; su presencia en el repositorio no los convierte en la arquitectura actual.
- El flujo vigente es el bridge/worker con coordinación y recuperación persistentes en Neon.

## 7. Principio de cierre

Un trabajo solo se declara terminado cuando el resultado esperado está verificado en el estado persistido y, si el tipo de tarea lo requiere, su evidencia visual fue inspeccionada. Si algo no pudo probarse —por ejemplo, producción/Render— debe indicarse expresamente como no verificado.
