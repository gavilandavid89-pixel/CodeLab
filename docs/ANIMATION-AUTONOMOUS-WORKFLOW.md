# Protocolo de trabajo autónomo del agente para animación

**Estado:** política operativa solicitada por el usuario.  
**Ámbito:** tareas de dibujo y animación en CodeLab/PixelForge, incluida la animación «PixelForge — Soldier Walk 60F».  
**Objetivo:** que el agente IA sea responsable del proceso completo durante la sesión de trabajo y que el usuario reciba únicamente el resultado final.

## Referencia obligatoria del runtime Headless

Antes de invocar funciones de dibujo o animación, el agente debe leer [API Headless para agentes](HEADLESS-AGENT-API-REFERENCE.md) y ejecutar el artefacto Headless distribuido, no improvisar nombres de acciones ni importar una ruta del editor web. El documento define métodos, acciones, argumentos, límites, ciclo de propuesta y reglas de modos mixtos.

El Headless edita un sandbox y serializa el proyecto aceptado con `runtime.toJSON()`. El ZIP nativo se construye con `createPixelForgeCodeLabPackageZip(project)`, incluido en el artefacto del agente; no existe un método `runtime.exportCodelab()`. La transferencia HTTPS se realiza después, fuera del runtime, siguiendo [inline-artifact-bridge.md](inline-artifact-bridge.md).

## 1. No es un servicio 24/7

El agente IA **no debe mantenerse activo 24/7**, ni crear un proceso permanente para aparentar que sigue trabajando cuando no hay una sesión de trabajo activa.

La responsabilidad es distinta: cuando el usuario solicita una tarea y el agente inicia su ejecución, el agente debe permanecer involucrado durante el trabajo que pueda realizar dentro de esa sesión: enviar órdenes, esperar sus resultados, inspeccionarlos, corregir errores y continuar con los siguientes pasos.

Los workers o servicios de CodeLab pueden ejecutar una orden ya solicitada conforme a su diseño, pero eso no autoriza a crear un agente IA siempre activo ni a iniciar nuevas tareas por su cuenta. Solo una petición explícita del usuario inicia una nueva ejecución del agente IA, conforme a la política actual del agente y del bridge.

Si la sesión del agente se interrumpe o termina, el agente no debe afirmar que siguió trabajando en segundo plano. Al reanudarse mediante una nueva petición del usuario, debe recuperar el estado real y continuar desde allí, sin repetir operaciones ya completadas.

## 2. Ciclo de trabajo obligatorio

El agente IA es responsable de conducir el ciclo completo:

1. **Preparar:** consultar el estado real del proyecto, la tarea pendiente y las evidencias necesarias.
2. **Ordenar:** enviar a CodeLab/A la operación concreta que corresponda.
3. **Esperar:** esperar el resultado de esa orden. No asumir que fue ejecutada solo porque se envió, se aceptó o quedó encolada.
4. **Verificar:** consultar el estado persistido y comprobar que el cambio ocurrió realmente.
5. **Inspeccionar:** evaluar la evidencia visual cuando la tarea afecte dibujos, frames, capas o animación.
6. **Revisar calidad visual:** la revisión visual es **obligatoria** antes de considerar terminada una tarea visual. No basta con que el worker, bridge o exportador informe "success": el agente debe inspeccionar la evidencia visual real y comprobar que el resultado cumple el objetivo de calidad solicitado.
7. **Corregir:** si hay errores, resultados parciales o defectos visuales, diagnosticar la causa, preparar una corrección y volver a ejecutar.
8. **Continuar:** avanzar al siguiente bloque o paso usando el estado real recién verificado.
9. **Finalizar:** exportar y validar el resultado completo antes de declarar la tarea terminada.

El ciclo se repite tantas veces como sea necesario dentro del trabajo solicitado:

**Agente IA → orden → espera → resultado → verificación → inspección → corrección/continuación → nueva orden.**

El agente no debe detenerse después de enviar una única orden ni trasladar al usuario la supervisión rutinaria de cada fotograma o bloque.

## 3. Autonomía y límites de intervención del usuario

- No pedir al usuario que envíe código, capturas, estados o datos que el agente pueda consultar de forma segura mediante las herramientas y conexiones disponibles.
- No pedir confirmación entre fotogramas, bloques o reintentos rutinarios.
- No exigir que el usuario despierte manualmente al agente para cada paso.
- Resolver por cuenta propia los errores técnicos recuperables, siguiendo las políticas de seguridad y permisos del proyecto.
- Consultar al usuario únicamente cuando exista un bloqueo real que requiera una decisión suya, un permiso no concedido, un dato indispensable que no pueda recuperarse o una acción irreversible/destructiva que necesite autorización.
- No inventar resultados ni declarar completada una operación que no tenga evidencia de ejecución y persistencia.

## 4. Espera, supervisión y servicios auxiliares

Este protocolo complementa la política vigente Neon/bridge de AGENTS.md y docs/agent-ai-bridge-policy.md. No depende de los antiguos workflows A/B ni de sus ventanas de supervisión.

La supervisión debe estar vinculada a una tarea iniciada por el usuario; no debe convertirse en vigilancia permanente 24/7. Si una orden sigue en cola o un worker no responde:

1. consultar el identificador, acción, payload y estado real de la orden;
2. identificar qué servicio consume esa orden;
3. inspeccionar logs/estado para localizar la causa;
4. realizar, si corresponde, **un único toque/despertar bajo demanda** del servicio correcto;
5. esperar y verificar la orden concreta antes de reenviar o duplicar operaciones.

No crear polling permanente, bucles de pings ni despertares periódicos. Un ping al frontend no demuestra que el worker consumidor esté activo. No reiniciar ni desplegar servicios ajenos a la tarea.

## 5. Reglas específicas para animación

- Trabajar por bloques cuando sea razonable, sin pedir intervención del usuario entre bloques.
- Consultar el frame anterior real desde CodeLab/A antes de construir el siguiente frame dependiente.
- Después de crear o modificar un bloque, comprobar que los frames quedaron guardados y que el estado activo/índices corresponden.
- Evaluar continuidad, silueta, proporciones, anatomía, pose, dirección del movimiento, pies, manos, cabeza, torso, extremidades y objetos sostenidos.
- **La revisión visual es obligatoria:** toda animación, dibujo, modificación de frames o cambio de capas debe pasar por una inspección visual antes de la entrega.
- La revisión debe utilizar evidencia visual real del resultado producido, no una inferencia basada en el estado de la orden, metadatos, hashes, existencia del archivo o un mensaje de "success".
- En animaciones, revisar como mínimo continuidad entre frames, fluidez del movimiento, silueta, proporciones, anatomía, pose, dirección del movimiento, pies, manos, cabeza, torso, extremidades, objetos y coherencia temporal.
- Para una revisión de calidad suficiente, inspeccionar el resultado completo o una muestra representativa que permita detectar defectos entre frames; cuando existan dudas, revisar los frames afectados individualmente.
- **No declarar terminada una tarea si la revisión visual no se realizó, no está disponible o no permite comprobar la calidad.**
- Rechazar resultados visualmente defectuosos aunque la orden o el workflow informe "success".
- Corregir y repetir los pasos necesarios hasta alcanzar el objetivo o identificar un bloqueo no resoluble.
- Para la entrega, comprobar la cantidad de frames, FPS, duración, loop, archivo exportado y reproducción visual real, además de completar la revisión visual obligatoria. La existencia del archivo por sí sola no demuestra que la animación esté bien.

## 5.0.1. Tomas de cámara y cortes de plano

En animación narrativa, un cambio de toma no debe modelarse por defecto como un paneo, travelling o rotación continua de la cámara. Cuando la intención sea mostrar la misma acción desde otra perspectiva, el agente debe preferir **cortes de plano discretos**: una toma termina y la siguiente comienza ya encuadrada desde otra posición, escala o perspectiva.

Reglas operativas:

- Identificar los puntos narrativos donde conviene cambiar de plano: anticipación, impacto, reacción, vuelo, caída, etc.
- El cambio de encuadre debe ocurrir de forma instantánea entre fotogramas o bloques; no interpolar decenas de fotogramas solo para desplazar la cámara de una posición a otra.
- El nuevo plano debe tener una composición propia y mantener la acción legible.
- Revisar continuidad de siluetas, posiciones relativas, anatomía y dirección del movimiento después de cada corte.
- Un corte de cámara no debe confundirse con mover físicamente a los personajes dentro de la escena.
- Si el runtime utilizado no dispone de una cámara narrativa nativa, documentar el mecanismo visual equivalente utilizado por el proyecto en lugar de inventar una API de cámara inexistente.
- La revisión visual debe comprobar específicamente que el corte se percibe como un cambio de toma y no como un movimiento continuo accidental.

## 5.1. Reparación incremental del proyecto existente

Cuando la inspección detecte defectos, el agente debe intentar corregir el proyecto que ya creó, no descartarlo automáticamente. Headless puede reabrir la última versión editable y aplicar cambios sobre frames, cels, capas, objetos, parámetros y timing existentes.

- Localizar el defecto y determinar qué elementos/frames lo causan.
- Conservar intactas las partes que ya cumplen el objetivo.
- Modificar solo los elementos afectados siempre que sea posible.
- Validar el cambio y revisar los frames vecinos para evitar romper continuidad.
- Exportar una nueva revisión y repetir la inspección visual.
- Si la tarea incluye vídeo final, volver a procesar A/B desde la nueva revisión y revisar el nuevo archivo antes de entregarlo.

No empezar desde cero como reacción predeterminada a un error. Hacerlo solo si la estructura está irrecuperablemente dañada, la reparación incremental no es técnicamente viable o el usuario lo pide. Si Headless no puede resolver el defecto, comunicar el bloqueo con precisión en lugar de simular una corrección.

## 6. Comunicación con el usuario: solo resultado final

Durante la ejecución normal, el agente **no debe enviar informes de progreso, mensajes de "sigo trabajando", solicitudes de confirmación por cada paso ni actualizaciones intermedias**.

Al terminar, debe enviar **un único informe final** que indique:

- si la tarea quedó completada;
- qué resultado se produjo y dónde quedó disponible;
- qué verificaciones técnicas y visuales se realizaron;
- qué defectos se corrigieron;
- cualquier limitación o bloqueo que haya quedado pendiente.

Si aparece un bloqueo que realmente requiere intervención del usuario, debe explicar solo ese bloqueo de forma clara y concreta; no debe fingir que la tarea continúa avanzando.

## 7. Seguridad y alcance

- No modificar ni borrar datos de Neon de forma destructiva sin autorización explícita.
- No tocar otros servicios o aplicaciones de Render que no formen parte de esta tarea.
- No exponer secretos, tokens, cookies ni credenciales en documentación, logs o mensajes.
- Antes de reiniciar, desplegar o cambiar configuración, identificar el servicio exacto y confirmar que la acción es necesaria y está dentro del alcance autorizado.

## Transporte de proyectos y persistencia

La edición y animación se realiza en el Headless propio del agente, completamente aislado. **El Headless no se conecta al intermediario.** Exporta el proyecto nativo y termina su participación; después, el agente IA recoge el archivo fuera del Headless y lo lleva al HTTPS inline bridge descrito en [inline-artifact-bridge.md](inline-artifact-bridge.md).

Este documento no redefine el contrato de transporte. Para evitar divergencias, los endpoints, tipos de artefacto, límites, chunking, SHA-256, estados, staging y creación de órdenes se mantienen exclusivamente en el documento del bridge.

Reglas operativas:

- El Headless propio del agente no recibe credenciales de Neon, Object Storage/S3 ni secretos internos, y tampoco recibe endpoints/tokens ni se conecta al intermediario.
- El bridge recibe el paquete en chunks y conserva temporalmente los bytes en Neon BYTEA; no necesita Object Storage para el transporte/importación documentado.
- El commit verifica integridad y encola la importación. HTTP 202 significa queued, no importado ni persistido.
- El worker importa al workspace destino indicado y elimina el staging temporal cuando corresponde.
- El agente espera el resultado, verifica el workspace destino, lee el proyecto de vuelta y comprueba que la estructura y los datos editables se conservaron.
- No declarar finalización basándose solo en un archivo local, un hash calculado, una respuesta HTTP o una orden encolada.

Para obtener e instalar el Headless propio, seguir [HEADLESS-AGENT-RUNTIME.md](HEADLESS-AGENT-RUNTIME.md). Para la arquitectura de órdenes y worker, consultar [CodeLab_Neon_comunicacion_extremo_a_extremo.md](CodeLab_Neon_comunicacion_extremo_a_extremo.md).

## Regla de entrega GIF y vídeo final

El GIF generado localmente por Headless solo se entrega cuando el usuario pide expresamente un GIF. Si no lo pide, no se adjunta ni se usa como sustituto del proyecto editable: el agente debe tomar el archivo exportado fuera de Headless, transferirlo al intermediario y verificar CodeLab.

Cuando la petición incluya vídeo final, A/B es una etapa integrada posterior a la persistencia del proyecto. El agente coordina A/B, recupera el archivo de vídeo final, lo reproduce e inspecciona y lo entrega al usuario. No basta con la evidencia, event_id o estado success. Ver [CODELAB-A-B-SESSION-VIDEO-ARCHITECTURE.md](./CODELAB-A-B-SESSION-VIDEO-ARCHITECTURE.md), que es el documento owner del flujo real, y [VIDEO-PROCESSING-AB.md](./VIDEO-PROCESSING-AB.md), que contiene el contrato técnico A/B.

## 8. Criterio de finalización

La tarea solo se considera terminada cuando:
- el resultado está persistido;
- la exportación existe y puede abrirse/reproducirse;
- la cantidad de frames, FPS, duración y loop son correctos;
- la evidencia técnica confirma que el resultado fue realmente ejecutado y guardado;
- **la revisión visual obligatoria confirma que la calidad del resultado cumple el objetivo**.

Si la revisión visual detecta defectos, la tarea vuelve al ciclo de corrección y no puede declararse terminada hasta repetir la verificación.

La revisión visual es un requisito de aceptación, no un paso opcional ni una comprobación meramente decorativa.

**Principio rector:** el usuario define el objetivo; el agente conduce el trabajo completo durante la sesión activa y comunica el resultado final. No se requiere que el usuario supervise cada orden, fotograma o corrección.


## 8. CodeLab package installation and resource destinations

A ZIP is recognized as a CodeLab package only when it contains `project.codelab` at the archive root, plus root `manifest.json` and `project.json`. The ZIP filename and extension are irrelevant.

Import is a two-stage operation: validate/extract the package, then install its declared resources into editor-native structures. Files are never guessed to be frames from their names or extensions.

Top-level folder destinations are preserved and classified as follows:

- `assets/**` → project assets
- `scenes/**` → project scenes
- `animations/**` → animation resources
- `frames/**` → frame source resources
- all other safe paths → project files

For PixelForge, the manifest may explicitly map external frame cels to native animation slots:

```json
{
  "format": "codelab",
  "version": 1,
  "editor": "pixelforge",
  "projectType": "pixelforge",
  "entry": "project.json",
  "animation": {
    "fps": 12,
    "activeFrameIndex": 0,
    "loop": true,
    "frames": [
      {
        "id": "frame-1",
        "durationMs": 83,
        "cels": [
          {
            "layerId": "layer-base",
            "path": "frames/0001/base.png",
            "encoding": "png"
          },
          {
            "layerId": "layer-detail",
            "path": "frames/0001/detail.rgba",
            "encoding": "rgba8"
          }
        ]
      }
    ]
  }
}
```

Each frame must provide exactly one cel for every layer ID declared by `project.json`. A cel path must exist in the archive, may only be assigned once, and must match the project canvas dimensions. Supported cel encodings are PNG (8-bit, non-interlaced grayscale/RGB/indexed/grayscale-alpha/RGBA) and raw RGBA8. The installer converts them to the base64 RGBA cels consumed by `PixelForgeAnimation.fromJSON`, then writes the native `project.animation` object into the project before Neon persistence. Limits follow PixelForge: 240 frames, 64 layers, 1–60 FPS, 1–10,000 ms per frame, and a 64 MiB animation pixel-memory budget.

This mapping is explicit and deterministic: an arbitrary PNG under `assets/` remains an asset and is never silently inserted into the timeline.

## 9. Clasificación semántica de recursos y destinos ampliados

El instalador no debe enviar automáticamente todas las carpetas no reconocidas a `project-files`. Clasifica cada archivo en este orden:

1. `manifest.resources[]` puede declarar explícitamente `path` y `destination`; esta declaración tiene prioridad.
2. Los nombres de carpetas y sus alias se interpretan semánticamente, incluso cuando están anidados.
3. Si la ruta no da contexto suficiente, se usa la extensión como pista de tipo de recurso.
4. Si la extensión tampoco ayuda, se inspeccionan firmas binarias conocidas (PNG/JPEG/GIF/WebP, audio, video, PDF, GLB y fuentes) y encabezados de SVG/HTML.
5. Solo los formatos o rutas que sigan siendo ambiguos quedan en `project-files`.

Destinos admitidos: `reference-center`, `assets`, `scenes`, `animations`, `frames`, `audio`, `video`, `fonts`, `documents`, `models`, `textures`, `scripts`, `styles`, `components`, `templates`, `pages`, `exports`, `backups`, `data` y `project-files`.

Ejemplos de alias: `reference`, `references`, `refs`, `moodboard` e `inspiration` se enrutan al **centro de referencia**; `guides` y `docs` a documentos; `sounds` y `music` a audio; `typography` a fuentes; `models` a modelos 3D; `components` a componentes; `pages` y `views` a páginas. Las rutas ya canónicas se conservan sin duplicar carpetas. Para evitar falsas asignaciones, los nombres de archivos por sí solos no se usan para inferir frames: la animación PixelForge sigue dependiendo del mapeo explícito de cada celda a frame y capa.

El manifiesto puede forzar un destino cuando el nombre o la extensión no expresan el propósito:

```json
{
  "resources": [
    { "path": "misc/pose.png", "destination": "reference-center" },
    { "path": "misc/brand-font.woff2", "destination": "fonts" }
  ]
}
```

Cada recurso conserva sus bytes y se persiste bajo su ruta de destino canónica. `project-files` queda reservado para archivos sin una clasificación fiable. La clasificación organiza el almacenamiento de importación; no afirma que una vista concreta del editor ya haya consumido el recurso si esa integración nativa todavía no existe.


## 10. Integración de recursos importados en PixelForge

Además de conservar los archivos en `codelab_project_files`, los proyectos PixelForge reciben un índice persistente `drawingModel.packageResources` con la ruta de origen, destino canónico, tipo MIME y tamaño de cada recurso. El panel Reference Center lo muestra agrupado por destino, para que también sean localizables documentos, audio, video, fuentes, modelos, componentes y demás archivos del paquete.

Las imágenes ubicadas en `reference-center` (o carpetas alias como `reference/`, `refs/`, `moodboard/`) se incorporan como entradas inmutables de `drawingModel.referenceCenter.entries`. PNG, JPEG, GIF y WebP se reconocen por su firma binaria y se muestran como miniaturas en Reference Center. El usuario puede copiarlas al lienzo como una capa editable; se ajustan al canvas manteniendo la proporción y sin modificar el original. La incrustación está limitada a 4 MiB por imagen y 12 MiB acumulados; los archivos de referencia que exceden esos límites siguen en el catálogo de recursos y en el almacenamiento de archivos del proyecto.

El editor refresca Reference Center después de cargar un proyecto, no solo al crear la interfaz. Así las referencias importadas aparecen en la primera apertura y al cambiar de proyecto. La conversión de imágenes no las inserta en la línea de tiempo: los frames continúan sujetos al mapeo explícito frame/capa del manifiesto.


## Formato .codelab estructurado v2

La importación de proyectos admite el esquema estructurado v2 para que CodeLab pueda reconstruir el proyecto sin inferir estructura desde nombres de archivos o desde una transferencia de datos plana.

La forma canónica es:

```
project.codelab
├── manifest.json
├── project.json
├── frames/
│   ├── frames.tscn
│   ├── frame.001/
│   │   ├── frame.json
│   │   └── layer.001/
│   │       └── pixels.bin
│   └── frame.002/
│       └── ...
└── center.op/
    ├── center.json
    ├── reference.personaje/
    │   └── reference.personaje1/
    │       ├── reference.json
    │       └── image.bin
    ├── reference.entorno/
    ├── reference.efectos/
    ├── reference.detalles/
    ├── reference.objetos/
    └── reference.elementos/
```

Cada frame declara explícitamente su `id`, índice, duración, dimensiones y `layerCount`. Cada layer declara su identidad, posición, opacidad, visibilidad, z-index y el archivo RGBA8 que contiene sus píxeles. No se debe deducir qué layer pertenece a qué frame por el nombre del archivo.

El Reference Center usa `center.op/center.json` como índice y carpetas `reference.<categoria>` como ubicación declarativa. Cada referencia declara su identidad, categoría, geometría, transformación y partes editables. Cada parte conserva sus propios píxeles y SHA-256. La copia Reference → Canvas debe usar estos datos como fuente de verdad y producir una copia profunda editable; nunca una capa vacía o una referencia externa frágil.

### Regla de persistencia

Después de instalar el paquete, CodeLab vuelve a leer el proyecto y todos sus archivos desde PostgreSQL/Neon y verifica SHA-256 y bytes contra lo que acaba de persistir. El resultado de la importación marca `reloadedFromPersistence=true`. Esto convierte la persistencia de CodeLab en la siguiente fuente de verdad y evita que una operación posterior dependa del payload de transferencia original.

La validación v2 es estricta: IDs duplicados, paths inseguros, dimensiones inconsistentes, cels ausentes, capas desconocidas, píxeles con tamaño incorrecto o referencias fuera de su categoría hacen fallar la importación en lugar de inventar o completar datos.

El esquema v1 existente continúa aceptándose para compatibilidad.


## 5.2. Regla específica para vídeo A/B: recibir → obtener → inspeccionar → corregir → reinspeccionar → entregar

Cuando el usuario solicite una animación con vídeo final, **el agente que está recibiendo y ejecutando las órdenes del usuario es responsable del cierre completo**, aunque A y B hayan realizado correctamente la parte técnica del pipeline.

El procedimiento obligatorio es:

1. **Esperar a B.** No dar por terminado el trabajo porque A haya exportado, porque B esté ejecutándose o porque exista un comentario/estado de éxito. El agente debe esperar a que B termine y entregue su resultado.
2. **Obtener el vídeo real.** Recuperar el artefacto generado por B y localizar dentro de él el WebM final. No confundir el ZIP del workflow/artefacto con el vídeo que debe recibir el usuario.
3. **Comprobar que es el vídeo completo.** Abrir el WebM obtenido, comprobar que corresponde a la exportación solicitada y que no se está usando una muestra, captura, frame suelto, archivo truncado o paquete sin el vídeo final.
4. **Inspeccionar visualmente.** Reproducir/decodificar el vídeo y analizar su contenido. La inspección debe comprobar tanto la animación como el dibujo.
5. **Evaluar continuidad.** Revisar la transición entre frames, continuidad del ciclo, timing, aceleración/desaceleración perceptual, posiciones de apoyo y que el movimiento tenga una causa visual coherente. Para caminar, no basta con que cambien piernas y brazos: debe percibirse un ciclo de caminata con pasos y transferencia de peso coherentes, sin movimientos arbitrarios o sin sentido.
6. **Evaluar acompañamiento del dibujo.** Comprobar que las partes que deben acompañar el movimiento efectivamente lo hagan: torso, cabeza, brazos, manos, piernas, pies, objetos sostenidos, ropa o detalles relevantes. Detectar partes que se quedan rígidas cuando deberían acompañar, partes que se desprenden visualmente, deformaciones, elementos que aparecen/desaparecen sin motivo y errores de silueta.
7. **Respetar la orden del usuario.** La intención y las restricciones expresadas por el usuario son la prioridad. La inspección no autoriza al agente a cambiar arbitrariamente el objetivo, estilo, pose, timing o cantidad de movimiento solicitados. La revisión sirve para comprobar que la ejecución cumple esa orden, no para sustituirla por el criterio estético del agente.
8. **Corregir si hace falta.** Si la inspección encuentra un problema, volver al proyecto editable persistido y corregirlo de forma incremental. Si el defecto está en el proyecto, no maquillar el vídeo final ni declararlo aceptado.
9. **Repetir A/B.** Después de una corrección que afecte al vídeo, volver a ejecutar el flujo A/B y esperar nuevamente el resultado de B. No reutilizar el WebM anterior como si representara la nueva revisión.
10. **Reinspeccionar.** Obtener nuevamente el vídeo desde el artefacto de B y repetir la inspección. La corrección solo queda aceptada cuando el nuevo vídeo pasa la revisión.
11. **Entregar al usuario.** Solo después de completar la inspección y, si correspondió, la corrección y reinspección, presentar al usuario el **vídeo WebM completo y reproducible**, no el ZIP del workflow como sustituto.

### Regla reforzada: aceptación visual del vídeo A/B y límites de Xvfb

**Una animación no puede declararse buena, correcta ni terminada basándose únicamente en el proyecto Headless, capturas de su interfaz, logs, hashes, metadatos o una decodificación técnica.** Cuando la tarea produce un vídeo final, la aceptación visual obligatoria se realiza sobre el **WebM exacto generado por A/B**, recuperado del artefacto de B.

Xvfb solo proporciona un servidor gráfico virtual para ejecutar aplicaciones que necesitan display. Que Chromium, Headless o el exportador funcionen bajo Xvfb, o que se puedan tomar capturas de esa sesión, **no demuestra que el vídeo final se haya visto ni que la animación sea visualmente correcta**. Xvfb no sustituye la inspección del vídeo.

El agente responsable debe, fuera del proceso Headless:

1. Recuperar y abrir/reproducir el WebM completo producido por A/B, no una previsualización local ni una exportación anterior.
2. Inspeccionar visualmente el movimiento a lo largo de toda la duración. Puede apoyarse en reproducción real y en una extracción de fotogramas distribuida temporalmente, ampliando a fotogramas consecutivos donde haya dudas o movimiento rápido.
3. Examinar tanto el dibujo como la animación: anatomía/silueta, integridad de trazos y piezas, continuidad entre poses, timing, apoyos, deformaciones, elementos que aparecen/desaparecen y coherencia con la intención del usuario.
4. Confirmar que el WebM inspeccionado corresponde exactamente a la revisión del proyecto y al archivo que se entregará, usando los metadatos/hash como trazabilidad adicional, nunca como sustituto de la inspección.
5. Registrar qué vídeo/revisión se inspeccionó, qué evidencia visual se examinó, defectos encontrados y veredicto.

Si no puede acceder al vídeo real o no puede inspeccionarlo visualmente con suficiente detalle, el estado será **pendiente de revisión visual**, nunca “buena animación” ni “aprobada”. Si detecta defectos, rechaza esa revisión, corrige el proyecto editable en Headless, vuelve a exportar/persistir según el flujo vigente, ejecuta A/B otra vez y repite la inspección sobre el nuevo WebM. No se aprueba una revisión anterior en nombre de la nueva.

### Criterio de aceptación visual mínimo

Antes de presentar el vídeo, el agente debe poder responder afirmativamente a estas preguntas:

- ¿Es el vídeo completo solicitado?
- ¿Proviene de la revisión correcta del proyecto?
- ¿El movimiento tiene continuidad entre frames?
- ¿El ciclo tiene sentido temporal y espacial?
- Si es una caminata, ¿realmente parece una caminata y no poses alternadas sin conexión?
- ¿El cuerpo acompaña el movimiento de forma coherente?
- ¿Las extremidades y elementos vinculados al personaje acompañan correctamente?
- ¿Hay partes que se quedan atrás, flotan, desaparecen, se deforman o contradicen el movimiento?
- ¿La animación respeta la orden concreta del usuario?
- ¿La versión inspeccionada es exactamente la que se va a entregar?

Si alguna respuesta es negativa, **no se entrega todavía**: se vuelve al ciclo de corrección.

### Regla de prioridad

La orden del usuario tiene prioridad sobre las preferencias estéticas del agente. Sin embargo, una orden de «hacer una caminata», por ejemplo, no significa aceptar cualquier sucesión de frames que técnicamente se mueva. El agente debe usar su inspección para garantizar que la ejecución sea coherente con el significado de la orden y que el dibujo acompañe el movimiento de forma correcta.

Por tanto:

**orden del usuario → ejecución → B entrega → agente obtiene vídeo → inspección visual → corrección si corresponde → nueva A/B → nueva inspección → entrega del vídeo.**

Nunca:

**B termina → ZIP → «success» → entregar sin mirar el vídeo.**

## Catálogo de proyectos de repositorio para A/B

Para proyectos preparados en `projects/animation-inbox/<slug>/project.codelab`, usar el workflow `.github/workflows/pixelforge-project-inbox.yml` para importarlos al workspace ADMIN antes de iniciar A/B. El workflow de catálogo es externo a A/B: lee el repositorio y usa el bridge inline; no cambia las responsabilidades de los agentes.

- A no lee el repositorio; ejecuta la web real y cumple la operación concreta que B le envía.
- B elige el proyecto y formula la orden, la envía a A y después recibe/verifica el WebM. B no crea la animación.
- Esperar y comprobar que la importación quedó persistida y que el proyecto aparece en PixelForge antes de pedir la exportación a A.
- Tras terminar A/B, conservar el WebM y sus evidencias. La copia fuente del repositorio permanece intacta; la copia temporal ADMIN requiere confirmación explícita del usuario antes de eliminarse.

Ver [guía del inbox](../projects/animation-inbox/README.md), [contrato A/B](./CODELAB-A-B-SESSION-VIDEO-ARCHITECTURE.md) y [transporte inline](./inline-artifact-bridge.md).

## Catálogo de proyectos PixelForge: importación y uso con A/B

El inbox `projects/animation-inbox/<slug>/project.codelab` permite versionar paquetes PixelForge nativos y preparar una copia de trabajo en el workspace ADMIN. El workflow `pixelforge-project-inbox.yml` valida el ZIP/manifiesto, lo transfiere por el bridge inline y encola la importación. Un estado `queued` no confirma que el worker haya terminado: comprobar que el proyecto aparece en PixelForge antes de arrancar A/B.

Después de importar, iniciar A con el ID interno `project.json.id` como `project_id` y B con el mismo ID. A ejecuta la web real; B elige el proyecto, envía la orden y recibe/verifica el WebM. El slug del inbox no reemplaza al ID interno. A no lee el repositorio y B no genera animaciones.

La fuente del inbox permanece versionada. La copia de trabajo ADMIN requiere Delete y confirmación explícita para limpiarse. Esperar a que A ya no necesite el proyecto; que B haya terminado no implica que la sesión A haya expirado. El WebM y las evidencias se conservan aparte.

Ver [guía del inbox](../projects/animation-inbox/README.md), [arquitectura owner A/B](./CODELAB-A-B-SESSION-VIDEO-ARCHITECTURE.md) y [bridge inline](./inline-artifact-bridge.md).

## Criterio de selección: transferencia normal o inbox

No se debe enviar todo proyecto automáticamente al inbox. La ruta del repositorio está pensada sobre todo para proyectos grandes o para situaciones en las que el flujo habitual no ofrece datos de transferencia suficientes para reconstruir/importar el proyecto.

- Si el proyecto es pequeño y hay un paquete/snapshot normal, completo y utilizable, usar la transferencia habitual.
- Si el proyecto es grande, con muchos recursos, o no existen datos de transferencia utilizables (o están incompletos), usar el inbox para transportar el paquete nativo completo.
- No iniciar A/B hasta confirmar que el proyecto está persistido y visible en ADMIN, independientemente del método de entrada.

El inbox resuelve el transporte/importación del proyecto; no cambia la función de A ni de B.
