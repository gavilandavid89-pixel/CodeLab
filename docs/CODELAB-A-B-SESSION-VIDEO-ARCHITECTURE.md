# CodeLab A/B — ADMIN Soldier Walk y Video Composer

**Contrato vigente:** A genera el vídeo con el Video Composer real. B solo solicita el trabajo a A, recibe el WebM, lo verifica y termina. A sigue vivo hasta su propio timeout, independientemente de B.

## Responsabilidades

### A — sesión persistente y generador

A es el único proceso autorizado para acceder a la sesión ADMIN y generar el vídeo.

1. Usa CODELAB_AGENT_BRIDGE_CONTROL_SECRET, disponible solo en el workflow A, para leer el snapshot del proyecto desde el bridge ADMIN.
2. Fija project_id, workspace_id, serverRevision y contentSha256; no sustituye el proyecto por una demo ni por una copia local.
3. Obtiene un handoff ADMIN de un solo uso y abre el proyecto real en PixelForge.
4. Mantiene abiertas la sesión ADMIN de PixelForge y la página real de Video Composer en un contexto Chromium persistente.
5. Cuando recibe una solicitud de B, ejecuta exportPixelForgeAnimationVideo dentro de ese contexto, usando el proyecto fijado y persist_evidence:false para devolver el archivo a B sin entregar credenciales.
6. Envía el WebM a B en bloques de base64, junto con SHA-256 y metadatos de la exportación.
7. Continúa atendiendo solicitudes y mantiene su sesión hasta CODELAB_SESSION_MINUTES, aunque B ya haya terminado.

A no recibe DATABASE_URL, claves de Neon ni claves de S3. El bridge token solo está en A. El handoff ADMIN es de un solo uso y no se comparte con B.

### B — solicitante y verificador

B no genera ni codifica animaciones.

1. Descubre o recibe el ID de una sesión A que ya está READY.
2. Envía a A una solicitud con el ID del proyecto y la revisión/hash fijados por A.
3. Recibe los bloques de vídeo, reconstruye el WebM y comprueba el SHA-256, tamaño y cabecera EBML.
4. Abre el archivo en Chromium y verifica que el navegador pueda decodificarlo, leer duración y dimensiones, y buscar varios puntos del vídeo.
5. Guarda el WebM y verification.json como artefacto de GitHub Actions.
6. Publica el resultado y termina inmediatamente; no espera a que A expire.

B no recibe ni usa CODELAB_AGENT_BRIDGE_CONTROL_SECRET, DATABASE_URL, Neon, S3, R2, cookies ADMIN ni tickets de handoff. B no importa exportPixelForgeAnimationVideo, no usa FFmpeg y no construye fotogramas.

## Transporte A → B

El buzón es el issue 492 del repositorio. A publica un comentario [CodeLab A Ready], B publica [CodeLab B Request], y A devuelve comentarios [CodeLab A Video Chunk] y [CodeLab A Export Result]. Los bloques están limitados a 30.000 caracteres para mantenerse por debajo del límite de comentarios de GitHub. B los reúne por sessionId y requestId y valida el hash antes de escribir el archivo.

## Workflows

| Workflow | Función |
|---|---|
| .github/workflows/codelab-independent-session-a.yml | Arranca A con el bridge secreto y mantiene la sesión hasta su timeout. |
| .github/workflows/codelab-independent-session-b.yml | B solicita la exportación, recibe el archivo, lo verifica y termina. No contiene secretos de bridge/Neon. |
| .github/workflows/codelab-ab-animation.yml | Prueba integrada: despacha A como workflow separado, ejecuta B y comprueba que A siga in_progress después de que B termina. |
| .github/workflows/codelab-b-a-context-cycle.yml | Alias heredado que ahora despacha la prueba A/B real; ya no ejecuta el generador demo. |

A puede durar hasta 360 minutos; B tiene su propio límite de espera. La concurrencia de B evita dos procesadores simultáneos.

## Bridge ADMIN

El servidor expone dos operaciones protegidas por CODELAB_AGENT_BRIDGE_CONTROL_SECRET:

- POST /api/agent/bridge/admin-handoff: emite un ticket ADMIN de un solo uso y de corta duración.
- GET /api/agent/bridge/pixelforge/projects/:projectId: devuelve el snapshot completo y metadatos del proyecto dentro del workspace ADMIN.

Ambas operaciones comprueban el bridge token en el servidor. El snapshot se limita a ws_local_admin. B no conoce estas rutas ni recibe el token. El ticket se consume en GET /api/auth/native-handoff y se convierte en una cookie normal del navegador A.

## Proyecto fijado

- Proyecto: PixelForge — Soldier Walk.
- ID: soldier-walk-60f-20261124 (el identificador histórico contiene “60f”; el proyecto persistido tiene 20 fotogramas).
- Workspace: ws_local_admin.
- Revisión documentada: 2.
- Timeline documentado: 20 fotogramas, 12 FPS, 4 capas.
- Hash de contenido documentado: 82db7ee3d5195063fdff109f7e0ad7a30089a8c907e7387e81d13b1742e8b67f.

A fija la revisión y el hash al iniciar. Si el proyecto cambia, una sesión A nueva debe leer y fijar la nueva revisión; no se permite mezclar fotogramas de revisiones distintas.


## Recorrido completo de la implementación y prueba A/B

**Tiempo empleado:** aproximadamente **41 minutos seguidos** en esta sesión de implementación, diagnóstico, corrección, ejecución y verificación.

### 1. Punto de partida

El primer flujo de animación ya había demostrado que el pipeline podía producir un vídeo, pero esa prueba no era suficiente para el objetivo final: el vídeo tenía que salir del proyecto **ADMIN Soldier Walk** persistido y pasar por el **Video Composer real**, sin que B construyera una animación alternativa.

Se revisaron los workflows, scripts y rutas del servidor para identificar qué estaba ocurriendo realmente en A y B.

### 2. Diagnóstico del flujo existente

Se comprobó que el flujo anterior todavía tenía varios elementos que no correspondían al diseño final:

- A arrancaba un servidor local en modo guest/aislado en lugar de restaurar directamente el proyecto ADMIN persistido.
- B conservaba rutas de generación/demo de animaciones de prueba.
- El workflow A/B podía terminar en una animación procedural de demostración en lugar del Soldier Walk real.
- El workflow integrado no garantizaba inicialmente que B utilizara exclusivamente el vídeo producido por A.
- También se detectó que el buzón de comentarios de GitHub podía leer mensajes de sesiones anteriores y mezclar READY/REQUEST/CHUNK de distintas ejecuciones.

Por eso no se aceptó como válida ninguna prueba basada únicamente en un run verde o en un vídeo de demo.

### 3. Restauración del proyecto ADMIN

Se fijó como fuente de verdad el proyecto persistido:

- **Proyecto:** PixelForge — Soldier Walk.
- **ID:** soldier-walk-60f-20261124.
- **Workspace:** ws_local_admin.
- **Revisión:** 2.
- **Contenido:** 20 fotogramas, 12 FPS, 4 capas.
- **Content SHA-256:** 82db7ee3d5195063fdff109f7e0ad7a30089a8c907e7387e81d13b1742e8b67f.

A quedó como único proceso con acceso al bridge ADMIN. B no recibe credenciales de Neon, S3, R2, DATABASE_URL ni el secreto del bridge.

### 4. Correcciones del servidor y de los workflows

Durante la implementación se detectó y corrigió un bloque de ruta duplicado/incorrecto en `server.js`. También se corrigió el cálculo del timeout de B para no depender de una expresión de GitHub Actions no soportada por el workflow.

Después se corrigió el aislamiento del buzón:

- A publica READY con la marca temporal de su propia sesión.
- B busca únicamente READY de una sesión A que siga activa.
- B utiliza la marca temporal de READY para no consumir mensajes viejos.
- La REQUEST de B tiene su propia marca temporal.
- Los CHUNK y resultados se asocian por `sessionId` y `requestId`.
- Se eliminó la dependencia de una ejecución vieja que podía quedar bloqueando el flujo.

También se añadieron comprobaciones de contrato para que futuras modificaciones no vuelvan a introducir ese cruce entre sesiones.

### 5. Ejecución de A

A inició una sesión persistente con el proyecto ADMIN fijado.

A abrió PixelForge y el contexto real del Video Composer. Cuando B solicitó la exportación, A ejecutó el exportador real del Composer sobre la revisión fijada.

El resultado fue:

- 20 fotogramas.
- 12 FPS.
- WebM de 115.027 bytes.
- SHA-256 del vídeo: 0abf2c19450625de90731b86740858859178ca57ca3120e6a17b3d47bcbec82f.

A envió el archivo a B en bloques.

### 6. Ejecución de B

B no generó la animación.

B:

1. Descubrió una sesión A READY activa.
2. Envió la REQUEST con el proyecto y revisión fijados.
3. Recibió los 6 bloques del WebM.
4. Reconstruyó el archivo.
5. Comprobó tamaño y SHA-256.
6. Abrió el WebM con Chromium.
7. Comprobó resolución 1080 × 1350, `readyState=4` y 5/5 muestras temporales decodificables.
8. Guardó el vídeo y `verification.json` como artefactos.
9. Terminó.

B no ejecutó FFmpeg, no construyó fotogramas y no tuvo acceso a las credenciales ADMIN.

### 7. Comprobación de independencia A/B

La prueba integrada confirmó que B podía terminar después de verificar el WebM sin matar ni cerrar A.

El paso **“Verify A remains alive after B has finished”** terminó correctamente. A permaneció `in_progress` y continuó hasta su propio timeout.

Además, se ejecutó posteriormente el workflow B independiente y volvió a completar correctamente la recepción y verificación del WebM.

### 8. Estado real del vídeo entregado

**Importante:** el vídeo entregado al usuario en esta etapa **no fue previamente analizado visualmente ni pulido**.

La verificación realizada hasta este punto demuestra que el archivo:

- procede del proyecto ADMIN correcto;
- fue exportado por el Video Composer real;
- llegó completo de A a B;
- conserva el SHA-256 esperado;
- puede ser decodificado por Chromium;
- tiene los metadatos técnicos esperados.

Pero **todavía no se hizo el análisis visual del movimiento fotograma por fotograma ni una revisión artística/funcional de la calidad de la caminata**.

Por lo tanto, el vídeo entregado debe considerarse **una primera exportación funcional sin pulir**, no una versión final aprobada visualmente.

Queda pendiente revisar visualmente la animación para detectar, entre otras cosas, continuidad de poses, desplazamiento de piernas y brazos, estabilidad del cuerpo, timing, saltos entre fotogramas y cualquier defecto que requiera ajustar el proyecto ADMIN y volver a exportar.

La prueba A/B certifica el **recorrido técnico A → Composer → WebM → B → verificación**, pero no certifica todavía la calidad visual final del Soldier Walk.

### 9. Conclusión de esta sesión

En aproximadamente **41 minutos seguidos** se pasó de un flujo que todavía podía utilizar demos y mezclar sesiones a un recorrido A/B funcional y verificable sobre el proyecto ADMIN real.

El vídeo fue entregado como evidencia de que el pipeline técnico funciona, pero **queda expresamente pendiente el análisis visual y el pulido de la animación antes de considerarlo un vídeo final**.

## Evidencia y estado

Se ejecutó previamente una exportación real mediante el worker nativo de Render y pixelforge-video-composer-export.mjs:
- Composer importó 20 fotogramas a 12 FPS.
- WebM generado: 115.027 bytes.
- Sin errores de página ni de consola.
- El archivo se guardó como evidencia en Neon y se pudo decodificar para extraer muestras.

La prueba integrada A/B se ejecutó el 2026-11-24 y pasó:

- Workflow A/B: [run 45363044941](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45363044941).
- Sesión A independiente: [run 45363094490](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45363094490).
- Workflow B independiente: [run 45364091746](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45364091746), completado con éxito; [artefacto B](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45364091746/artifacts/14906281619).
- Artefacto B: [descargar codelab-soldier-walk-webm-45363044941](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45363044941/artifacts/14904893307).
- Proyecto ADMIN: revisión 2, hash 82db7ee3d5195063fdff109f7e0ad7a30089a8c907e7387e81d13b1742e8b67f.
- Composer importó 20 fotogramas a 12 FPS; generó un WebM de 115.027 bytes y 1,66 s.
- B verificó SHA-256 0abf2c19450625de90731b86740858859178ca57ca3120e6a17b3d47bcbec82f.
- Chromium decodificó 1080 × 1350, readyState 4 y 5 de 5 muestras temporales.
- A no reportó errores de página ni de consola. B no ejecutó FFmpeg ni el generador.
- El paso “Verify A remains alive after B has finished” terminó correctamente. La sesión A seguía in_progress al comprobarla a las 09:14 UTC y tenía expiración prevista a las 09:43:35 UTC.

La aceptación integrada A/B está superada. El artefacto de B contiene el WebM recibido y verification.json. A permanece activa por su propio timeout; su estado no depende de que B haya terminado.

No se considera válido un createDemo, una grabación de pantalla de la sesión, un event ID aislado o un resultado success sin el WebM real.


### Estado posterior al pulido visual — 24/11/2026

Tras la primera exportación funcional, se aplicó un pulido sobre el proyecto ADMIN persistido `PixelForge — Soldier Walk` sin sustituirlo por una animación demo ni reconstruirlo fuera de PixelForge.

- Proyecto: `soldier-walk-60f-20261124`
- Revisión anterior: 2
- Revisión persistida tras el pulido: **3**
- SHA anterior: `82db7ee3d5195063fdff109f7e0ad7a30089a8c907e7387e81d13b1742e8b67f`
- SHA nuevo: `2ec67accd9118efdbfee7687c83b38247b3c2297b04bdb2583c18afe7226b17e`
- Timeline conservado: **20 fotogramas, 12 FPS**
- Se reforzó principalmente el movimiento secundario de peso/acompañamiento mediante cels de la capa persistida `Soldier · reference-guided`.
- No se desplazaron las capas de fondo, suelo ni iluminación.
- No se aumentó artificialmente el número de fotogramas: los 20 originales ya forman el ciclo persistente y añadir duplicados no aportaba movimiento real.

La nueva prueba A/B integrada fue la run **45371383143**:

urlGitHub Actions — A/B pulido 45371383143https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45371383143

Resultado técnico de la nueva exportación:

- A cargó la revisión persistida **3**.
- B recibió el vídeo del Composer real.
- WebM: 142,552 bytes.
- Duración: ~1.66 s.
- Resolución decodificada: 1080×1350.
- Chromium verificó 5/5 muestras.
- SHA256 del vídeo: `5ae6f902698af48d034781518b9051881d38eb482b8a912f64b07cc6f5e4fa4a`.
- B no ejecutó FFmpeg ni generó la animación.
- A permaneció viva después de terminar B.

Artefacto de verificación del pulido:

urlArtefacto de verificación 14909441239https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45371162667/artifacts/14909226433

Este estado sustituye al anterior veredicto de «primer export funcional sin pulir». La revisión visual posterior confirma que el ciclo mantiene la estructura del Soldier Walk y que el pulido es conservador; no se consideró necesario inflar el timeline con frames duplicados.


### Incidente de entrega y revisión detectado después de la prueba A/B

La primera aceptación técnica del A/B no equivalía todavía a una entrega correcta al usuario. El agente que recibió el resultado de B cometió dos omisiones importantes:

1. **No analizó visualmente el vídeo que B había entregado.** Se comprobó que el WebM existía, que tenía bytes, hash, duración y decodificación válida, pero el agente no realizó la inspección visual del contenido antes de darlo por terminado. Por eso la primera exportación pasó una aceptación técnica sin haber pasado todavía una aceptación visual real.
2. **No entregó al usuario el vídeo final.** El usuario recibió un ZIP como artefacto, no el WebM completo como vídeo reproducible. La entrega no cumplió el objetivo aunque el WebM existiera dentro del proceso/artefacto.

Esto es una diferencia importante entre **«A/B produjo y B verificó un archivo»** y **«el agente inspeccionó, aceptó y entregó el vídeo final al usuario»**. El segundo ciclo es el que debe considerarse completo.

La prueba posterior de pulido corrigió el proyecto persistido y volvió a ejecutar A/B, pero el protocolo de aceptación queda reforzado: el agente receptor no puede saltarse la inspección visual ni sustituir la entrega del vídeo por el ZIP del workflow.

**Orden obligatorio del cierre:** B entrega → agente obtiene el WebM desde el artefacto → agente inspecciona el vídeo → si detecta defectos, corrige el proyecto → vuelve a exportar y obtener el vídeo → vuelve a inspeccionarlo → solo después entrega el vídeo final al usuario.

La inspección no debe limitarse a «hay movimiento». Debe comprobar continuidad temporal, coherencia de poses, que caminar realmente parezca caminar y no una sucesión de desplazamientos arbitrarios, y que el dibujo acompañe correctamente el movimiento: extremidades, pies, manos, cabeza, torso, proporciones, silueta y cualquier elemento que deba moverse junto al personaje. Un dibujo puede estar técnicamente bien formado y aun así animarse mal; esa diferencia debe detectarse antes de la entrega.



## Documentación complementaria y navegación

Este documento es el **documento principal (owner) del flujo A/B y de su experiencia real de implementación, prueba, fallos, correcciones y cierre**.

- El protocolo operativo general del agente está en [ANIMATION-AUTONOMOUS-WORKFLOW.md](./ANIMATION-AUTONOMOUS-WORKFLOW.md). Para el cierre específico de vídeo A/B, ese documento remite a este flujo y a la regla **5.2: recibir → obtener → inspeccionar → corregir → reinspeccionar → entregar**.
- La especificación técnica complementaria de A/B está en [VIDEO-PROCESSING-AB.md](./VIDEO-PROCESSING-AB.md): contrato de A/B, separación de credenciales, transporte, workflows y scripts. Ese documento debe remitir aquí para el historial, los fallos, las correcciones, la aceptación visual y la última revisión real.
- La arquitectura y el transporte del bridge se detallan en [inline-artifact-bridge.md](./inline-artifact-bridge.md); este documento registra cómo se utilizan dentro del recorrido A/B real.

La navegación entre documentos debe ser bidireccional cuando describan partes del mismo proceso: el documento operativo debe llevar a este documento para el caso A/B, y este documento debe llevar al protocolo operativo para las reglas de inspección y cierre.


### Corrección visual y cierre completo A/B — revisión 5 (24/11/2026)

Esta sección registra el ciclo que faltaba completar después de la aceptación técnica anterior. **La revisión 4 se rechazó visualmente y no se entregó.**

#### Rechazo de la revisión 4

La primera corrección incremental sobre la revisión 3 produjo la revisión 4, pero la inspección del WebM reveló cortes en el cuerpo y las extremidades, además de desajustes entre pies y sombra. La causa fue mover regiones del personaje sin separar correctamente el dibujo aplanado. Aunque B verificó técnicamente el archivo, **esa revisión no pasó la aceptación visual** y no debe considerarse resultado final.

- Revisión 4: SHA de contenido `8bd0db84ae3656c8a6af53aac67b1a9c19a49fd74ca8d8ef4236e62fd198fdf3`.
- A/B de diagnóstico: [run 45466759712](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45466759712).
- Se descartó esa edición y se recuperó el proyecto editable limpio de la evidencia de inspección previa, en vez de seguir acumulando desplazamientos sobre una versión defectuosa.

#### Corrección persistida en revisión 5

Se reconstruyó el cambio desde las poses limpias anteriores al desplazamiento global:

- Proyecto ADMIN: `soldier-walk-60f-20261124`, workspace `ws_local_admin`.
- Revisión persistida: **5**.
- SHA-256 del contenido: `7f03b2c70271c8afebd9827766f06696e286ee0b4838b75171302adec5503b15`.
- Timeline: 20 fotogramas a 12 FPS; se conservó porque no hacía falta inflarlo con fotogramas duplicados.
- Se deshizo el desplazamiento global anterior del sprite.
- Se aislaron y alternaron las regiones de píxeles de las piernas inferiores dentro del cel existente, y se añadió un contrabalanceo vertical sutil de la parte superior.
- Se conservaron el rifle, el fondo, el suelo y la sombra de contacto. No se sustituyó el proyecto ADMIN ni se usó una demo.

La corrección se persistió y verificó mediante [workflow de reparación 45468703388](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45468703388). La verificación confirmó revisión 5 y cambio de hash.

#### Nueva ejecución A/B y verificación

La nueva prueba integrada utilizó exactamente la revisión 5:

- [Workflow A/B — run 45469002386](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45469002386).
- [Sesión A independiente — run 45469044832](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45469044832).
- [Artefacto B — WebM y verification.json](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45469002386/artifacts/14955997439).

B recibió el archivo del Video Composer real y confirmó:

- 20 fotogramas, 12 FPS.
- WebM completo: 133.947 bytes, duración aproximada 1,66 s.
- Resolución: 1080 × 1350.
- Chromium: `readyState=4`, 5/5 muestras temporales decodificadas.
- SHA-256 del WebM: `e06b650be888ef79797ad128fdad85392e167dd41482d365233c526c4673363a`.
- B no ejecutó FFmpeg ni generó fotogramas.
- El paso **“Verify A remains alive after B has finished”** pasó; A continuó `in_progress` después de terminar B.

#### Inspección visual del WebM exacto de B

Después de descargar el artefacto, se extrajeron e inspeccionaron visualmente los 20 fotogramas del WebM que se iba a entregar. La revisión confirmó que el movimiento alterna las piernas, incorpora un pequeño contrabalanceo superior y conserva el dibujo y el entorno sin los cortes que invalidaron la revisión 4. La animación sigue siendo una **caminata en el sitio**: no desplaza al soldado hacia delante. La limitación restante es que cabeza, torso y brazos no son capas articuladas independientes en el proyecto original; esta corrección fue incremental y conservadora, no una reconstrucción completa del personaje.

**Estado de cierre:** la revisión 5 pasó la verificación técnica A/B y la inspección visual del archivo exacto. El WebM de esta revisión es el resultado que se entrega; no se sustituye por el ZIP del workflow.

La regla operativa permanece en [ANIMATION-AUTONOMOUS-WORKFLOW.md](./ANIMATION-AUTONOMOUS-WORKFLOW.md), sección 5.2: recibir → obtener → inspeccionar → corregir → reinspeccionar → entregar.

## Selección de proyecto para A/B

La sesión A se inicia con el input `project_id` del proyecto ya importado en ADMIN. B también recibe un input `project_id` y solo envía la petición si coincide con el proyecto fijado por A. Para un proyecto nuevo, iniciar A con su ID y después B con el mismo ID. B no lee el repositorio ni cambia la sesión A; simplemente formula la orden para el proyecto de esa sesión. El default histórico sigue siendo Soldier Walk.

## Catálogo externo de proyectos (inbox de PixelForge)

Los proyectos fuente que deben aparecer en PixelForge ADMIN se alojan en `projects/animation-inbox/<slug>/project.codelab`. El workflow `.github/workflows/pixelforge-project-inbox.yml` importa esos paquetes mediante el bridge inline al workspace ADMIN. Esta fase ocurre antes de A/B y no cambia sus funciones.

- El workflow de inbox, fuera de A/B, es quien lee el repositorio y transfiere el paquete.
- A no lee GitHub ni el repositorio. A conserva su sesión web actual y ejecuta exclusivamente la operación que B le solicita.
- B selecciona el proyecto y la operación, envía la petición a A, recibe el WebM y lo verifica. B no genera animaciones.
- Solo después de comprobar la importación real se inicia el ciclo A/B existente.
- La copia maestra del repositorio no se elimina. La copia temporal ADMIN se elimina desde la acción Delete de la lista de proyectos PixelForge, que solicita confirmación explícita en la interfaz. La eliminación confirmada también limpia los recursos empaquetados y los registros de importación PixelForge asociados en la misma transacción. No se borra automáticamente al terminar B. El WebM y verification.json se conservan como artefactos independientes.

La guía de incorporación y el formato del paquete están en [projects/animation-inbox/README.md](../projects/animation-inbox/README.md); el transporte y la automatización se describen en [inline-artifact-bridge.md](./inline-artifact-bridge.md).

