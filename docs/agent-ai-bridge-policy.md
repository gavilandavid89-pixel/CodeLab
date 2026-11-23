# Política operativa del agente IA y del bridge de CodeLab

**Estado: vigente.** Esta política describe el flujo actual Neon → bridge/worker → CodeLab. Los workflows A/B descritos en versiones anteriores son históricos y no forman parte de la ejecución normal. Para conexiones, esquema SQL, diagramas y detalles de implementación, consultar [la documentación técnica CodeLab ↔ Neon](CodeLab_Neon_comunicacion_extremo_a_extremo.md).

## 1. Arquitectura y responsabilidades

Flujo canónico:

```text
Usuario
  ↓ petición explícita
Agente IA
  ↓ trabaja en su entorno headless
Headless propio del agente
  ↓ empaqueta proyecto .codelab
Neon
  ↓ bridge/worker
CodeLab
  ↓ proyecto real / interfaz real cuando se requiere inspección
Resultado + evidencia visual solicitada
  ↓
Neon
  ↓
Agente IA inspecciona
  ↓
continúa en su headless propio
  o
entrega el proyecto al usuario
```

- **Agente IA:** trabaja sobre el proyecto en su propio headless, decide cuándo empaquetarlo, transferirlo e inspeccionarlo mediante evidencia y decide si continúa o entrega.
- **Headless propio del agente:** entorno principal de trabajo. Si no existe, puede obtenerse desde el repositorio.
- **Headless/bridge de CodeLab:** componente distinto que permite controlar CodeLab. El headless propio del agente **nunca lo sustituye ni lo modifica**.
- **Neon:** estado canónico de órdenes, proyectos, revisiones, artefactos, resultados y evidencias.
- **CodeLab:** proyecto real e interfaz real donde se entrega el proyecto y, cuando hace falta, se obtiene la evidencia solicitada.
- **Cloudflare/R2:** almacenamiento/transporte de bytes grandes de evidencia cuando está configurado; las órdenes llegan directamente desde Neon a CodeLab por PostgreSQL LISTEN/NOTIFY.

GitHub versiona el software y puede proporcionar el headless del agente; no es el transporte obligatorio de cada cambio visual.

## 2. Inicio, activación y límites

- Solo una petición explícita del usuario puede iniciar una nueva tarea del agente IA.
- Un worker puede terminar una orden que ya fue autorizada, pero un resultado, webhook, cron, error o señal de bridge no debe iniciar por sí solo una nueva ejecución del agente.
- El camino normal de una orden es insertar la fila en Neon con `status='queued'`: el trigger PostgreSQL emite `NOTIFY` y el listener de `server.js` inicia el worker si no existe. No es necesario llamar a ensure para cada orden.
- Si el listener/worker se apagó y se necesita arrancarlo explícitamente, puede usarse `POST /api/agent/bridge/ensure` con el token de control. Esta ruta es un fallback controlado, no el transporte normal de órdenes.
- El worker espera `LISTEN/NOTIFY` cuando no hay órdenes; no mantiene polling de 150 ms, cron ni pings de keep-alive. Si Neon falla al arrancar, el listener del servidor reintenta con backoff y reconcilia órdenes queued al reconectar.
- No confundas la ventana de supervisión del agente con un timeout del worker. Respeta los límites técnicos reales declarados por la operación; no mates procesos solo porque el agente dejó de esperar o la sesión de conversación se interrumpió.

## 3. Identidad y separación de entornos

- Para proyectos del usuario utiliza el workspace que proporciona la autenticación existente.
- El headless del agente y el headless/bridge de CodeLab son componentes distintos.
- Si el agente obtiene su headless desde el repositorio, eso solo proporciona su entorno de trabajo y **no reemplaza** el mecanismo que controla CodeLab.
- Una sesión local aislada no demuestra persistencia en el workspace real.
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

## 5. Trabajo en headless propio e inspección real

- El trabajo principal se realiza en el **headless propio del agente**.
- Si el agente no tiene ese headless, puede obtenerlo desde el repositorio.
- Obtenerlo desde el repositorio **no significa reemplazar** el headless/bridge que controla CodeLab. Son dos componentes diferentes.
- El agente empaqueta el proyecto trabajado en `.codelab` y lo sube/entrega a CodeLab a través de Neon cuando corresponde.
- Si el agente no puede continuar sin inspeccionar el proyecto real en una interfaz real, debe solicitar la evidencia visual que necesite.
- La evidencia debe corresponder al proyecto real y a la inspección solicitada.
- El agente debe inspeccionarla realmente antes de decidir.
- Tras inspeccionarla, puede continuar trabajando en su headless propio, corregir y volver a empaquetar, o entregar el proyecto al usuario.
- La evidencia visual es evidencia de inspección; no sustituye al proyecto editable ni se convierte en la fuente canónica del proyecto.

## 6. Workflows A/B: históricos para el flujo general y reservados permanentemente para vídeo

Los workflows A/B se diseñaron para un entorno anterior: A mantenía una instancia/sesión de la web y B se conectaba a ella para enviar solicitudes. **No son el flujo general de ejecución de CodeLab.**

### 6.1 Flujo normal

- No iniciar A/B como requisito para trabajar con CodeLab.
- El flujo normal de proyectos es **Headless propio del agente → `.codelab` → Neon → bridge/worker → CodeLab**.
- No aplicar la antigua regla de ventanas independientes de 10 minutos/30 segundos como límite del flujo actual.
- Los workflows y scripts antiguos pueden conservarse para reproducibilidad o pruebas históricas.

### 6.2 Regla permanente: empaquetado/render de vídeo mediante A/B

**A/B se utilizará siempre y exclusivamente para el empaquetador/renderizador de vídeo.** Esto no es un fallback ocasional ni una medida que se active únicamente cuando Render falle.

La razón operativa es estructural: **el entorno Render de CodeLab dispone de poca memoria para el procesamiento de vídeo y ese límite hace que el empaquetado/render de vídeo falle de forma recurrente.** Por ese motivo, el empaquetador de vídeo queda separado permanentemente del procesamiento normal de CodeLab y se ejecuta mediante A/B.

```text
Headless propio del agente
        ↓
proyecto .codelab
        ↓
Neon / orden canónica
        ↓
CodeLab / sesión necesaria
        ↓
workflow A/B de vídeo (siempre, solo empaquetador)
        ↓
PixelForge + Video Composer
        ↓
WebM/MP4 + evidencia
        ↓
Neon
        ↓
Agente inspecciona visualmente
```

Reglas:

- A/B **no sustituye** Neon como fuente de verdad.
- A/B **no sustituye** el bridge/worker para operaciones normales.
- A/B **no se convierte** en una segunda cola general de comandos.
- A/B queda reservado **permanentemente** al empaquetado/render de vídeo.
- Render no debe utilizarse como ruta del empaquetador de vídeo; su baja memoria hace que ese procesamiento falle de forma recurrente.
- El uso de A/B para vídeo no depende de que una ejecución concreta de Render haya fallado: **la ruta A/B es la ruta establecida por diseño para todo empaquetado/render de vídeo.**
- El vídeo debe corresponder al proyecto/revisión reales y regresar como evidencia asociada a la orden.
- El agente debe abrir/analizar la evidencia antes de declarar correcta la animación.
- Si la evidencia muestra movimiento incorrecto, frames faltantes, composición incorrecta u otro defecto, el agente vuelve a su Headless propio, corrige y repite el ciclo.

La documentación debe distinguir siempre **A/B histórico como arquitectura general** de **A/B reservado permanentemente como vía especializada y obligatoria del empaquetador de vídeo**.

## 6.3 Ciclo de animación: Headless + Xvfb + vídeo real + corrección

Para animaciones, el ciclo operativo es iterativo y debe ejecutarse sobre el proyecto real. **Xvfb es el display virtual del entorno de ejecución cuando el Headless necesita un navegador/display; no es un sustituto del Headless ni de la inspección real.**

```text
Referencia / proyecto inicial
        ↓
Headless propio del agente
        ↓
Xvfb (display virtual, si el runtime lo requiere)
        ↓
PixelForge Headless: crear/ajustar timeline
        ↓
validar timeline (FPS, frames, duración, cels)
        ↓
.codelab
        ↓
Neon (proyecto + orden + revisión)
        ↓
CodeLab / sesión real
        ↓
A/B de vídeo (siempre y exclusivamente para vídeo)
        ↓
PixelForge + Video Composer
        ↓
WebM/MP4 + evidencia visual
        ↓
Neon
        ↓
Agente inspecciona el vídeo real
        ↓
¿Movimiento/frames/composición correctos?
      ↙                         ↘
    NO                           SÍ
     ↓                            ↓
Headless propio                  cerrar ciclo
     ↓                            ↓
corregir timeline                entregar resultado
     ↓
repetir desde validación
```

Reglas específicas:

- El objetivo de cada iteración es producir una animación real en el proyecto editable; un vídeo generado localmente fuera de este circuito **no cuenta como evidencia del ciclo**.
- Xvfb solo aporta el display virtual necesario para ejecutar componentes que dependen de una pantalla/navegador. El trabajo de edición y la lógica de animación siguen perteneciendo al Headless propio del agente.
- La animación se valida primero en el estado del proyecto (timeline, FPS, número de frames, duración y cels) y después mediante el vídeo real.
- Para el objetivo de referencia de este proyecto, **120 frames a 12 FPS = 10 segundos**, siempre que el proyecto y el render mantengan esos valores.
- El vídeo debe generarse mediante la ruta A/B obligatoria de vídeo y corresponder a la revisión real enviada a Neon.
- La inspección visual del WebM/MP4 forma parte de la verificación: comprobar movimiento, continuidad entre frames, composición, duración/FPS y defectos visibles.
- Si el vídeo no demuestra una animación correcta, **no se entrega**: se vuelve al Headless propio, se corrige el timeline y se repite el ciclo.
- No presentar un harness local, una animación simulada o un vídeo de prueba como si fuera resultado del Headless real.
- El ciclo termina solo cuando la revisión del proyecto y la evidencia de vídeo corresponden entre sí y el resultado esperado queda verificado.

## 7. Principio de cierre

Un trabajo se declara terminado cuando el proyecto y el resultado esperado están verificados según el objetivo. Si requirió inspección del proyecto real, la evidencia solicitada debe haber sido inspeccionada. Si necesita correcciones, el agente continúa en su headless propio; si está listo, entrega el proyecto al usuario. Si algo no pudo probarse, debe indicarse expresamente como no verificado.
