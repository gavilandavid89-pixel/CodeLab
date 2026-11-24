# Referencia completa de capacidades de PixelForge Headless

**Estado:** referencia técnica de capacidades implementadas en la rama `main`.  
**Fuente primaria del runtime:** `public/pixelforge/src/headless.js`, especialmente `HEADLESS_CAPABILITIES` y `HeadlessEditorRuntime`.  
**Catálogo complementario:** `CODELAB-PIXELFORGE-COMMAND-CATALOG.md`, que documenta también la mailbox, el worker y los comandos externos.

Este documento explica qué puede hacer el runtime Headless, para qué sirve cada familia de operaciones, cómo se usa, qué comportamiento debe esperar el agente y cuáles son sus límites. Describe capacidades reales del runtime, no promesas de funciones que solo existan en la interfaz gráfica o en otros servicios.

---

## 1. Qué es Headless y qué problema resuelve

PixelForge Headless es un runtime de automatización **sin interfaz gráfica y sin dependencia de proveedores de IA**. Permite que un agente lea, cree y modifique proyectos PixelForge de forma estructurada y reproducible, desde código, sin tener que manejar clicks ni enviar cada cambio a un servidor.

Su función principal es ser el entorno creativo del agente:

- abrir un documento PixelForge existente o crear uno;
- inspeccionar su estructura y sus píxeles;
- dibujar y editar contenido raster;
- organizar capas y selecciones;
- leer y modificar el modelo vectorial;
- crear, editar y revisar animaciones frame por frame;
- analizar diferencias y movimiento;
- trabajar con referencias visuales;
- proponer cambios aislados, mostrar qué cambiaría y permitir su aceptación o descarte;
- serializar/exportar el proyecto una vez que los cambios hayan sido aceptados.

**Por qué existe:** permite realizar trabajo creativo de manera precisa, automatizable, repetible y auditable. El agente puede consultar el estado real del documento en lugar de adivinarlo a partir de una captura, y puede reparar un proyecto existente sin reconstruirlo necesariamente desde cero.

### Lo que no es

Headless no es:
- la interfaz web de PixelForge;
- un navegador Chromium ni un capturador de pantalla;
- un motor de vídeo en tiempo real;
- un proveedor de generación de imágenes o IA;
- el bridge, el worker o la base de datos de CodeLab;
- un servicio persistente que siga trabajando cuando la sesión del agente termina.

El runtime es **DOM-free** y no ejecuta un reloj de reproducción en tiempo real. Las capturas reales de interfaz, la reproducción visual del Video Composer y la codificación de vídeo se realizan mediante las rutas de navegador/Video Composer documentadas por separado.

---

## 2. Arquitectura y ciclo de vida

### 2.1 Separación de entornos

El Headless propio del agente se instala y ejecuta dentro del entorno aislado de la IA que recibió la tarea. Puede ser efímero.

El flujo de responsabilidades es:

```text
Agente IA
  ├─ obtiene e instala el artefacto Headless
  ├─ carga el proyecto en Headless
  ├─ inspecciona y edita dentro del sandbox
  ├─ crea una propuesta y revisa el diff
  ├─ acepta o descarta la propuesta
  └─ exporta/serializa el proyecto editable
       │
       ▼
Agente IA, fuera de Headless
  └─ recoge el archivo exportado y lo transfiere por HTTPS inline bridge
       │
       ▼
CodeLab / worker / Neon
  └─ importa, persiste y permite leer de vuelta el proyecto
```

Headless no conoce el bridge ni se conecta a CodeLab, Neon, S3, Render o APIs internas. No recibe tokens, cookies, contraseñas ni credenciales de base de datos. La transferencia es responsabilidad del agente, fuera del runtime.

### 2.2 Crear o abrir un runtime

La API pública del módulo expone:

- `createHeadlessRuntime(options)`: crea una instancia de `HeadlessEditorRuntime`.
- `HeadlessEditorRuntime.fromJSON(project)`: reconstruye un runtime desde un proyecto serializado.
- `runtime.inspect()`: devuelve el estado del documento, sandbox, propuesta, animación y capacidades.
- `runtime.execute(action)`: ejecuta una operación estructurada.
- `runtime.executeBatch(actions)`: ejecuta una secuencia de operaciones.
- `runtime.createProposal(summary)`: crea una propuesta a partir de cambios pendientes.
- `runtime.getDiff()`: calcula el diff visual, vectorial y de animación.
- `runtime.acceptProposal()`: acepta la propuesta y aplica los cambios al documento en memoria.
- `runtime.discardProposal()`: rechaza la propuesta pendiente.
- `runtime.discardSandboxChanges()`: descarta los cambios de sandbox.
- `runtime.syncFromSource(options)`: sincroniza el sandbox desde el documento fuente.
- `runtime.toJSON()`: serializa el documento solo si no hay cambios/propuestas sin revisar.
- `runtime.document`, `runtime.sandbox`, `runtime.workspace`: exponen las instancias correspondientes.
- `runtime.hasPendingChanges` y `runtime.hasPendingProposal`: indican si hay cambios o propuesta pendientes.

La construcción exacta de `options` depende de cómo se obtiene el documento en el entorno que integra Headless. El runtime también puede construirse con `{ project }` cuando ya se dispone del JSON del proyecto.

### 2.3 Sandbox y aprobación

Las mutaciones raster, vectoriales y de animación se realizan primero sobre un **sandbox aislado**. No se escriben automáticamente en el proyecto fuente ni en Neon.

Ciclo normal:

1. Cargar el proyecto y obtener su revisión base.
2. Inspeccionar el estado original.
3. Ejecutar operaciones sobre el sandbox.
4. Revisar los resultados de cada operación.
5. Crear una propuesta con un resumen.
6. Examinar el diff de píxeles, capas, objetos vectoriales y timeline.
7. Aceptar o descartar la propuesta.
8. Solo después de aceptar, serializar/guardar el documento mediante el mecanismo autorizado de persistencia.

La aprobación no equivale por sí sola a guardar en Neon: acepta los cambios en el documento en memoria. La integración externa debe realizar la persistencia autenticada y comprobar la revisión guardada.

La capa de integración añade token de propuesta y control de concurrencia con `serverRevision`. Una propuesta basada en una revisión antigua no debe sobrescribir cambios de otra sesión.

### 2.4 Estados y errores

Cada operación devuelve un resultado estructurado con `ok`, el nombre de la acción y `result` o `error`. En lotes, cada resultado conserva su índice.

- Si una operación del lote falla, `executeBatch` se detiene en ese índice y devuelve `failedIndex`; las operaciones posteriores no se ejecutan.
- Errores de argumentos/tipos se informan como errores de validación.
- Límites o índices fuera de rango se informan como errores de límite.
- Una propuesta pendiente bloquea nuevas mutaciones vectoriales y de animación hasta aceptarla o descartarla.
- Una operación exitosa en sandbox **no significa** que el proyecto haya sido aprobado, persistido o publicado.

---

## 3. Capacidades y límites declarados por el runtime

El objeto `HEADLESS_CAPABILITIES` publica el protocolo y los límites siguientes:

| Capacidad | Límite actual |
|---|---:|
| Protocolo | `pixelforge-headless/v1` |
| Operaciones por lote | 1–500 |
| Capas raster | 64 |
| Frames de animación | 240 |
| Ancho o alto del canvas | 4096 px |
| Ancho/alto de lectura de región | 32 px |
| Píxeles máximos por lectura de región | 1024 |
| Memoria RGBA raster | 64 MiB |
| Memoria RGBA de animación | 64 MiB |
| JSON serializado del proyecto | 96 MiB |
| Aprobación de propuestas | Obligatoria para mutaciones |
| Persistencia autenticada | Gestionada por la integración, no por Headless aislado |

El modelo vectorial tiene límites propios: hasta 10.000 objetos, 240 entradas de frame y 16 MiB serializados. La importación SVG admite hasta 2 MiB.

Los límites se aplican en conjunto con la memoria disponible y las validaciones del documento. No se deben interpretar como garantía de que cualquier proyecto que alcance todos los máximos pueda procesarse simultáneamente.

---

## 4. Documento, estado y lectura del proyecto

Estas operaciones permiten conocer el proyecto antes de tocarlo:

| Operación | Qué hace | Para qué sirve |
|---|---|---|
| `document.get_summary` | Devuelve resumen del documento. | Identificar dimensiones, nombre y estructura antes de editar. |
| `document.rename` | Cambia el nombre del documento en sandbox. | Organizar o corregir el nombre del proyecto. |
| `drawing.model.get` | Lee el modelo de dibujo normalizado. | Entender la estructura y metadatos de dibujo. |
| `drawing.sheet.get` | Lee la configuración de la hoja/canvas. | Consultar el espacio de trabajo. |
| `drawing.sheet.configure` | Modifica la configuración admitida de la hoja. | Ajustar el contexto de trabajo sin alterar píxeles directamente. |
| `drawing.palette.get` | Lee la paleta disponible. | Mantener coherencia cromática y reutilizar colores. |
| `drawing.current_state.get` | Recupera el estado contextual del dibujo. | Reanudar una operación con contexto real. |
| `drawing.current_state.set` | Actualiza ese estado contextual. | Registrar qué objeto/parte o contexto está activo. |
| `canvas.get_reference` | Obtiene información de referencia del canvas. | Interpretar coordenadas y espacio de dibujo. |
| `canvas.get_pixel` | Lee el píxel en una coordenada. | Comprobar color/transparencia con precisión. |
| `layer.get_context` | Devuelve píxeles y metadatos de la capa actual o indicada, además de la capa anterior como contexto. | Evitar inferir contenido oculto o reconstruir capas por memoria. |
| `drawing.object.select_at` | Busca/selecciona el objeto asociado a una posición. | Localizar elementos en el modelo de dibujo. |
| `drawing.object.inspect` | Inspecciona un objeto. | Consultar sus propiedades y contenido. |
| `drawing.layer.inspect` | Inspecciona una capa. | Entender una capa antes de modificarla. |

Las lecturas de región son deliberadamente pequeñas (máximo 32×32 y 1024 píxeles). Para revisar áreas mayores, el agente debe dividir la inspección en regiones o utilizar la evidencia/captura adecuada.

### Cómo usar estas lecturas

- Leer el resumen y las dimensiones antes de dibujar.
- Consultar la capa activa y sus píxeles antes de reemplazarlos.
- En animación, consultar el frame y el cel anterior antes de construir el siguiente.
- Usar los IDs devueltos por el runtime, no inventar identificadores.
- Volver a inspeccionar después de cada cambio que afecte estructura o contexto.

---

## 5. Dibujo raster y edición de píxeles

El runtime ofrece operaciones de dibujo a nivel de canvas:

| Operación | Capacidad / propósito |
|---|---|
| `canvas.draw_line` | Dibuja una línea entre coordenadas. |
| `canvas.draw_stroke` | Aplica un trazo definido por una secuencia de puntos. |
| `canvas.fill` | Rellena una zona según la operación de relleno admitida. |
| `canvas.clear_region` | Limpia una región. |
| `canvas.copy_region` | Copia píxeles de una región. |
| `canvas.paste_region` | Pega píxeles copiados en una posición destino. |
| `canvas.crop` | Recorta el documento/canvas según la región solicitada. |
| `canvas.draw_shape` | Dibuja una forma raster. |
| `canvas.fill_gradient` | Aplica un gradiente. |
| `canvas.flip_region` | Invierte/refleja una región. |
| `canvas.create_outline` | Genera un contorno a partir de los píxeles de una región. |
| `canvas.replace_color` | Sustituye un color por otro. |
| `canvas.preview_transform_region` | Calcula/previsualiza una transformación sin aplicarla todavía. |
| `canvas.transform_region` | Aplica la transformación de región validada. |

Estas herramientas sirven para pixel art, sprites, iconos, retoque, limpieza de bordes, recoloración, composición y corrección localizada.

**Regla de trabajo:** previsualizar transformaciones cuando sea posible; comprobar límites y transparencia; evitar reemplazar una capa completa cuando basta con una región. La lista anterior identifica las operaciones soportadas, pero no inventa parámetros no declarados en el contrato: los argumentos exactos deben tomarse del wrapper/validador de la versión instalada y de los ejemplos de pruebas vigentes.

### Selección

| Operación | Función |
|---|---|
| `selection.clear` | Elimina la selección activa. |
| `selection.create_rect` | Crea una selección rectangular. |
| `selection.create_ellipse` | Crea una selección elíptica. |
| `selection.create_lasso` | Crea una selección libre. |
| `selection.create_magic` | Crea una selección por criterio de similitud/conectividad admitido. |
| `selection.modify` | Modifica la selección actual. |
| `selection.combine` | Combina selecciones según el modo admitido. |
| `selection.translate` | Desplaza la selección. |

La selección permite limitar las ediciones a una parte del dibujo y proteger el resto. Es especialmente útil para corregir un objeto sin dañar el fondo o los elementos vecinos.

---

## 6. Capas y organización

| Operación | Qué hace |
|---|---|
| `layer.add` | Crea una capa. |
| `layer.select` | Establece la capa activa. |
| `layer.move` | Cambia su posición/orden en la pila. |
| `layer.rename` | Cambia su nombre. |
| `layer.set_opacity` | Ajusta la opacidad. |
| `layer.set_visibility` | Muestra u oculta la capa. |
| `layer.set_locked` | Bloquea o desbloquea la capa. |
| `layer.duplicate` | Duplica una capa. |
| `layer.delete` | Elimina una capa. |

Las capas permiten separar fondo, personaje, accesorios, sombras, efectos y detalles. Esta separación hace que las correcciones sean localizadas y reversibles.

Al cambiar la pila de capas, la integración de animación sincroniza las identidades y el orden de las capas con los cels. El agente debe verificar el timeline después de cambios estructurales.

Límite: 64 capas. No borrar ni reemplazar una capa de referencia o una capa de trabajo sin comprobar primero su uso en los frames.

---

## 7. Historial y reversión

- `history.undo`: deshace una operación raster/de workspace.
- `history.redo`: rehace una operación raster/de workspace.
- `animation.undo`: revierte el último cambio de timeline dentro del historial de animación.
- `animation.redo`: reaplica un cambio de timeline revertido.

El historial de animación conserva hasta 100 pasos y está sujeto a un presupuesto de 16 MiB. Una nueva edición después de deshacer limpia la rama de redo. La aprobación/descartado y la sincronización de origen reinician el historial de animación del sandbox.

**Uso recomendado:** antes de una corrección arriesgada, inspeccionar y obtener el estado de referencia; después de aplicar el cambio, comprobar el diff. Undo/redo son herramientas de recuperación local, no sustitutos de la revisión de propuesta.

---

## 8. Inteligencia de dibujo, referencias y continuidad

Headless integra operaciones de inteligencia de dibujo para consultar y conservar contexto:

| Operación | Qué aporta |
|---|---|
| `drawing.motion.analyze` | Compara dos frames/cels y analiza el movimiento entre ellos. |
| `drawing.reference.extract_line_guide` | Extrae una guía de líneas desde una referencia. |
| `drawing.reference.create` | Crea una entrada de referencia a partir del contenido proporcionado. |
| `drawing.reference.package_current` | Empaqueta el proyecto actual como referencia inmutable y prepara un editor limpio. |
| `drawing.reference.list` | Lista las referencias. |
| `drawing.reference.get` | Recupera una referencia concreta. |
| `drawing.reference.apply` | Aplica una referencia al contexto de trabajo según el contrato vigente. |
| `drawing.reference.copy_part` | Copia una parte de referencia a la capa activa del frame activo. |
| `drawing.reference.copy_frame` | Compone las capas visibles de un frame de referencia y copia el resultado a la capa activa. |
| `drawing.reference.remove` | Elimina una entrada de referencia. |
| `drawing.environment_history.record` | Registra un estado contextual del entorno de dibujo. |
| `drawing.environment_history.get` | Lee un registro contextual. |
| `drawing.environment_history.list` | Lista registros contextuales. |
| `drawing.layer.role.set` | Asigna el rol semántico de una capa. |
| `drawing.layer.context.set` | Guarda contexto adicional de una capa. |

### Contrato especial de Reference Center

- El origen de la referencia permanece inmutable.
- `copy_part` reemplaza los píxeles de la **capa actualmente activa en el frame actualmente activo** con los píxeles de la parte seleccionada.
- `copy_frame` compone las capas visibles de la referencia respetando visibilidad, opacidad y alfa, y reemplaza los píxeles de esa misma capa activa.
- Estas operaciones no crean, eliminan, duplican ni reordenan capas.
- El timeline no se cierra ni se reinicia; se actualiza el cel activo.
- La copia es independiente: no queda un enlace vivo con la referencia original.

### Empaquetar el proyecto actual como referencia

`drawing.reference.package_current` crea una instantánea inmutable del proyecto actual en Reference Center y prepara un lienzo limpio con una capa base. El resultado incluye el ID de la referencia, revisión de origen, dimensiones, cantidad de capas/frames y estado del editor limpio. Es útil para conservar una versión de referencia antes de iniciar una variación o una nueva escena.

### Analizar movimiento

`drawing.motion.analyze` recibe `beforeIndex`, `afterIndex`, y opcionalmente `layerId` y `gridStep` (por defecto 8). Compara el cel de una capa concreta o el compuesto de los frames. Sirve para detectar desplazamientos y cambios entre poses. No reemplaza la inspección visual humana/agente: el análisis numérico es apoyo para detectar problemas, no un juicio completo de calidad artística.

---

## 8.1. Herramientas geométricas y de precisión delegadas a AICommandSession

Además de las operaciones declaradas en `HEADLESS_CAPABILITIES`, `HeadlessEditorRuntime.execute()` delega operaciones estructuradas a `AICommandSession`. No son llamadas arbitrarias de código: son acciones nombradas y validadas que trabajan sobre el sandbox.

### Construcción y transformación geométrica

| Acción | Para qué sirve |
|---|---|
| `geometry.point` | Construir un punto. |
| `geometry.line` | Construir una línea a partir de extremos. |
| `geometry.rect` | Construir un rectángulo. |
| `geometry.ellipse` | Construir una elipse. |
| `geometry.polygon` | Construir un polígono regular. |
| `geometry.star` | Construir una estrella. |
| `geometry.bezier` | Construir una curva Bézier. |
| `geometry.path` | Construir un path desde comandos. |
| `geometry.roundedRect` | Construir un rectángulo redondeado. |
| `geometry.arc` | Construir un arco circular. |
| `geometry.circle3` | Construir un círculo a través de tres puntos. |
| `geometry.translate` | Trasladar un objeto. |
| `geometry.scale` | Escalar un objeto respecto de un centro. |
| `geometry.rotate` | Rotar un objeto respecto de un centro. |
| `geometry.polarArray` | Generar una matriz circular/polar de objetos. |
| `geometry.gridArray` | Generar una matriz en filas y columnas. |
| `geometry.add` | Insertar un objeto en el modelo vectorial. |
| `geometry.update` | Actualizar un objeto existente por ID. |

### Medición, construcción y análisis geométrico

El runtime también ofrece acciones para:
- calcular límites y medidas: `geometry.bounds`, `geometry.measure`, `geometry.measureBetween`, `geometry.objectMetrics`;
- proyectar puntos y encontrar intersecciones: `geometry.project`, `geometry.intersection`, `geometry.circleLineIntersections`, `geometry.tangentLinesToCircle`;
- construir referencias geométricas: `geometry.coordinateFrame`, `geometry.toLocal`, `geometry.toWorld`, `geometry.polarPoint`, `geometry.angleBisector`, `geometry.perpendicularThrough`, `geometry.parallelThrough`, `geometry.divideSegment`, `geometry.circumcenter`, `geometry.triangleCenters`;
- analizar curvas: `geometry.bezierPoint`, `geometry.bezierTangent`, `geometry.bezierCurvature`, `geometry.bezierSplit`, `geometry.bezierContinuity`, `geometry.bezierSample`, `geometry.fitPolyline`, `geometry.reversePath`, `geometry.pathLength`;
- operar con formas: `geometry.boolean` (operación booleana entre polígonos);
- alinear y distribuir: `geometry.nearest`, `geometry.edgeAlign`, `geometry.distribute`, `geometry.symmetry`, `geometry.smartSnap`, `geometry.snapAxis`;
- diagnosticar y comparar: `geometry.diagnose`, `geometry.diff`, `geometry.intentPlan`;
- generar guías: `guide.create`.

Estas acciones son útiles para ilustración vectorial precisa, construcción técnica, iconografía, diagramas, alineación, repetición de elementos, simetría y comprobación de geometría. Los argumentos específicos se validan por acción; por ejemplo, `geometry.line` acepta extremos `a`/`b` o coordenadas `x1,y1,x2,y2`, y las formas aceptan un objeto `style`.

### Escena de ilustración y flujo de calidad

Acciones disponibles en el ejecutor estructurado:
- `drawing.scene.normalize`: normaliza la descripción de una escena.
- `drawing.scene.validate`: valida la escena y devuelve errores y escena normalizada.
- `drawing.scene.compile`: compila la escena normalizada a la representación que consume el flujo.
- `drawing.workflow.start`: inicia un flujo de dibujo con `workflowId` opcional, `projectId` opcional, `stage` (por defecto `sketch`) y `minQualityScore` (por defecto 0.8).
- `drawing.workflow.set_scene` / `drawing.workflow.get_scene`: asigna/lee la escena del flujo.
- `drawing.workflow.get_state`: devuelve el estado actual.
- `drawing.workflow.record_action`: registra una acción realizada.
- `drawing.workflow.visual_feedback`: adjunta feedback visual con `snapshotId`, resumen, métricas y calidad.
- `drawing.workflow.pause` / `drawing.workflow.resume`: pausa y reanuda el flujo.
- `drawing.workflow.correct`: registra/aplica una corrección con etapa, motivo y acciones.
- `drawing.workflow.advance`: avanza de etapa; exige quality gate y, por defecto, feedback.

El flujo de dibujo mantiene una puerta de calidad habilitada y un score mínimo configurable al iniciarlo. No sustituye la inspección visual real del agente ni convierte una puntuación en prueba automática de que el arte cumple el pedido.

### Límites de permiso de AICommandSession

El ejecutor rechaza explícitamente acciones de borrado, exportación, subida o publicación del proyecto como `project.delete`, `document.delete`, `project.export`, `document.export`, `canvas.export`, `project.upload` y `project.publish`. La exportación/transferencia debe seguir el procedimiento autorizado de propuestas y empaquetado externo.

---

## 9. Modelo vectorial y geometría

El documento vectorial vive dentro de `RasterDocument.vectorModel`. Por ello participa del mismo sandbox, diff, aprobación y serialización del proyecto que el contenido raster.

### Lectura y auditoría

- `vector.model.get`: devuelve el modelo vectorial editable, número de objetos y frames.
- `vector.audit`: devuelve el informe de auditoría del modelo.
- `vector.svg.export`: convierte el modelo vectorial a SVG y devuelve dimensiones y número de objetos.

### Configuración

- `vector.model.configure`: configura `grid` (1–4096), `snap` (booleano) y combina metadatos.
- `vector.precision.configure`: actualiza el objeto de configuración de precisión.
- `vector.frames.set`: reemplaza metadatos de frames vectoriales; admite hasta 240 entradas.

### Importar SVG

`vector.svg.import` acepta texto SVG de 1 byte a 2 MiB. Por defecto reemplaza los objetos del modelo; con `replace: false`, agrega los objetos importados al modelo existente. Se generan IDs nuevos para los objetos importados.

La validación rechaza contenido peligroso como DTD, entidades, scripts, `foreignObject` y URLs de recursos externos. No es un navegador SVG general ni un cargador de contenido remoto.

### Objetos vectoriales

Tipos admitidos: `rect`, `ellipse`, `line`, `path`, `text` y `group`.

| Operación | Función |
|---|---|
| `vector.object.create` | Crea un objeto; opcionalmente permite indicar posición de inserción `index`. |
| `vector.object.update` | Actualiza propiedades mediante `patch`; no puede cambiar el ID ni el tipo. |
| `vector.object.delete` | Elimina un objeto por `object_id`, incluso si está dentro de un grupo. |
| `vector.object.duplicate` | Duplica un objeto/grupo y genera IDs nuevos para él y sus hijos. |
| `vector.object.reorder` | Reordena un objeto de nivel superior. |
| `vector.object.transform` | Aplica transformaciones `x`, `y`, `rotation`, `scaleX`, `scaleY`, `skewX`, `skewY`. |
| `vector.group.create` | Agrupa al menos dos objetos de nivel superior. |
| `vector.group.ungroup` | Desagrupa un grupo. |

El modelo admite hasta 10.000 objetos y 16 MiB serializados. Los IDs deben ser únicos incluso entre hijos anidados. La geometría debe contener valores finitos. La auditoría devuelve advertencias (por ejemplo, geometría fuera del canvas) y errores fatales que bloquean la mutación.

Las propiedades exactas de cada tipo de objeto y de los parches se definen por el esquema del modelo vectorial. El agente debe consultar `vector.model.get`, usar ejemplos válidos y ejecutar `vector.audit` después de cambios complejos.

---

## 10. Animación y timeline

Headless puede crear y editar una animación basada en frames y cels RGBA, sincronizada con la pila de capas del documento.

### Parámetros globales

| Operación | Parámetros confirmados | Resultado |
|---|---|---|
| `animation.get_summary` | ninguno | FPS, loop, velocidad, frames, capas, frame activo, memoria y duración total. |
| `animation.set_fps` | `fps`: entero 1–60 | Cambia FPS y recalcula duración por frame conforme al modelo. |
| `animation.set_loop` | `loop`: booleano | Activa/desactiva repetición. |
| `animation.set_playback_speed` | `speed`: valor validado por el runtime | Cambia velocidad de reproducción configurada. |

La velocidad de reproducción es metadato de timeline; el runtime Headless no reproduce en tiempo real ni mantiene un reloj de animación.

### Crear frames

- `animation.frame.add_from_layer`: crea un frame usando los píxeles de la capa indicada o activa.
- `animation.frame.capture_composite`: captura el compuesto de las capas del documento.
- `animation.frame.capture_document`: captura las capas del documento en el frame.
- Las tres aceptan `layerId` opcional según el tipo, `durationMs` opcional y `frameName` opcional. El nombre se limita a 120 caracteres.
- Al crear un frame posterior al primero, el runtime duplica el frame activo como base y luego actualiza los píxeles según la operación. Esto facilita continuar una pose sin rehacer todas las capas.
- Al crear o duplicar frames, el resultado puede incluir `previousFrameContext` para inspeccionar el frame/cel previo y mantener continuidad.

### Editar estructura y timing

| Operación | Parámetros confirmados | Qué hace |
|---|---|---|
| `animation.frame.duplicate` | `index` opcional; por defecto frame activo | Duplica el frame. |
| `animation.frame.delete` | `index` opcional | Elimina el frame. |
| `animation.frame.reorder` | `from`, `to` | Mueve un frame a otra posición. |
| `animation.frame.set_duration` | `index` opcional, `durationMs` | Cambia duración de un frame. |
| `animation.frame.set_active` | `index` | Selecciona el frame activo. |

### Leer y modificar cels

| Operación | Parámetros confirmados | Función |
|---|---|---|
| `animation.frame.get_cel` | `index` opcional, `layerId` | Devuelve píxeles RGBA en Base64 y dimensiones. |
| `animation.frame.set_cel` | `index` opcional, `layerId`, `pixels` Base64 | Reemplaza los píxeles del cel; la longitud debe coincidir con canvas × 4 canales. |
| `animation.frame.get_context` | `index` opcional, `layerId` opcional | Devuelve frame actual, capa, cel y compuesto actual, frame previo y guía para continuidad. |
| `animation.frame.get_onion_skin` | `previous` opcional (default 1), `next` opcional (default 0) | Devuelve frames vecinos para comparar poses. |
| `animation.frame.get_composite` | `index` opcional | Devuelve el compuesto RGBA del frame respetando visibilidad/opacidad de capas. |

### Validación de timeline

- FPS: 1–60.
- Máximo: 240 frames.
- La identidad y el orden de `layerIds` del timeline deben coincidir con las capas del documento.
- Las dimensiones de los cels deben coincidir con el canvas.
- Los nombres de frame, si se indican, no pueden superar 120 caracteres.
- El resumen informa duración total, duración individual, frame activo y memoria estimada.
- Si se recorta un proyecto animado con `canvas.crop`, Headless bloquea la operación: habría que aplicar el mismo recorte a todos los cels para no dejar dimensiones inconsistentes. El agente debe usar un procedimiento de transformación compatible con todos los frames.

### Corrección incremental de animación

La animación es editable por cel y capa. Por tanto, si el agente detecta un brazo mal dibujado en tres frames, una pose incoherente o un timing incorrecto, puede modificar únicamente esos cels o duraciones, revisar los frames vecinos y volver a exportar. No es necesario empezar de cero por defecto.

Para mantener continuidad:
1. leer `animation.get_summary`;
2. obtener `animation.frame.get_context` para el frame/layer objetivo;
3. inspeccionar onion skin y frame previo;
4. modificar solo el cel necesario;
5. comprobar el compuesto;
6. revisar el diff de timeline;
7. repetir con los frames vecinos si corresponde.

---

## 11. Diff, inspección y revisión de cambios

`runtime.inspect()` expone:

- documento fuente: ID, nombre, dimensiones, revisiones y capas;
- estado del sandbox: dimensiones, cantidad de capas y si hay cambios;
- conteo y auditoría de objetos vectoriales;
- resumen de la propuesta pendiente;
- resumen del timeline y si tiene cambios;
- objeto completo de capacidades y límites.

`runtime.getDiff()` informa:

- cantidad total de píxeles cambiados;
- píxeles cambiados en raster y animación por separado;
- límites/bounding box del cambio raster;
- mapa/datos de píxeles del diff;
- si cambió el modelo vectorial, conteo de objetos anterior y nuevo, y auditoría;
- frames/cels añadidos, eliminados, modificados o reordenados;
- cantidad de cels y píxeles modificados;
- cambios de FPS, loop, velocidad y frame activo;
- duración anterior/nueva por frame cuando cambia.

Esto permite revisar el alcance de una modificación antes de aceptarla. Un diff pequeño no garantiza calidad visual; el agente debe inspeccionar la evidencia visual real.

---

## 12. Reglas para lotes de operaciones

`executeBatch(actions)` acepta de 1 a 500 acciones y las ejecuta en orden. Se detiene ante el primer fallo.

Buenas prácticas:

- Agrupar operaciones independientes para reducir llamadas.
- Separar en lotes distintos los pasos que dependen de inspeccionar un resultado intermedio.
- Leer el contexto antes de editar cuando hay riesgo de reemplazar contenido.
- No enviar 500 operaciones solo porque el límite lo permite; mantener lotes comprensibles y revisables.
- Si un paso falla, no asumir que los siguientes se ejecutaron.
- Tras el lote, ejecutar `inspect()` y `getDiff()` antes de crear la propuesta.

---

## 13. Importación, exportación y formatos

Headless opera sobre el documento nativo PixelForge. El formato de proyecto serializado incluye raster, modelo vectorial y animación. La integración de CodeLab puede envolver ese documento en un paquete de proyecto para transporte/importación.

El catálogo actual documenta un ZIP editable PixelForge con:
- `project/<name>.pforge`: JSON canónico con capas raster, vector model y cels de animación;
- `manifest.json`;
- `README.txt`;
- `frames/frame-0001.png` y siguientes, compuestos transparentes en orden de reproducción.

El ZIP es también un paquete válido para Video Composer. El importador exige un manifiesto `pixelforge-video-package` versión 1 con dimensiones y cantidad de frames coincidentes.

### Restricciones del importador ZIP documentado

- Solo entradas ZIP sin compresión (STORE).
- Rechaza cifrado, multi-disco, data descriptors, ZIP64 y DEFLATE.
- Máximo 512 entradas y 256 MiB descomprimidos.
- JSON del proyecto limitado a 96 MiB.
- Valida rutas, nombres duplicados, directorio local/central, CRC-32, esquema, longitudes raster, modelo vectorial y timeline.
- Importar crea un ID de proyecto nuevo y revisión 1; no sobrescribe proyectos existentes.

Los artefactos grandes se transportan por chunks de 1 MiB con SHA-256 por chunk y global. Esta transferencia pertenece al cliente/bridge de CodeLab, no al Headless aislado.

**Importante:** no confundir el ZIP `.pforge` del catálogo de PixelForge con el paquete `.codelab` requerido por otros flujos de CodeLab. El agente debe seguir el formato que exija el flujo de entrega concreto y no renombrar archivos para simular compatibilidad.

---

## 14. Qué se hace fuera de Headless

| Necesidad | Responsable |
|---|---|
| Instalar runtime y editar documento | Headless propio del agente |
| Crear diff/propuesta y aceptar cambios en memoria | Headless |
| Guardar revisión autenticada en CodeLab/Neon | Integración/worker autorizado |
| Transferir paquete por HTTPS inline bridge | Agente IA fuera de Headless |
| Abrir interfaz real de PixelForge en Chromium | Capturador/runner de navegador |
| Capturar pantalla de editor real | Herramienta de navegador |
| Video Composer, playback real y captura WebM | Video Composer / Playwright |
| Codificar y recuperar vídeo final A/B | Pipeline de vídeo A/B |
| Inspeccionar el vídeo final y compararlo con requisitos | Agente IA |
| Entregar proyecto/vídeo al usuario | Agente IA |

Headless no puede, por sí solo, afirmar que un proyecto ya está persistido en CodeLab ni que el vídeo final se ha generado. Esas verificaciones ocurren fuera del runtime.

---

## 15. Seguridad y límites de confianza

- No entregar a Headless secretos, claves de proveedor, tokens, cookies, `DATABASE_URL`, credenciales Neon o S3.
- No habilitar llamadas de red al bridge desde Headless.
- No insertar scripts ni recursos remotos en el modelo vectorial. El validador rechaza URLs externas/ejecutables en estilos y gradientes.
- La importación SVG bloquea DTD, entidades, scripts, `foreignObject` y recursos externos.
- No serializar un sandbox con cambios no revisados: `toJSON()` rechaza cambios o propuestas pendientes.
- No aceptar una propuesta sin revisar su diff y sin comprobar que corresponde a la revisión base correcta.
- No usar Neon production para pruebas de persistencia. Usar base temporal/aislada.
- No confundir éxito de operación, aprobación local, persistencia del servidor y entrega final: son estados distintos.

---

## 16. Flujo recomendado por tipo de trabajo

### Crear un dibujo o sprite
1. Crear/abrir runtime.
2. Inspeccionar resumen, dimensiones, paleta y capas.
3. Crear capas con roles claros.
4. Dibujar por regiones/operaciones.
5. Revisar píxeles y composición.
6. Obtener diff, propuesta y aprobación.
7. Exportar y persistir mediante el flujo externo.

### Corregir un dibujo existente
1. Abrir la última revisión válida.
2. Inspeccionar capas y región afectada.
3. Crear selección si conviene limitar el cambio.
4. Aplicar una corrección localizada.
5. Comparar diff y revisar el resultado.
6. Conservar el resto del documento sin cambios.
7. Aprobar, exportar y persistir nueva revisión.

### Crear o reparar animación
1. Leer resumen de timeline y capas.
2. Consultar frame/cel previo.
3. Crear o duplicar el frame de trabajo.
4. Editar el cel afectado, respetando el orden de capas.
5. Usar onion skin y análisis de movimiento como apoyo.
6. Revisar duración, FPS, loop y continuidad.
7. Comparar diff por frame/cel.
8. Aprobar, exportar y persistir.
9. Si se solicitó vídeo, ejecutar A/B después de persistir y revisar el archivo final.

### Crear o reparar arte vectorial
1. Leer el modelo y ejecutar auditoría.
2. Crear/importar objetos vectoriales.
3. Ajustar propiedades, transformaciones, grupos y orden.
4. Volver a auditar.
5. Revisar diff y propuesta.
6. Aceptar y persistir la revisión.

---

## 17. Límites de cobertura: no prometer lo que no está implementado

- El catálogo de operaciones es la lista de capacidades registradas en `HEADLESS_CAPABILITIES`; no significa que cualquier herramienta de la interfaz web esté disponible en Headless.
- Headless es determinista y no depende de un proveedor IA. La generación basada en APIs de proveedores es una capacidad separada y debe usar las claves propias del usuario a través del flujo autorizado.
- El runtime no renderiza una interfaz DOM ni reproduce una animación con reloj real.
- Las opciones exactas de cada operación raster deben consultarse en el contrato/validador de la versión instalada. Este documento evita inventar argumentos que no aparecen en el catálogo público.
- Las operaciones de Reference Center tienen el destino de copia limitado a la capa activa del frame activo.
- El recorte de una animación se bloquea para evitar cels con dimensiones inconsistentes.
- El ZIP importador descrito acepta STORE, no DEFLATE.
- La captura del escritorio externo mediante `getDisplayMedia` requiere gesto y permiso real del usuario; no se simula desde el agente.

Si una capacidad cambia en el código, actualizar en el mismo cambio este documento, `CODELAB-PIXELFORGE-COMMAND-CATALOG.md`, las pruebas de contrato y el índice documental.

---

## 18. Archivos fuente y documentación relacionada

- `public/pixelforge/src/headless.js` — runtime, capacidades, sandbox, propuestas, diff y API pública.
- `public/pixelforge/src/animation.js` — timeline, frames, cels, validación, resumen y exportación de sprite sheet.
- `public/pixelforge/src/drawing-intelligence.js` — modelo de dibujo, referencias y análisis de movimiento.
- `public/pixelforge/src/vector-studio.js` — modelo vectorial, auditoría, importación/exportación SVG.
- `public/pixelforge/src/core.js` — documento raster y primitivas de edición.
- `docs/CODELAB-PIXELFORGE-COMMAND-CATALOG.md` — comandos mailbox y catálogo de operaciones.
- `docs/HEADLESS-AGENT-RUNTIME.md` — instalación y ejecución del Headless propio.
- `docs/ANIMATION-AUTONOMOUS-WORKFLOW.md` — flujo de animación, inspección y reparación incremental.
- `docs/VIDEO-PROCESSING-AB.md` — generación, inspección y entrega de vídeo final.
- `docs/inline-artifact-bridge.md` — transporte del proyecto editable fuera de Headless.
