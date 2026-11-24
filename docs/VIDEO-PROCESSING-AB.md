# Procesamiento de vídeo con A/B — etapa integrada de entrega

## Propósito y lugar en el flujo

A/B es la infraestructura especializada que produce el **archivo de vídeo final** cuando una tarea requiere renderizar/capturar vídeo fuera de Render, debido al límite de memoria disponible allí.

**A/B no es un sistema aislado ni un producto independiente para el usuario.** Es una etapa posterior del mismo trabajo que el usuario pidió. El agente es responsable de orquestar la tarea completa y entregar el vídeo final, no solo una evidencia técnica.

A/B no reemplaza el Headless propio del agente, el intermediario HTTPS ni Neon/worker/CodeLab. El proyecto editable se crea en Headless, el agente lo transfiere a CodeLab y CodeLab lo importa/persiste. A/B procesa después la revisión real persistida.

## Flujo completo del trabajo con vídeo

```text
Usuario solicita proyecto/animación y vídeo final
                  │
                  ▼
Agente IA → Headless propio aislado
                  │
                  └─ crea/edita y exporta .codelab
                              │
                              ▼
Agente IA (fuera de Headless)
                  │
                  └─ recoge el archivo y lo transfiere al intermediario HTTPS
                              │
                              ▼
CodeLab / Neon staging / worker
                  │
                  └─ importa y persiste proyecto + revisión
                              │
                              ▼
Agente IA coordina A/B para esa revisión
                  │
                  ▼
A — una sesión host en GitHub Actions
                  ▲
                  │ petición de procesamiento de vídeo
B — un único procesador por trabajo
                  │
                  ▼
Render / captura / codificación de vídeo final
                  │
                  ▼
Artefacto de vídeo final recuperable
                  │
                  ▼
Agente IA recupera, reproduce e inspecciona el vídeo
                  │
                  ▼
Usuario recibe el vídeo final y el proyecto editable persistido
```

La tarea no termina al crear la animación, persistir el proyecto, iniciar A/B ni producir un event_id. Cuando el usuario pidió vídeo, el agente debe recuperar el **archivo final de vídeo**, comprobar que se puede abrir/reproducir, inspeccionarlo visualmente y entregarlo al usuario.

## Topología: una A + una B

- **A (host):** mantiene un navegador temporal de PixelForge, registra el vídeo y atiende la petición de B mediante el buzón de sesión.
- **B (procesador):** envía una única operación de vídeo/animación a A, espera su resultado y comprueba que el archivo de vídeo final se haya generado.
- **Una B por trabajo:** no se lanzan cinco B simultáneas, no se generan lotes concurrentes y no se usa esta infraestructura para pruebas de carga.
- **Neon sigue siendo la fuente de verdad del proyecto:** A/B procesa una revisión identificada y no sustituye almacenamiento, órdenes ni bridge/worker.

## Workflows

| Workflow | Responsabilidad |
|---|---|
| `.github/workflows/codelab-independent-session-a.yml` | Inicia y mantiene la sesión A para el procesamiento de vídeo. |
| `.github/workflows/codelab-independent-session-b.yml` | Ejecuta una B especializada; los modos admitidos son `walk` y `walk-step`. El grupo de concurrencia evita B simultáneas. |
| `.github/workflows/codelab-ab-animation.yml` | Prueba manual autocontenida con una A temporal y una sola petición B de animación/captura. |
| `.github/workflows/codelab-b-a-context-cycle.yml` | Orquestador alternativo de una sola sesión A y una sola ejecución del procesador B. |
| `.github/workflows/inspect-black-video.yml` | Inspección manual posterior de un evento de evidencia de vídeo existente; requiere su `event_id`. |

Los puntos de entrada comparten el grupo GitHub Actions `codelab-video-processor`, para permitir una sola B a la vez. La inspección manual de un evento no sustituye la recuperación ni la entrega del archivo final. El workflow duplicado `inspect-black-video-force.yml` se retiró.

**Dónde queda el vídeo según los workflows actuales:** la sesión A configura la grabación de Chromium en `scripts/codelab-session-host.mjs` (contexto Playwright con `recordVideo`, 1440×960 a 24 FPS) y al cerrar la sesión finaliza el archivo. `.github/workflows/codelab-independent-session-a.yml` sube el directorio como artefacto `codelab-independent-a-{run_id}`. La prueba autocontenida `.github/workflows/codelab-ab-animation.yml` sube `codelab-ab-animation-evidence`. La B publica un resumen de verificación en el issue; no debe confundirse ese comentario con el archivo de vídeo. El agente debe descargar el artefacto de vídeo de la ejecución A correspondiente y recuperar el archivo de vídeo real.

El antiguo `.github/workflows/codelab-ab-stress.yml` se retiró porque lanzaba múltiples B concurrentes. No debe recuperarse.

## Flujo operativo obligatorio

1. El agente crea/edita la animación en su Headless propio aislado.
2. Headless exporta el proyecto nativo y termina su participación. **No se conecta al intermediario.**
3. El agente, fuera de Headless, recoge el archivo y lo transfiere mediante el intermediario HTTPS inline.
4. El agente espera la importación, verifica el workspace destino y confirma la revisión persistida.
5. El agente inicia una sesión A para esa revisión y una única B procesadora.
6. B solicita a A la operación de render/captura/codificación y espera el resultado.
7. La sesión A debe cerrar/finalizar la grabación y publicar el artefacto de vídeo asociado a esa ejecución. En el flujo persistente, recuperar `codelab-independent-a-{run_id}`; en la prueba autocontenida, recuperar `codelab-ab-animation-evidence`. La B puede publicar un resumen de estado, pero ese resumen no es el vídeo.
8. El agente recupera el archivo, comprueba formato/tamaño, que se puede abrir y reproducir, y que corresponde al proyecto/revisión esperados.
9. El agente inspecciona visualmente el vídeo completo o una muestra suficiente para detectar pantalla negra, cortes, frames ausentes, corrupción, movimiento incorrecto o problemas de duración.
10. Si hay defectos, el agente vuelve al proyecto editable, corrige en Headless, exporta y transfiere una nueva revisión; después repite A/B.
11. Si todo es correcto, el agente entrega al usuario el vídeo final y el proyecto editable persistido en CodeLab.

## Inspección de requisitos y ciclo de corrección obligatorio

La inspección no consiste únicamente en comprobar que el MP4/WebM existe y se reproduce. El agente debe evaluar si **el contenido del vídeo cumple la petición concreta del usuario**. Antes de darlo por válido:

1. Volver a leer los requisitos originales y convertirlos en una lista de criterios verificables (sujeto/escena, acciones, orden, apariencia, movimiento, continuidad, duración, ritmo, encuadre, resolución y formato, según corresponda).
2. Reproducir e inspeccionar visualmente el vídeo final, de principio a fin cuando su duración lo permita. Revisar también frames individuales o puntos de transición si hay dudas.
3. Comparar el resultado con cada criterio y detectar omisiones, errores visuales, movimientos imposibles, elementos incoherentes o sin sentido, cortes, frames repetidos/ausentes, deformaciones, timing incorrecto y cualquier discrepancia con lo pedido.
4. Si un criterio falla, **retener la entrega**. Identificar el origen del defecto y corregir el proyecto editable existente con Headless.
5. Priorizar una reparación incremental: reabrir la última revisión válida en Headless y modificar solo las capas, frames, cels, objetos, parámetros o segmentos afectados. Conservar el trabajo correcto y la estructura existente; no descartar el proyecto ni regenerarlo completo sin necesidad.
6. Validar en Headless la corrección y exportar una nueva revisión nativa. El agente, fuera de Headless, la transfiere al bridge y verifica que quedó persistida en CodeLab.
7. Ejecutar de nuevo A/B sobre esa nueva revisión, recuperar el nuevo archivo final y repetir la inspección de requisitos. No reutilizar como entrega el vídeo anterior a la corrección.
8. Entregar únicamente cuando todos los criterios aplicables estén satisfechos. Si una limitación real impide corregir o verificar, explicar exactamente qué queda pendiente y no presentar el vídeo como terminado.

Headless permite editar el proyecto existente; por tanto, **un defecto no implica empezar de cero**. La reconstrucción completa queda como último recurso, cuando la reparación incremental no sea viable, o cuando el usuario la solicite expresamente.

## Qué recibe el usuario

- **Siempre:** el proyecto editable persistido en CodeLab, con confirmación de que se importó y se pudo leer de vuelta.
- **Cuando pidió vídeo:** el archivo de vídeo final producido por A/B, no solamente un enlace a logs, un event_id, una captura o el estado success.
- **GIF local:** solo se entrega si el usuario lo pidió expresamente. Un GIF local no sustituye el proyecto editable ni el vídeo final solicitado.

Si el entorno de ejecución no permite recuperar el artefacto o el archivo de vídeo final, el agente debe declarar el bloqueo y no afirmar que entregó el vídeo. No basta con enlazar el run de GitHub ni el comentario de resultado de B.

## Límites y seguridad

- No ejecutar procesamiento pesado de vídeo en el servicio Render.
- No usar A/B para tareas normales de navegador, edición, importación de ZIP o persistencia.
- No iniciar más de una B para el mismo trabajo.
- No convertir el buzón A/B en una segunda cola general.
- No declarar un vídeo correcto sin inspección visual del archivo final.
- No incluir contraseñas, tokens ni secretos en inputs, logs o artefactos.
- No pasar credenciales del intermediario ni de Neon al Headless del agente.

## Pruebas y aceptación

Las pruebas de contrato/CI validan el código de los workflows, pero no demuestran por sí solas que un vídeo real se haya generado y entregado. La aceptación real exige archivo de vídeo final presente y recuperable, correspondencia con proyecto/revisión, reproducción comprobada, inspección visual y entrega al usuario.

## Archivos relacionados

- `scripts/codelab-session-host.mjs` — host A y captura Playwright.
- `scripts/codelab-session-request.mjs` — envío de una petición a la sesión A.
- `scripts/codelab-b-a-context-cycle.mjs` — ciclo de animación/captura usado por B.
- `docs/agent-ai-bridge-policy.md` — política general de ejecución, aislamiento y entrega.
- `docs/inline-artifact-bridge.md` — transporte del proyecto editable; separado del archivo de vídeo final.
