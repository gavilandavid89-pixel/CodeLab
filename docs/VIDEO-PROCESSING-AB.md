# Procesamiento de vídeo con A/B

## Propósito

A/B existe únicamente para procesar, renderizar o capturar vídeo de PixelForge fuera de Render, porque la memoria disponible en Render no es suficiente para ese trabajo. No es el sistema normal de edición de proyectos ni una arquitectura de múltiples agentes.

## Topología: una A + una B

```text
Proyecto / revisión canónica en Neon
          │
          ▼
CodeLab / PixelForge prepara la sesión y el contexto
          │
          ▼
A — una sesión host en GitHub Actions
          ▲
          │ una petición de vídeo
B — un único procesador por trabajo
          │
          ▼
Captura / empaquetado / render del vídeo
          │
          ▼
Evidencia de vídeo → agente inspecciona → resultado
```

- **A (host):** mantiene un navegador temporal de PixelForge, registra el vídeo y atiende la petición de B mediante el buzón de sesión.
- **B (procesador):** envía una única operación de vídeo/animación a A, espera su resultado y verifica que la evidencia se haya generado.
- **Una B por trabajo:** no se lanzan cinco B simultáneas, no se generan lotes concurrentes y no se usa esta infraestructura para pruebas de carga.
- **Neon sigue siendo la fuente de verdad:** A/B no reemplaza el almacenamiento de proyectos, las órdenes ni el bridge/worker normal.

## Workflows

| Workflow | Responsabilidad |
|---|---|
| `.github/workflows/codelab-independent-session-a.yml` | Inicia y mantiene la sesión A para el procesamiento de vídeo. |
| `.github/workflows/codelab-independent-session-b.yml` | Ejecuta una B especializada; los modos admitidos son `walk` y `walk-step`, ambos para animación/captura de vídeo. El grupo de concurrencia evita B simultáneas. |
| `.github/workflows/codelab-ab-animation.yml` | Prueba manual autocontenida con una A temporal y una sola petición B de animación/captura. |
| `.github/workflows/codelab-b-a-context-cycle.yml` | Orquestador alternativo de una sola sesión A y una sola ejecución del procesador B para el ciclo de vídeo/contexto. |

Los tres puntos de entrada de vídeo comparten el grupo GitHub Actions `codelab-video-processor`. Así, aunque se invoque un workflow distinto, solo puede ejecutarse un procesador B a la vez. El antiguo `.github/workflows/codelab-ab-stress.yml` se retiró porque lanzaba cinco B concurrentes, cinco B en modo cola y otras tres B secuenciales. Ese comportamiento no pertenece al diseño del producto y no debe recuperarse.

## Flujo operativo

1. El trabajo normal modifica y persiste el proyecto por el flujo Neon → bridge/worker → CodeLab.
2. Cuando se necesita vídeo, se inicia una sesión A dedicada al proyecto/revisión correspondiente.
3. Se inicia una sola B y se le proporciona el ID de la sesión A.
4. B solicita a A la operación de animación/captura y espera el resultado.
5. Se conserva la evidencia de vídeo como artefacto y/o referencia asociada al evento real.
6. El agente inspecciona el vídeo (no basta con que el workflow termine en `success`).
7. Si hay defectos, se corrige el proyecto mediante el flujo normal y se solicita otra ejecución de vídeo; no se multiplica B.

## Límites y seguridad

- No ejecutar procesamiento pesado de vídeo en el servicio Render.
- No usar A/B para tareas normales de navegador, edición, importación de ZIP o persistencia.
- No iniciar más de una B para el mismo trabajo.
- No convertir el buzón A/B en una segunda cola general.
- No declarar un vídeo correcto sin inspección visual de la evidencia.
- No incluir contraseñas, tokens ni secretos en los inputs, logs o artefactos.

## Pruebas

Las pruebas de contrato y CI validan el código del workflow, pero no demuestran por sí solas que un vídeo real se haya generado correctamente. La aceptación requiere comprobar el artefacto de vídeo, su correspondencia con el proyecto/revisión y su inspección visual.

## Archivos relacionados

- `scripts/codelab-session-host.mjs` — host A y captura Playwright.
- `scripts/codelab-session-request.mjs` — envío de una petición a la sesión A.
- `scripts/codelab-b-a-context-cycle.mjs` — ciclo de animación/captura usado por B.
- `docs/agent-ai-bridge-policy.md` — política general de ejecución y aislamiento.
- `docs/inline-artifact-bridge.md` — transporte de paquetes editables, separado del transporte de vídeo.
