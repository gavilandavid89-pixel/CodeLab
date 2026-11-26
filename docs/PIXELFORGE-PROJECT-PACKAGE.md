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
    │   └── entorno.tscn             # documento completo: capas + timeline + frames
    ├── Efectos/
    │   └── efectos.tscn             # documento completo e independiente
    ├── Detalles/
    │   └── detalles.tscn            # documento completo e independiente
    ├── Elementos/
    │   └── elementos.tscn           # documento completo e independiente
    ├── Objetos/
    │   └── objetos.tscn             # documento completo e independiente
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

## 4. Instancias de escena: Entorno, Efectos, Detalles, Elementos y Objetos

Estas cinco carpetas **no son bibliotecas de PNG ni filtros que apuntan a capas del lienzo principal**. Cada una representa una instancia de trabajo PixelForge independiente, capaz de guardar un dibujo estático o una animación completa.

| Carpeta y archivo | Instancia |
|---|---|
| `Entorno/entorno.tscn` | Proyecto/escena editable de entorno, con frames y capas propios |
| `Efectos/efectos.tscn` | Proyecto/escena editable de efectos, con frames y capas propios |
| `Detalles/detalles.tscn` | Proyecto/escena editable de detalles, con frames y capas propios |
| `Elementos/elementos.tscn` | Proyecto/escena editable de elementos, con frames y capas propios |
| `Objetos/objetos.tscn` | Proyecto/escena editable de objetos, con frames y capas propios |

### 4.1 Cada sección es un documento PixelForge completo

Cada manifiesto `.tscn` es JSON CodeLab y contiene el campo `workspace`, que guarda un documento nativo completo `pixelforge-project` e independiente. `workspace.layers[]` conserva las capas y sus píxeles; `workspace.animation.frames[]` conserva los frames y sus cels por capa. `data` queda reservado para metadatos propios de la sección. Su carga útil debe preservar, como mínimo:

- Identidad de la instancia, nombre, dimensiones y configuración del lienzo.
- Una pila ordenada de capas con IDs estables, nombres, píxeles RGBA, posición, escala, rotación/ángulo, opacidad, visibilidad, bloqueo, blend mode, máscaras, clipping, referencias, assets y metadatos.
- Una línea de tiempo propia: frames ordenados, IDs, nombres, duración por frame, cels por capa, frame activo, FPS, loop y velocidad de reproducción.
- Paleta, modelo de dibujo, objetos, modelo vectorial, transformaciones y cualquier dato editable que el documento PixelForge principal pueda contener.
- Referencias a recursos y sus rutas/bytes, sin aplanar la escena.

El contrato de frame y capa descrito en la sección 3 se aplica también a cada frame y capa de estas cinco instancias. No se crea un esquema reducido especial para Entorno, Efectos, Detalles, Elementos u Objetos.

Una sección sin contenido puede estar vacía, pero cuando se guarda una instancia debe contener todos los datos necesarios para reconstruirla sin consultar el lienzo principal ni inferir información. Una instancia con un solo dibujo sigue teniendo un frame y su pila de capas; una instancia animada conserva todos sus frames y cels.

### 4.2 Organización interna del ZIP

En la versión 2 del manifiesto de sección, la instancia completa vive dentro del campo `workspace` de su archivo `.tscn`. Los píxeles RGBA se serializan como datos de píxeles del documento nativo, y cada frame guarda sus cels asociados a los IDs de capa. No se generan PNG como sustitutos de las instancias ni se necesita un segundo ZIP dentro de cada carpeta.

Ejemplo conceptual del contenido de `Entorno/entorno.tscn`:

~~~json
{
  "format": "codelab-pixelforge-scene",
  "version": 2,
  "sceneType": "environment",
  "projectId": "id-del-proyecto-principal",
  "workspace": {
    "format": "pixelforge-project",
    "id": "id-independiente-del-entorno",
    "name": "Pelota animada",
    "width": 128,
    "height": 128,
    "layers": ["capas completas con sus píxeles y propiedades"],
    "animation": {
      "fps": 12,
      "activeFrameIndex": 0,
      "frames": ["frames completos con un cel por capa"]
    }
  },
  "data": {}
}
~~~

El ejemplo omite los bytes y campos internos por brevedad; el archivo real conserva el documento nativo completo. Los otros cuatro `.tscn` usan la misma estructura y solo cambia `sceneType`. `integrity.json` protege cada manifiesto de sección, incluida toda la información de su `workspace`. No se permite sustituir ese documento por una imagen compuesta ni por una miniatura.

### 4.3 Independencia y round-trip

Las capas y frames de una instancia no se deducen de `drawingModel.layerRoles`, ni se reconstruyen filtrando IDs del documento principal. Cada sección conserva su propia pila de capas y su propia animación. `layerRoles` puede servir como metadato/clasificación auxiliar, pero no sustituye el documento de la instancia.

Al exportar e importar, CodeLab debe reconstruir cada instancia con sus mismos IDs, orden de capas, píxeles, propiedades, frames, cels, duración, FPS, loop, referencias, modelos y recursos. Después de editar y volver a exportar, los mismos datos deben seguir presentes. El importador debe rechazar referencias a rutas inexistentes, IDs duplicados, cels faltantes, dimensiones incompatibles o datos incompletos; nunca debe inventarlos.

### 4.4 Contextos de edición en la UI, persistencia y pruebas

El editor PixelForge incluye un selector persistente con seis contextos: `Project` (lienzo principal) y los cinco workspaces `Environment`, `Effects`, `Details`, `Elements` y `Objects`. Cada sección se abre como un documento editable separado, con su propia dimensión de lienzo, pila de capas y timeline/cels. La primera apertura crea un lienzo transparente con las dimensiones del proyecto principal, una capa independiente y un frame/cel inicial; después, las dimensiones, capas, píxeles y animación se guardan por separado.

El estado vive en `drawingModel.sceneWorkspaceState`:

- `activeSection` identifica el contexto que está abierto.
- `parentWorkspace` conserva el documento principal mientras se edita una sección; queda vacío cuando `Project` es el contexto activo.
- `workspaces` contiene los documentos de las secciones que están en segundo plano. La sección activa se guarda como documento superior del proyecto, evitando duplicar su buffer de píxeles dentro de su propio registro.
- El cambio de contexto fuerza el guardado del documento actual y del nuevo antes de mostrar el cambio como terminado. Al recargar, se restaura el contexto activo y se conservan los demás.

La exportación de CodeLab Package escribe cada documento de sección en su manifiesto `.tscn`. El `project.json` conserva el contexto activo y el documento principal cuando corresponde, pero no duplica el registro completo de cinco workspaces. Al importar, el editor reconstruye el registro a partir de los manifiestos de sección.

La cobertura E2E de navegador abre y edita las cinco secciones, escribe píxeles distintos, verifica que no se mezclen, vuelve al proyecto principal y comprueba la persistencia después de cambiar de contexto y recargar. Las pruebas de paquete también verifican la exportación/importación de workspaces activos e inactivos. Cobertura principal: `tests/pixelforge-scene-workspaces.test.mjs`, `tests/pixelforge-codelab-package-browser.test.mjs` y `tests/pixelforge-integration.test.js`.

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
- materialization.copyPolicy = deep-copy indica que se copian los bytes/píxeles y metadatos necesarios sin mantener un vínculo vivo con la referencia. No significa crear una capa nueva: el destino siempre es la capa activa del frame activo.
- sourceProjectId y sourceRevision dan trazabilidad al proyecto/revisión de origen.

En la UI, **Package current** captura el documento y la animación en la referencia maestra, la registra en drawingModel.referenceCenter.entries y después limpia el lienzo de trabajo a una capa vacía Layer 1. La animación capturada queda en la referencia; el editor vuelve a una línea de tiempo estática. No es una operación de exportar PNG.

Al copiar una imagen o una parte, PixelForge reemplaza los píxeles de la capa activa del frame activo. Al copiar un frame completo de referencia, primero compone las capas visibles de la referencia respetando visibilidad, opacidad y alpha, y escribe el resultado en esa misma capa activa. En ambos casos el destino es único y fijo: la capa activa del frame activo; no hay selector de destino ni modalidad alternativa por capa de origen. La operación no crea capas, no elimina ni reordena capas existentes, no cambia sus IDs o propiedades, no cierra ni reinicia la animación y actualiza el cel del frame activo. La referencia maestra permanece inmutable. `deep-copy` describe la independencia de los píxeles copiados, no la creación de una capa nueva ni un vínculo vivo con la referencia.

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
| Índice de categorías | reference.center/reference.center |
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

**Limitación actual que no debe ocultarse:** este ZIP no incluye el marcador project.codelab-pixelforge, integrity.json, frames/frames.tscn ni reference.center/reference.center. Por eso no es el paquete CodeLab estructurado v2 y su parser no es el instalador estructurado. Sus PNG son composiciones de previsualización, no cels independientes editables. El documento .pforge sí contiene el modelo nativo serializado, sujeto a lo que HeadlessEditorRuntime.toJSON() preserve.

**Integración nativa disponible:** Video Composer también reconoce directamente el paquete estructurado CodeLab v2 `.codelab-pixelforge` (marcador raíz `project.codelab-pixelforge`). Para este formato, valida el paquete mediante `importPixelForgeCodeLabPackage()` y compone los cels del timeline nativo. Si el cel es `pixelforge-tiled-cel` v2, dibuja cada tile RGBA en la superficie de su capa; no requiere `cel.pixels` ni materializa un buffer RGBA completo por capa. Conserva `authoringMode` por frame/cel y usa sampling suave para Illustration y pixel-perfect para Pixel Art. El paquete legacy `pixelforge-video-package` sigue siendo un formato separado basado en PNG compuestos + manifiesto.

**Límite actual para tiled:** el paquete estructurado conserva proyecto sparse, animación tiled y recursos declarados, pero la ruta tiled no incluye todavía los cinco manifiestos de Scene Workspaces ni el Reference Center. El exportador reporta cero secciones/refs en ese caso; no inventa ni aplana esos datos.

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

Prueba de aceptación obligatoria: **exportar → importar → editar una capa/parte → guardar → exportar → importar otra vez**. Comparar datos nativos, no solo el aspecto de los PNG. Para la integración Video Composer, añadir además **paquete nativo → Video Composer → WebM** y verificar dimensiones, duración, sampling por modo y ausencia de deformación.

**Evidencia tiled (2026-11-26):** `tests/pixelforge-editor-visual-modes.e2e.test.mjs` cubre el flujo real de exportación ZIP desde un documento tiled 1024×1024, importación de vuelta al editor y posterior importación del mismo paquete en `video-composer.html`, donde verifica el píxel renderizado, Pixel Art sampling y descarga de un WebM VP8. El workflow `pixelforge-tiled-package-roundtrip` (run `45774472214`) pasó con 1 test y 0 fallos.

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
| ZIP de agente/Video Composer | pixelforge-agent-zip.mjs, tests/pixelforge-agent-zip.test.mjs, public/pixelforge/video-composer.js |
| ZIP de bajo nivel | public/pixelforge/src/zip-export.js, public/pixelforge/src/video-composer-core.mjs |

El exportador de referencia de Node se implementa en pixelforge-codelab-package.mjs. La interfaz PixelForge usa public/pixelforge/src/codelab-package.js: export-project genera .codelab-pixelforge e import-file reconoce el marcador raíz, valida integridad, reconstruye frames y referencias y guarda el documento con saveProject. El ZIP de Video Composer sigue siendo un formato separado para secuencias PNG de vídeo.

Si cambia un nombre de archivo, ruta, campo, límite o regla de instalación, actualizar este documento y las pruebas en el mismo cambio.

## 11. Modelo maestro de capas: contenido completo y composición

Una capa no es solamente un efecto, una máscara, un puntero o un contenedor vacío. La definición adoptada es que **una capa es una unidad gráfica completa, equivalente conceptualmente a otro frame superpuesto dentro del frame padre**.

Esto significa que una capa puede dibujar por sí misma y contener la información normal necesaria para reconstruir su contenido. Además, incorpora propiedades específicas para decidir cómo ese contenido se compone respecto de las capas inferiores.

### 11.1 Información normal que debe conservar una capa

Una capa debe conservar el mismo tipo de información gráfica fundamental que un frame. Como mínimo, el contrato debe poder representar:

- identidad y nombre;
- frame padre al que pertenece;
- índice/posición de la capa;
- píxeles y formato de píxel;
- dimensiones;
- colores y paleta;
- coordenadas y posición;
- escala;
- rotación;
- ángulo;
- opacidad;
- visibilidad;
- bloqueo;
- transformaciones;
- referencias utilizadas;
- assets y recursos;
- configuración;
- metadatos;
- y cualquier otro campo definido por el esquema maestro del frame.

El hecho de que una capa sea una capa **no elimina** estos campos. Por ejemplo, una capa de fondo puede contener todos sus píxeles y transformaciones; una capa de personaje puede contener sus propios píxeles; y una capa de efecto puede contener sus píxeles además de propiedades de composición.

Los estados explícitos siguen siendo obligatorios. `angle = 90°`, `angle = 0°`, `angle = inexistente` y `angle = no_aplicable` no deben tratarse como equivalentes si el contrato los distingue.

### 11.2 Propiedades adicionales de composición

Además de la información gráfica normal, una capa puede tener propiedades destinadas a su composición, por ejemplo:

- orden/z;
- modo de mezcla;
- blur/desenfoque;
- brillo;
- contraste;
- saturación;
- máscara;
- clipping/recorte;
- intensidad de efecto;
- composición respecto a otra capa;
- y otras propiedades que sean incorporadas formalmente al esquema maestro.

Estas propiedades no sustituyen los datos gráficos. `opacity = 40%` significa que el contenido de la capa se muestra con 40 % de opacidad; no significa que sus píxeles desaparezcan. Del mismo modo, `blur = 8px` modifica la forma en que se compone el contenido, pero no reemplaza el contenido raster de la capa.

## 12. Identidad de capa y pertenencia al frame

La convención legible propuesta para las capas es:

`layer<frameIndex>-<layerIndex>`

Ejemplos:

- `layer0-1` = capa 1 del frame 0.
- `layer0-2` = capa 2 del frame 0.
- `layer1-1` = capa 1 del frame 1.
- `layer3-4` = capa 4 del frame 3.

El primer número identifica el frame real al que pertenece la capa y el segundo representa su posición lógica dentro de ese frame.

Esta nomenclatura ayuda a que un agente o una persona pueda identificar rápidamente la relación. Sin embargo, la identidad estructural no debe depender exclusivamente del nombre: el contrato debe mantener una relación explícita equivalente a `parentFrameId` y un `index` para la posición actual.

Por ello conviene separar:

- `id` = identidad estable de la capa;
- `parentFrameId` = frame propietario;
- `index` = posición actual;
- `name` = nombre legible opcional;
- representación `layer<frame>-<index>` = convención humana útil.

Si una capa cambia de posición, su identidad estable no debe romper las referencias internas que apunten hacia ella.

## 13. Organización física de las capas

Como cada capa puede contener tanta información como un frame, no es conveniente introducir todos los datos de todas las capas dentro de un único `frame.json` gigante.

La organización recomendada es:

```text
Frames/
├── frames.tscn
├── frame-0000/
│   ├── frame.json
│   └── layers/
│       ├── layer0-1/
│       │   ├── layer.json
│       │   ├── pixels.rgba
│       │   ├── palette.json
│       │   ├── transform.json
│       │   ├── appearance.json
│       │   └── ...
│       ├── layer0-2/
│       │   └── ...
│       └── layer0-3/
│           └── ...
└── frame-0001/
    └── ...
```

`frame.json` funciona como índice y contexto del frame: identidad, dimensiones, relación temporal, lista de capas, orden y referencias a los datos de cada capa.

Cada `layer.json` contiene la identidad, pertenencia, índice y configuración estructural de su capa. Los datos pesados pueden permanecer separados.

Especialmente, los píxeles rasterizados deben mantenerse en archivos RGBA declarados, como `pixels.rgba`, en lugar de convertir un frame o una capa en un JSON enorme.

La separación física no cambia la semántica: **la capa sigue siendo una unidad gráfica completa aunque sus datos estén distribuidos en varios archivos**.

## 14. Orden, visibilidad y composición acumulativa

Las capas se componen de abajo hacia arriba. Por ejemplo:

```text
layer0-1  ← fondo
layer0-2  ← personaje
layer0-3  ← elementos
layer0-4  ← detalles/efectos
```

Al visualizar el frame, el resultado es la composición acumulada de esas capas.

Por defecto, las capas pueden permanecer visibles y permitir que las capas inferiores se vean mediante las zonas transparentes de las superiores. Esto permite construir una imagen progresivamente:

`fondo → personaje → elementos → detalles → efectos`.

Pero la visibilidad debe ser configurable. Una capa puede estar invisible sin ser eliminada:

```text
layer0-1 → visible
layer0-2 → visible
layer0-3 → invisible
layer0-4 → visible
```

En este caso `layer0-3` sigue existiendo, conserva sus píxeles y puede volver a activarse.

También debe ser posible configurar otras propiedades de composición para que una capa no tenga que afectar visualmente a las inferiores de la manera predeterminada.

## 15. Navegación y capa activa

El editor debe permitir saltar entre capas de un mismo frame.

Por ejemplo, si el usuario está dibujando en `layer0-2`, debe poder pasar directamente a `layer0-1`, `layer0-3` o `layer0-4`.

La capa activa determina el destino de las operaciones de dibujo. Cambiar de capa no debe fusionar, borrar ni sobrescribir automáticamente el contenido de las otras.

Esto es especialmente importante para evitar el problema de dibujar accidentalmente sobre la capa equivocada. La navegación debe poder hacerse hacia capas anteriores y posteriores y también mediante selección directa.

El editor debe tratar la selección de capa como estado explícito de edición, no como una consecuencia accidental del último objeto que se tocó.

## 16. Inserción de capas y desplazamiento de índices

Debe ser posible insertar una nueva capa entre dos capas existentes.

Si inicialmente existe:

```text
layer0-1
layer0-2
layer0-3
layer0-4
```

y el usuario solicita una nueva capa en la posición 3, el resultado lógico será:

```text
layer0-1
layer0-2
layer0-3  ← nueva capa
layer0-4  ← antes era la 3
layer0-5  ← antes era la 4
```

Por tanto, las capas que ocupaban las posiciones posteriores se desplazan consecutivamente.

El índice representa el orden actual. La identidad estable de una capa debe permanecer separada de ese índice para que una inserción no rompa referencias existentes.

Ejemplo conceptual:

```text
id = layer0-a8f31
parentFrameId = frame-0000
index = 3
```

Si se inserta otra capa delante, el `index` puede pasar a 4 sin cambiar el `id`.

Esto también permite reordenar capas sin perder su identidad.

## 17. Relación entre capas y frames

Un frame puede tener una o muchas capas:

```text
frame0
├── layer0-1
├── layer0-2
├── layer0-3
└── ...
```

Otro frame puede tener una cantidad diferente:

```text
frame1
├── layer1-1
└── layer1-2
```

La cantidad de capas no cambia la naturaleza del frame. Cada capa editable pertenece a un único frame padre.

El mismo contenido puede reutilizarse mediante una referencia o mediante una copia explícita, pero una capa editable no debe pertenecer simultáneamente a dos frames.

## 18. Capas como herramienta para construir fondos, personajes y elementos

Esta arquitectura permite separar visualmente una composición sin inventar escenas artificiales:

```text
Frame 0
│
├── layer0-1 → fondo
├── layer0-2 → personaje
├── layer0-3 → árbol/elemento
├── layer0-4 → detalles
└── layer0-5 → efectos
```

Cada una de esas capas puede ser dibujada y editada de manera independiente.

Esto es especialmente útil para fondos y personajes porque permite modificar el fondo sin tocar el personaje, modificar un personaje sin tocar los elementos y activar/desactivar efectos sin destruir el dibujo.

El agente debe preferir esta estructura cuando la operación solicitada sea naturalmente una composición por capas, en lugar de crear una nueva escena o mezclar contenido que debería permanecer separado.

## 19. Capas y Reference Center

Una capa puede utilizar una referencia del Reference Center, pero la relación no convierte una cosa en la otra:

```text
Reference Center
      ↓
reference.personaje1
      ↓
frame0
      ↓
layer0-2
```

La referencia es el recurso maestro reutilizable. La capa es el contenido editable dentro del frame. El frame es la unidad temporal/visual del lienzo.

Al copiar una referencia, sus píxeles se escriben en la capa activa del frame activo. Si el documento está animado, se actualiza el cel de esa capa en el frame activo; el timeline permanece abierto y no se reinicia. La capa existente conserva su ID, nombre, visibilidad, opacidad y bloqueo; no se crea, elimina, duplica ni reordena ninguna capa. La referencia maestra permanece intacta y la copia es una duplicación de píxeles, no un vínculo vivo con ella. `copy_part` reemplaza el contenido de la capa activa con los píxeles de la parte; `copy_frame` compone las capas visibles del frame de referencia y coloca ese resultado aplanado en la capa activa.

## 20. Relación con la organización por secciones

La separación existente entre `Entorno`, `Efectos`, `Detalles`, `Elementos` y `Objetos` continúa siendo válida.

Estas secciones describen categorías o roles del proyecto. Las capas de un frame describen cómo se compone el contenido visual en ese frame.

Por ejemplo, un elemento clasificado como `Objetos` puede terminar materializado en `layer0-3`. La sección indica la categoría del contenido; la capa indica dónde y cómo participa en la composición del frame.

Una capa no debe convertirse automáticamente en una sección ni una sección en una capa. Las relaciones entre ambos sistemas deben quedar explícitas.

## 21. Reglas maestras para agentes

Un agente que cree o modifique PixelForge debe respetar estas reglas:

1. No confundir `.tscn`, `.center` y `.reference`.
2. No convertir una capa en una referencia ni una referencia en un frame.
3. Tratar cada capa como una unidad gráfica completa y dibujable.
4. Conservar en la capa la información normal que requiere el modelo maestro del frame.
5. Añadir propiedades de composición sin eliminar los datos gráficos.
6. Mantener explícita la pertenencia de cada capa a su frame.
7. Mantener el orden de las capas.
8. Permitir saltar entre capas antes de dibujar.
9. Permitir insertar una capa entre dos existentes.
10. Desplazar los índices posteriores cuando se inserta una capa.
11. Mantener IDs estables cuando una capa cambia de posición.
12. No dibujar sobre otra capa por accidente.
13. No eliminar campos porque su valor sea actualmente `inexistente` o `no_aplicable`.
14. No inventar propiedades fuera del esquema maestro.
15. No introducir innecesariamente datos pesados dentro de JSON.
16. Mantener rutas y relaciones explícitas y verificables.
17. No modificar una referencia maestra al editar una copia materializada.
18. Validar la estructura editable, no solamente la imagen compuesta.

## 22. Ejemplo integral

```text
Frames/
└── frame-0000/
    ├── frame.json
    └── layers/
        ├── layer0-1/
        │   ├── layer.json
        │   └── pixels.rgba
        ├── layer0-2/
        │   ├── layer.json
        │   └── pixels.rgba
        ├── layer0-3/
        │   ├── layer.json
        │   └── pixels.rgba
        └── layer0-4/
            ├── layer.json
            ├── pixels.rgba
            └── effects.json
```

Interpretación:

- `layer0-1` contiene el fondo dibujable.
- `layer0-2` contiene el personaje dibujable.
- `layer0-3` contiene elementos adicionales.
- `layer0-4` contiene detalles/efectos y puede tener configuración de composición adicional.

El usuario puede seleccionar `layer0-2`, dibujar, saltar a `layer0-3`, dibujar allí, ocultar `layer0-3`, volver a mostrarla y regresar a `layer0-2` sin mezclar los píxeles.

## 23. Pruebas de aceptación específicas de capas

El ciclo de prueba debe comprobar no solo la imagen final sino la estructura editable.

Como mínimo debe comprobarse:

1. crear un frame con varias capas;
2. dibujar contenido diferente en cada capa;
3. cambiar la capa activa;
4. comprobar que dibujar en una capa no modifica otra;
5. ocultar y volver a mostrar una capa;
6. comprobar la composición acumulativa;
7. aplicar propiedades de composición sin perder los píxeles;
8. insertar una capa entre dos existentes;
9. verificar el desplazamiento de índices;
10. verificar que los IDs estables no se rompen;
11. reordenar capas;
12. guardar y exportar;
13. importar nuevamente;
14. comprobar frame padre, orden, píxeles, propiedades y metadatos de todas las capas.

Una prueba que solamente compare un PNG final no es suficiente para validar el modelo de capas.

## 24. Regla de cierre del modelo de capas

**Las capas son contenido gráfico completo, dibujable y editable, superpuesto dentro de un frame concreto.** Conservan la información normal del modelo de frame y añaden propiedades de composición. Cada capa tiene una pertenencia explícita a su frame, una posición lógica dentro de ese frame y una identidad estable para permitir inserciones y reordenamientos.

Esta regla permite construir fondos, personajes, elementos, detalles y efectos de forma independiente, saltar entre capas sin perder el contexto de dibujo y mantener la separación estructural que ya existe entre Frames, secciones del proyecto y Reference Center.

### Tiled layer sprite-sheet export

The editor exports tiled layers to the existing sprite-sheet ZIP format without converting each layer to a dense full-canvas buffer. It reads each layer in bounded 16-row RGBA strips and places those strips directly into the output PNG. The manifest records `storageMode: "tiled"` and the layer authoring mode; the PNG and manifest remain paired in the ZIP. The export is subject to a 16-megapixel output-surface limit (the shared layout helper additionally caps each side at 8192 pixels and total area at 64 megapixels).
