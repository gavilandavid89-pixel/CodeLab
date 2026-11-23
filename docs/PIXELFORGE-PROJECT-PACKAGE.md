# PixelForge: formato de proyecto, ZIP y Reference Center

**Estado:** documentación basada en el importador estructurado v2, el runtime Headless y las pruebas presentes en main. Distingue el paquete CodeLab estructurado del ZIP de agente/Video Composer. No son intercambiables.

## 1. Extensiones, marcadores y namespaces

Las extensiones y nombres estructurales no son decorativos: indican a qué sistema pertenece cada archivo y cómo debe interpretarlo CodeLab.

| Extensión / nombre | Significado |
|---|---|
| .codelab-pixelforge | Extensión canónica del paquete de proyecto CodeLab para PixelForge. |
| project.codelab-pixelforge | Marcador raíz obligatorio dentro del ZIP. Le dice a CodeLab que el paquete pertenece al editor PixelForge. |
| .tscn | Archivo estructural propio de CodeLab para contenido de escena/editor. No es una escena nativa de Godot en este formato. |
| .center | Identificador estructural del Reference Center. Lo que termina en .center se carga como contenido del centro de referencias, no como contenido del editor/lienzo. |
| .reference | Identificador de una referencia individual que vive dentro de una categoría del Reference Center. No es un frame. |
| .pforge | Documento nativo PixelForge serializado como JSON. En el ZIP de agente actual se guarda dentro de project/. |
| .json | Datos, índices y contratos auxiliares. Su significado depende del archivo que lo declare. |
| .rgba | Datos de píxeles RGBA8; no es una escena ni una referencia por sí mismo. |

Regla de interpretación: .tscn → editor/escena/lienzo; .center → Reference Center; .reference → referencia individual. CodeLab no debe cambiar de sistema basándose en el contenido interno o en un nombre parecido.

También se acepta el marcador heredado project.codelab, pero un paquete debe tener exactamente un marcador de editor en la raíz. Los marcadores project.codelab-web, project.codelab-design y project.codelab-pixelforge no se pueden mezclar. Un marcador dentro de una subcarpeta no cuenta.

Cambiar el nombre externo del ZIP no transforma su contenido. El paquete CodeLab estructurado y el ZIP pixelforge-video-package son formatos diferentes.

## 2. Paquete CodeLab estructurado v2: estructura canónica

El instalador installStructuredCodeLabV2 espera manifest.version = 2, schemaVersion = 2, layout = structured, editor = pixelforge y projectType = pixelforge. El manifiesto debe señalar un documento de integridad y, para PixelForge, los manifiestos de frames y Reference Center.

Estructura de referencia:

~~~text
mi-proyecto.codelab-pixelforge
└── ZIP
    ├── project.codelab-pixelforge   # marcador de editor; raíz
    ├── manifest.json                # contrato, versión y rutas
    ├── project.json                 # documento nativo PixelForge
    ├── integrity.json               # SHA-256 y tamaño de cada archivo protegido
    ├── Frames/
    │   ├── frames.tscn              # organiza la secuencia que va al lienzo
    │   ├── frame-0001/              # frame completo, ordenado por número
    │   │   ├── frame.json           # esquema completo del frame
    │   │   ├── pixels.rgba          # píxeles del frame, si existen
    │   │   └── ...                  # datos/recursos declarados por el esquema
    │   ├── frame-0002/
    │   │   ├── frame.json
    │   │   ├── pixels.rgba
    │   │   └── ...
    │   └── ...
    ├── Entorno/
    │   ├── entorno.tscn
    │   └── ...                      # datos propios de la sección
    ├── Efectos/
    │   ├── efectos.tscn
    │   └── ...
    ├── Detalles/
    │   ├── detalles.tscn
    │   └── ...
    ├── Elementos/
    │   ├── elementos.tscn
    │   └── ...
    ├── Objetos/
    │   ├── objetos.tscn
    │   └── ...
    └── reference.center/
        ├── reference.center
        ├── reference.personaje/
        │   ├── reference.personaje1/
        │   │   └── personaje.reference
        │   ├── reference.personaje2/
        │   │   └── personaje.reference
        │   └── ...
        ├── entorno.reference/
        │   ├── entorno.reference1/
        │   │   └── entorno.reference
        │   └── ...
        ├── elementos.reference/
        │   ├── elemento.reference1/
        │   │   └── elemento.reference
        │   └── ...
        ├── detalles.reference/
        │   ├── detalle.reference1/
        │   └── ...
        ├── objetos.reference/
        │   ├── objeto.reference1/
        │   └── ...
        └── efectos.reference/
            ├── efecto.reference1/
            └── ...
    ├── reference.escena/
    │   └── forest/
    │       ├── reference.json
    │       └── parts/
    │           └── background.rgba
    ├── assets/
    ├── fonts/
    ├── audio/
    ├── video/
    ├── models/
    └── project-files/
~~~

Esta es la estructura canónica del paquete PixelForge. Las seis carpetas son obligatorias en paquetes nuevos porque cada una contiene su manifiesto; las subcarpetas de recursos se incluyen cuando hay archivos. Todo recurso queda dentro de la carpeta de la sección a la que pertenece y se declara también en manifest.resources[] con su ruta exacta y destino. No mover recursos entre secciones renombrando solo el archivo.

Los archivos .tscn de este contrato son manifiestos JSON propios de CodeLab: frames.tscn describe el timeline y los otros cinco .tscn describen las secciones. No son escenas nativas de Godot. El formato TSCN de Godot tiene su propia gramática de escenas y recursos; la extensión por sí sola no convierte este manifiesto en un archivo Godot. [Documentación oficial del formato TSCN](https://docs.godotengine.org/en/latest/engine_details/file_formats/tscn.html).

### 2.1 manifest.json

Campos principales del contrato v2:

- format: codelab.
- version y schemaVersion: ambos 2.
- layout: structured.
- editor y projectType: ambos pixelforge.
- entry: normalmente project.json.
- integrityPath: ruta de integrity.json.
- frames.manifestPath: ruta del índice de frames; obligatorio para PixelForge.
- referenceCenter.manifestPath: ruta del índice de referencias; obligatorio para PixelForge.

El manifiesto identifica el editor. project.json conserva el documento editable e integrity.json permite comprobar que los archivos no cambiaron.

### 2.2 project.json

Es el documento nativo serializado. Contiene identidad/nombre del proyecto, dimensiones del canvas, capas, píxeles base64 y modelo de dibujo. En PixelForge también integra:

- animation: línea de tiempo reconstruida a partir de los cels externos.
- drawingModel.referenceCenter: referencias maestras importadas.
- drawingModel.packageResources y packageResources: catálogo de recursos con origen, destino, ruta canónica, tamaño y MIME.
- vectorModel: objetos y datos vectoriales cuando el proyecto los contiene.

No reemplazar project.json por una imagen PNG compuesta: eso elimina la estructura editable.

## 3. Animación: Frames/frames.tscn

Frames es contenido directo del editor/lienzo. Los frames no usan .reference y no pertenecen al Reference Center. frames.tscn organiza la secuencia y cada frame se resuelve por su número/índice.

### 3.1 Esquema maestro de cada frame

Cada frame debe seguir un esquema maestro fijo y completo. La presencia o ausencia de un dato no cambia la estructura: todos los frames conservan los mismos campos posibles y expresan el estado de cada dato mediante valores explícitos como un valor real, inexistente, no_aplicable o equivalente definido por el contrato.

El esquema debe contemplar toda la información que CodeLab pueda necesitar para reconstruir el frame, incluyendo como mínimo:

- identidad e índice del frame.
- dimensiones del canvas.
- píxeles y formato.
- colores/paleta.
- capas y orden de capas.
- coordenadas y posición.
- escala, rotación y ángulo.
- opacidad, visibilidad y bloqueo.
- transformaciones.
- referencias utilizadas.
- assets y rutas de recursos.
- configuración y metadatos.
- duración/tiempo y relación con la línea de tiempo cuando corresponda.

Por ejemplo, angle = 90° y angle = inexistente son estados distintos. El segundo no significa 0° ni dato perdido.

Cada capa del frame sigue el mismo principio: declara todos los campos que pueden ser necesarios para reconstruirla, aunque determinados valores sean inexistentes o no aplicables.

### 3.2 Organización de los datos

frame.json describe qué existe y cómo se relaciona; los datos pesados pueden vivir en archivos binarios o recursos separados y deben estar enlazados mediante rutas explícitas. La organización puede verse así:

~~~text
frame-0001/
├── frame.json
├── pixels.rgba
├── layers/
│   ├── layer-001/
│   │   └── pixels.rgba
│   └── layer-002/
│       └── pixels.rgba
└── assets/
    └── ...
~~~

La estructura interna concreta se determina por las rutas declaradas en frame.json, pero el principio es obligatorio: ningún frame debe quedar vacío o depender de que CodeLab invente información.

El índice declara:

- format = codelab-frames y version = 1.
- canvas.width y canvas.height, iguales a las dimensiones del proyecto.
- fps (1–60), activeFrameIndex, loop y opcionalmente playbackSpeed.
- frames[]: referencias ordenadas a los frames.

### 3.1 Esquema maestro de cada frame

Cada frame debe seguir **un esquema maestro fijo**. La presencia o ausencia de un dato no cambia la estructura: todos los frames conservan los mismos campos posibles y expresan el estado de cada dato mediante valores explícitos como un valor real, `inexistente`, `no_aplicable` o equivalente definido por el contrato.

El esquema debe contemplar toda la información que CodeLab pueda necesitar para reconstruir el frame, incluyendo como mínimo:

- identidad e índice del frame.
- dimensiones del canvas.
- píxeles y formato de píxeles.
- colores/paleta.
- capas y orden de capas.
- coordenadas y posición.
- escala, rotación y ángulo.
- opacidad, visibilidad y bloqueo.
- transformaciones.
- referencias utilizadas.
- assets y rutas de recursos.
- configuración y metadatos.
- duración/tiempo y relación con la línea de tiempo cuando corresponda.

Por ejemplo, `angle = 90°` y `angle = inexistente` son estados distintos. No se debe eliminar el campo `angle` del segundo frame solo porque no tenga un valor aplicable. Esto evita que el importador tenga que adivinar si un dato fue omitido intencionalmente, no existía o se perdió durante la exportación.

Cada capa del frame sigue el mismo principio: su contrato declara todos los campos que pueden ser necesarios para reconstruirla, aunque determinados valores sean inexistentes o no aplicables.

**Los frames no son referencias.** No usan `.reference` y no pertenecen al Reference Center. `Frames/frames.tscn` organiza el conjunto de frames que CodeLab coloca en la escena/lienzo, y cada frame se resuelve por su número/índice.

Reglas implementadas:

- 1–240 frames; hasta 64 capas.
- Cada frame debe contener exactamente un cel por cada ID de capa del proyecto; sin IDs desconocidos ni duplicados.
- Todas las dimensiones deben coincidir con el canvas.
- durationMs: 1–10.000 ms.
- Los archivos de píxeles deben declarar y cumplir el formato/dimensiones esperados.
- El presupuesto de memoria de píxeles de animación es 64 MiB.

Al instalar, los datos se convierten a la representación de animación de PixelForge, conservando IDs de capa, FPS, frame activo, loop, duración, cels y metadatos.

**No inferir frames por carpeta/extensión:** un recurso bajo assets/ o Reference Center no se convierte en frame por su nombre. Solo el mapeo explícito del contrato lo convierte en parte del frame.

## 4. Secciones de escena: Entorno, Efectos, Detalles, Elementos y Objetos

Además del timeline y del Reference Center, cada proyecto nuevo lleva cinco manifiestos de sección:

| Carpeta y archivo | Contenido |
|---|---|
| Entorno/entorno.tscn | Capas marcadas con role = environment, historial de entornos y datos propios de esa sección |
| Efectos/efectos.tscn | Capas marcadas con role = effect y datos explícitos de efectos |
| Detalles/detalles.tscn | Capas marcadas con role = detail y datos explícitos de detalles |
| Elementos/elementos.tscn | Referencias a objetos de dibujo/vector etiquetados explícitamente como elements |
| Objetos/objetos.tscn | Referencias a objetos de dibujo/vector etiquetados explícitamente como objects |

Cada archivo usa el contrato JSON CodeLab `codelab-pixelforge-scene` version 1: `sceneType`, `projectId`, `canvas`, `layerIds`, `drawingObjectIds`, `vectorObjectIds` y `data`. Entorno también conserva `environmentHistory`.

**No se clasifican cosas por adivinanza.** Las capas de Entorno/Efectos/Detalles se identifican mediante `drawingModel.layerRoles[layerId].role`. Elementos y Objetos solo incluyen objetos que ya llevan una etiqueta explícita `sceneSection`, `category` o `role` con el valor correspondiente. El contenido propio de cada sección se guarda en `drawingModel.sceneSections[section]` y se restaura al importar. Así, un objeto no termina en la carpeta equivocada por su nombre.

Los manifiestos apuntan a los IDs del documento nativo; no duplican la imagen compuesta. Los recursos binarios específicos se guardan debajo de su carpeta, por ejemplo `Efectos/assets/spark.png` o `Objetos/textures/metal.png`, y se declaran en `manifest.resources[]`. Si el paquete se importa, CodeLab conserva los bytes en `packageResourceFiles` para que un guardado y una exportación posteriores no los pierdan.

## 5. Reference Center: qué significa reference.personaje

**reference.personaje es el nombre de una carpeta de categoría**, no una propiedad JavaScript ni un comando. El prefijo reference. es el namespace que el instalador estructurado exige para las carpetas de categorías. El texto posterior al punto es el identificador de categoría:

- reference.personaje/ — personajes.
- reference.escena/ — escenas/entornos.
- reference.objeto/ — objetos/props.
- reference.efecto/ — efectos.

El id de categoría y el sufijo de carpeta son campos separados: el instalador valida que folder empiece por reference., pero no exige que el texto después del punto coincida con id. Conviene mantener una convención explícita, por ejemplo id = character y folder = reference.personaje, o id = personaje y folder = reference.personaje. Cada reference.json debe permanecer dentro de la carpeta que declara su categoría.

### 5.1 reference.center

reference.center identifica el contenido que debe cargarse en el Reference Center. No debe tratarse como una escena .tscn del editor. El sufijo .center es una señal estructural del sistema de referencias.

La jerarquía de categorías es explícita:
- reference.center/reference.personaje/reference.personaje1/ = referencia 1 de personaje.
- reference.center/entorno.reference/entorno.reference1/ = referencia 1 de entorno.
- reference.center/elementos.reference/elemento.reference1/ = referencia 1 de elementos.
- reference.center/detalles.reference/detalle.reference1/ = referencia 1 de detalles.
- reference.center/objetos.reference/objeto.reference1/ = referencia 1 de objetos.
- reference.center/efectos.reference/efecto.reference1/ = referencia 1 de efectos.

Un .tscn no debe sustituir estos identificadores.

`reference.center` identifica el contenido que debe cargarse en el **Reference Center**. No debe tratarse como una escena `.tscn` del editor.

La jerarquía de categorías es explícita. Por ejemplo:

- `reference.center/reference.personaje/reference.personaje1/` = referencia 1 de la categoría personaje.
- `reference.center/entorno.reference/entorno.reference1/` = referencia 1 de entorno.
- `reference.center/elementos.reference/elemento.reference1/` = referencia 1 de elementos.
- `reference.center/detalles.reference/detalle.reference1/` = referencia 1 de detalles.
- `reference.center/objetos.reference/objeto.reference1/` = referencia 1 de objetos.
- `reference.center/efectos.reference/efecto.reference1/` = referencia 1 de efectos.

La terminación `.center` tiene semántica propia: **Reference Center**. La terminación `.tscn` pertenece al contenido de escena/editor y no debe usarse para marcar una referencia del centro.

Cada referencia individual usa .reference y conserva el mismo principio de esquema completo que los frames: todos los campos posibles permanecen definidos y sus valores indican si el dato existe, no aplica o está ausente. Una referencia nunca debe convertirse en .tscn solo porque contenga información parecida a una escena.

El contrato del centro debe mantener categorías, IDs y rutas explícitas. CodeLab no debe decidir una categoría por el nombre de un archivo ni mover una referencia a `.tscn` solo porque contenga datos parecidos a una escena.

### 5.2 .reference y datos de cada referencia

Cada referencia declara identidad id, name, dimensiones width/height, parts[] y opcionalmente:

- type, version, createdAt, sourceRevision.
- frames[] para muestras/frames asociados.
- geometry y transform.
- palette, preview y notes.

Cada elemento de parts[] identifica un componente editable con id, name, role, pixelsPath, dimensiones opcionales, frameIndex, bounds, anchors, proportions, colorRoles y z.

Los píxeles se guardan fuera del JSON en archivos RGBA8 y se enlazan mediante pixelsPath. Por ejemplo, body.rgba puede ser el cuerpo y head.rgba la cabeza; los nombres son descriptivos, pero la identidad real se establece por id y por la ruta declarada.

### 5.3 Función dentro de PixelForge

Reference Center es una biblioteca de **referencias maestras inmutables**. Conserva diseños reutilizables (personajes, partes, objetos, efectos o escenas) sin que editar una copia destruya el original.

- immutableSnapshot: true conserva la referencia como snapshot.
- parts[] permite materializar partes por separado.
- frames[] / frameLayerMap[] conserva fotogramas y su relación con capas cuando la referencia procede de una animación.
- layerSnapshot[] conserva capas originales y sus píxeles.
- materialization.copyPolicy = deep-copy indica que al copiar se crea una copia editable independiente.
- sourceProjectId y sourceRevision dan trazabilidad al proyecto/revisión de origen.

En la UI, **Package current** captura el documento y la animación en la referencia maestra, la registra en drawingModel.referenceCenter.entries y después limpia el lienzo de trabajo a una capa vacía Layer 1. La animación capturada queda en la referencia; el editor vuelve a una línea de tiempo estática. No es una operación de exportar PNG.

Al pulsar una parte, PixelForge crea una capa nueva con sus píxeles. Al copiar un frame, reconstruye las capas de ese frame. La referencia original no se modifica. El Headless ofrece drawing.reference.package_current, drawing.reference.list, drawing.reference.get, drawing.reference.apply, drawing.reference.copy_part, drawing.reference.copy_frame y drawing.reference.remove.

**Diferencia importante:** las referencias de imagen simples importadas desde carpetas como reference/character/pose.png son recursos de imagen del Reference Center; no equivalen a una referencia estructurada reference.personaje/<id>/reference.json con partes RGBA editables. El importador legacy puede crear una tarjeta de imagen; el importador estructurado v2 reconstruye partes editables y sus metadatos.

Límites del Reference Center estructurado: hasta 256 partes por referencia y 16 MiB de píxeles RGBA8 incrustados en total.

## 6. Integridad y rutas

- integrity.json usa format = codelab-integrity, version = 1 y un mapa files.
- Para cada ruta protegida guarda sha256 y byteSize; el instalador recalcula ambos y rechaza discrepancias.
- Las rutas deben ser relativas y seguras; se rechazan rutas absolutas, segmentos . / .., entradas duplicadas y escapes del directorio del paquete.
- Los archivos referenciados por los manifiestos deben existir.
- No inventar rutas: primero se declara la ruta en el JSON/manifest y luego se incluye exactamente ese archivo en el ZIP.

## 7. Recursos y nombres

El instalador organiza recursos adicionales por declaración explícita manifest.resources[].destination; si no existe, utiliza segmentos de carpeta, alias semánticos, extensión y firma binaria. Prioridad:

1. manifest.resources[].destination.
2. Carpeta/alias semántico.
3. Extensión.
4. Firma binaria/encabezado.
5. project-files/ como destino genérico.

Destinos reconocidos incluyen reference-center, assets, scenes, animations, frames, audio, video, fonts, documents, models, textures, scripts, styles, components, templates, pages, exports, backups, data y project-files.

| Recurso | Ruta recomendada |
|---|---|
| Imagen de referencia suelta | reference-center/characters/pose.png |
| Parte editable de personaje | reference.personaje/hero/parts/body.rgba |
| Definición de esa referencia | reference.personaje/hero/reference.json |
| Índice de categorías | center.op/center.json |
| Índice de animación | Frames/frames.tscn |
| Datos de un frame/capa | Rutas declaradas por el esquema del frame |\n| Entrada del Reference Center | reference.center/reference.center |\n| Referencia individual | Ruta .reference dentro de reference.center |
| Fuente | fonts/brand.woff2 |
| Imagen auxiliar | assets/texture.png |

No renombrar un archivo aislado sin actualizar todas las referencias que lo apuntan y el hash correspondiente en integrity.json.

## 8. ZIP de agente/Video Composer actual: formato distinto

pixelforge-agent-zip.mjs exporta actualmente pixelforge-video-package v1. Su ZIP contiene:

~~~text
archivo.zip
├── manifest.json
├── README.txt
├── project/
│   └── <nombre-seguro>.pforge   # JSON nativo editable
└── frames/
    ├── frame-0001.png           # composición visual transparente
    ├── frame-0002.png
    └── ...
~~~

Su manifiesto declara format, version, dimensiones, fps, loop, frameCount, totalDurationMs, projectFile y frames[] con ruta/duración. El exportador valida el proyecto con HeadlessEditorRuntime, serializa el documento nativo en .pforge y genera PNG compuestos para la vista previa/Video Composer. Si existe vectorModel, rasteriza el overlay vectorial sobre la composición PNG; el modelo vectorial original permanece en el JSON nativo.

El parser valida manifiesto, dimensiones y frame count, carga el JSON .pforge, vuelve a normalizarlo con HeadlessEditorRuntime, asigna un ID nuevo y pone las revisiones de servidor en cero.

**Limitación actual que no debe ocultarse:** este ZIP no incluye el marcador project.codelab-pixelforge, integrity.json, frames/frames.tscn ni center.op/center.json. Por eso no es el paquete CodeLab estructurado v2 y su parser no es el instalador estructurado. Sus PNG son composiciones de previsualización, no cels independientes editables. El documento .pforge sí contiene el modelo nativo serializado, sujeto a lo que HeadlessEditorRuntime.toJSON() preserve.

Hasta que ambos flujos se integren explícitamente, no afirmar que un ZIP de Video Composer ha pasado el ciclo completo del paquete CodeLab .codelab-pixelforge.

## 9. Flujo de importación/edición/guardado y aceptación

Para el paquete estructurado v2, el comportamiento esperado es:

1. Reconocer exactamente un marcador raíz project.codelab-pixelforge (o el marcador legacy admitido).
2. Leer y validar manifest.json, project.json e integrity.json.
3. Instalar los cels declarados por frames/frames.tscn dentro de project.animation.
4. Instalar la entrada reference.center y las referencias .reference declaradas dentro de project.drawingModel.referenceCenter.
5. Resolver recursos adicionales y mantener packageResources y rutas de procedencia.
6. Hidratar el documento PixelForge real/Headless que utilizan las herramientas de edición, manteniendo el timeline v1 y el sidecar de metadatos por frame/capa.
7. Guardar por el mecanismo normal de persistencia del proyecto.
8. Exportar el paquete de nuevo, regenerando hashes y manifiestos.
9. Importar otra vez y comparar la semántica editable: capas, píxeles, IDs/referencias internas, animación, partes, metadatos y recursos.

Prueba de aceptación obligatoria: **exportar → importar → editar una capa/parte → guardar → exportar → importar otra vez**. Comparar datos nativos, no solo el aspecto de los PNG.

## 10. Código fuente y pruebas que son fuente de verdad

| Área | Código / prueba |
|---|---|
| Marcadores y nombre externo | codelab-project-artifact-import.mjs, tests/codelab-artifact-filename.test.mjs |
| Instalación ZIP y destinos de recursos | codelab-project-package-installer.mjs, tests/codelab-project-package-installer.test.mjs |
| Esquema estructurado v2, frames, cinco secciones y Reference Center | codelab-project-structured-format.mjs, tests/codelab-structured-project-v2.test.mjs |
| Modelo de dibujo y referencias | public/pixelforge/src/drawing-intelligence.js |
| Operaciones Headless de referencias | public/pixelforge/src/headless.js, tests/pixelforge-reference-center.test.mjs |
| UI del Reference Center | public/pixelforge/src/reference-center-ui.js |
| Exportador estructurado CodeLab v2 (Node) | pixelforge-codelab-package.mjs, tests/pixelforge-codelab-package.test.mjs |
| Importador/exportador real de la UI PixelForge | public/pixelforge/src/codelab-package.js, tests/pixelforge-codelab-package-browser.test.mjs |
| ZIP de agente/Video Composer | pixelforge-agent-zip.mjs, tests/pixelforge-agent-zip.test.mjs |
| ZIP de bajo nivel | public/pixelforge/src/zip-export.js, public/pixelforge/src/video-composer-core.mjs |

El exportador de referencia de Node se implementa en pixelforge-codelab-package.mjs. La interfaz PixelForge usa public/pixelforge/src/codelab-package.js: export-project genera .codelab-pixelforge e import-file reconoce el marcador raíz, valida integridad, reconstruye frames y referencias y guarda el documento con saveProject. El ZIP de Video Composer sigue siendo un formato separado para secuencias PNG de vídeo.

Si cambia un nombre de archivo, ruta, campo, límite o regla de instalación, actualizar este documento y las pruebas en el mismo cambio.
