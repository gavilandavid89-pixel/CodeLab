# Forma de trabajo del agente

**Estado:** guía operativa vigente para dibujo, pixel art, animación y edición creativa.
**Documento superior:** [AGENTS.md](../AGENTS.md).
**Procedimientos canónicos:** [Headless propio](HEADLESS-AGENT-RUNTIME.md), [flujo autónomo de animación](ANIMATION-AUTONOMOUS-WORKFLOW.md) y [transporte inline](inline-artifact-bridge.md).

## 1. Quién hace qué

- **Usuario:** define el objetivo y autoriza la tarea.
- **Agente IA:** interpreta el objetivo, decide el plan, ejecuta el trabajo creativo, valida la calidad y conduce la entrega.
- **Headless propio del agente:** entorno donde el agente crea y modifica el proyecto. Debe instalarse desde el artefacto oficial de GitHub Actions dentro del entorno de ejecución del agente, aunque sea temporal.
- **CodeLab:** recibe el paquete, valida la transferencia, importa el proyecto en el workspace destino, lo persiste y ofrece la interfaz real para abrirlo e inspeccionarlo.
- **Neon:** conserva el estado durable de órdenes, proyectos, revisiones, resultados y staging de artefactos.
- **Worker de CodeLab:** completa órdenes de importación/trabajo ya autorizadas. No es el agente creativo.

No confundir el Headless propio del agente con el headless/worker que controla CodeLab. Tampoco confundir A/B de vídeo con el entorno Headless del agente.

## 2. Ciclo de trabajo creativo

El ciclo de feedback ocurre principalmente dentro del Headless propio:

Agente → consulta estado del proyecto → modifica → consulta/valida estado real → decide siguiente cambio → modifica → valida.

1. Recuperar el proyecto editable y su revisión válida si se continúa un trabajo existente.
2. Inspeccionar el estado real antes de modificarlo.
3. Crear o editar en el Headless propio del agente.
4. Cuando un cambio depende de un frame/capa/cel anterior, consultar ese estado real en el runtime; no reconstruirlo por memoria.
5. Agrupar operaciones solo si no dependen del resultado intermedio. Si una acción depende de otra, verificar el resultado intermedio antes de continuar.
6. Validar estructura, dimensiones, capas, frames, cels, FPS, duración y loop según el objetivo.
7. Generar una vista previa/evidencia visual y revisarla realmente.
8. Corregir defectos y repetir la validación hasta cumplir el objetivo.

No es obligatorio transferir cada fotograma o cada operación a CodeLab. La edición normal se hace en el Headless propio y la transferencia ocurre cuando existe un paquete coherente que entregar o cuando el flujo de recuperación lo requiere.

## 3. Entrega a CodeLab

Cuando el proyecto esté listo:

1. Exportar el formato nativo .codelab admitido por el bridge.
2. Calcular tamaño y SHA-256 del archivo.
3. Crear el manifiesto de transferencia.
4. Enviar los chunks por HTTPS al inline bridge.
5. Confirmar el commit y esperar la orden de importación.
6. Tratar HTTP 202 únicamente como confirmación de encolado.
7. Esperar el resultado final del worker.
8. Verificar que el proyecto se guardó en el workspace destino correcto.
9. Leer de vuelta y reabrir el proyecto cuando sea posible; comprobar que estructura, píxeles y timeline se conservan.

El procedimiento exacto, endpoints, límites y estados está en [inline-artifact-bridge.md](inline-artifact-bridge.md). No duplicar esos contratos aquí.

## 4. Inspección de CodeLab y evidencia

La inspección de la interfaz real de CodeLab es una fase distinta de la edición creativa:

- Si el objetivo incluye comprobar cómo se ve o funciona el proyecto dentro de CodeLab, solicitar/capturar evidencia de la interfaz real.
- El agente inspecciona la evidencia y decide si debe corregir en su Headless propio y volver a transferir.
- La evidencia visual no sustituye el proyecto editable persistido.
- No afirmar persistencia basándose únicamente en un archivo local, una captura, un vídeo o una respuesta HTTP 202.

## 5. Separación de razonamiento y ejecución

El agente decide qué cambio necesita el proyecto. El runtime Headless confirma qué estado existe y qué operación se aplicó. CodeLab/Neon confirman qué paquete se importó y qué quedó persistido.

Una intención no es una ejecución. Una exportación local no es una importación. Una importación encolada no es persistencia verificada.

## 6. Recuperación y continuidad

Si el entorno Headless es efímero o la sesión termina:
- no afirmar que se siguió trabajando en segundo plano;
- recuperar el estado persistido y las órdenes activas antes de reanudar;
- no duplicar una importación que siga activa;
- reinstalar Headless en el entorno actual si hace falta;
- continuar desde la última revisión válida, no desde screenshots o recuerdos.

Ver [SESSION-EXPIRATION-RECOVERY.md](SESSION-EXPIRATION-RECOVERY.md).

## 7. A/B como etapa integrada de vídeo

A/B no es un sistema aislado ni reemplaza el flujo de creación/persistencia. Cuando la petición incluye un vídeo final, el agente primero persiste el proyecto editable en CodeLab y luego coordina A/B sobre esa revisión. Recupera el archivo de vídeo final, lo reproduce, lo inspecciona y lo entrega al usuario. Consultar [VIDEO-PROCESSING-AB.md](VIDEO-PROCESSING-AB.md).


## 8. Regla de entrega visual

El Headless no se conecta al intermediario: solo exporta el proyecto. El agente recoge el archivo fuera del Headless y completa la transferencia. El GIF local solo se entrega cuando el usuario lo solicita expresamente; de lo contrario, el proyecto editable debe llegar a CodeLab. Si se pidió vídeo, se entrega el vídeo final A/B, no una vista previa GIF.
