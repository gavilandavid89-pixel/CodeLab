# Lector e importador de paquetes ZIP de CodeLab

Este documento describe los formatos que acepta el lector del backend y el ciclo de importación hacia los editores nativos. La extensión del archivo no determina el formato: el contenido ZIP, sus marcadores y el manifiesto son la autoridad.

## 1. Formatos compatibles

El importador reconoce dos generaciones de paquetes. No deben mezclarse sus reglas:

| Formato | Declaración | Marcador raíz | Datos de PixelForge |
|---|---|---|---|
| CodeLab v1 (legacy) | `format: "codelab"`, `version: 1` | `project.codelab` o marcador tipado del editor | `manifest.animation` con mapeo explícito de frames/cels |
| CodeLab v2 (estructurado) | `format: "codelab"`, `version: 2`, `schemaVersion: 2`, `layout: "structured"` | Marcador tipado, normalmente `project.codelab-pixelforge` para PixelForge | Manifiestos estructurados de frames, escenas/workspaces y Reference Center, más `integrity.json` |

Marcadores tipados admitidos: `project.codelab-web`, `project.codelab-design` y `project.codelab-pixelforge`. El marcador genérico `project.codelab` se conserva para compatibilidad legacy. Solo puede existir un marcador en la raíz.

Los dos formatos requieren `manifest.json` y `project.json` en la raíz. El manifiesto debe declarar `format: "codelab"`, un `version` admitido (1 o 2), `editor`, `projectType` y `entry: "project.json"`. El editor debe ser `web`, `design` o `pixelforge`, y el marcador tipado, cuando exista, debe coincidir con `manifest.editor`.

Un ZIP genérico no se convierte en un paquete CodeLab por renombrarlo. Los documentos raíz no pueden estar dentro de una carpeta envolvente; los recursos adicionales sí pueden organizarse en subdirectorios.

## 2. Transporte, tamaño e integridad del artefacto

El puente del agente puede entregar el ZIP inline como Base64 o como bytes. El backend limita el artefacto a 100 MiB en el importador de proyectos y conserva los bytes en `public.codelab_project_artifacts.artifact` (PostgreSQL BYTEA); esta ruta no depende de Neon Object Storage.

Antes de extraer, se comprueba:
- que el artefacto no esté vacío y no supere el límite;
- que `byte_size` coincida con el número real de bytes;
- que SHA-256 de los bytes coincida con el hash almacenado y, cuando se declaró, con `source_sha256`;
- que el ZIP pase la comprobación de integridad del archivo.

En v2, `integrity.json` añade integridad por archivo. Sus entradas registran SHA-256 y tamaño de cada recurso estructurado. El instalador verifica los recursos declarados antes de incorporarlos al proyecto. El hash del artefacto ZIP y el manifiesto de integridad por archivo son controles distintos y complementarios.

## 3. Validación y extracción segura

El importador:
1. enumera las entradas ZIP y valida los marcadores y documentos raíz;
2. rechaza rutas absolutas, traversal (`..`), rutas duplicadas, enlaces simbólicos y entradas de filesystem no admitidas;
3. valida JSON, formato, versión, editor, tipo de proyecto y documento de entrada;
4. extrae el paquete en un directorio temporal aislado;
5. carga los archivos y ejecuta el instalador correspondiente;
6. compara el editor y el tipo de proyecto del manifiesto con la solicitud autorizada.

No se infiere que un archivo sea un fotograma por su nombre, extensión o carpeta. Los datos de animación deben estar declarados explícitamente por el manifiesto de su versión.

## 4. Clasificación y organización de recursos

El destino de cada archivo se resuelve de forma determinista, con esta prioridad:

1. Declaración explícita en `manifest.resources[]` (`path` y `destination`).
2. Carpetas y alias semánticos, incluidos segmentos anidados.
3. Extensión y tipo MIME.
4. Firma binaria o encabezado cuando la extensión no alcanza para clasificarlo.
5. `project-files` como destino de respaldo para contenido ambiguo.

Destinos reconocidos: `reference-center`, `assets`, `scenes`, `animations`, `frames`, `audio`, `video`, `fonts`, `documents`, `models`, `textures`, `scripts`, `styles`, `components`, `templates`, `pages`, `exports`, `backups`, `data` y `project-files`.

Alias habituales:
- `reference/`, `references/`, `refs/`, `moodboard/` e `inspiration/` → `reference-center/`;
- `docs/` y `guides/` → documentos;
- `sounds/` y `music/` → audio;
- `typography/` → fuentes;
- `views/` → páginas.

Ejemplo de clasificación explícita:

```json
{
  "resources": [
    { "path": "misc/pose.png", "destination": "reference-center" },
    { "path": "misc/brand-font.woff2", "destination": "fonts" }
  ]
}
```

El catálogo `project.packageResources` mantiene ruta de origen, destino lógico, ruta canónica, tamaño y MIME. La clasificación hace que el recurso sea localizable y persistente; no implica que todos los editores tengan un panel visual para cada tipo de archivo.

## 5. PixelForge v1: animación legacy

En v1, los fotogramas se declaran en `manifest.animation`; no se deducen de carpetas ni extensiones. Cada frame enumera una celda por cada capa:

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
    "frames": [{
      "id": "frame-1",
      "durationMs": 83,
      "cels": [
        { "layerId": "layer-base", "path": "frames/0001/base.png", "encoding": "png" },
        { "layerId": "layer-detail", "path": "frames/0001/detail.rgba", "encoding": "rgba8" }
      ]
    }]
  }
}
```

Reglas principales:
- cada frame debe tener exactamente una celda para cada `layerId` declarado en el proyecto;
- cada ruta debe existir y una misma celda no puede asignarse dos veces;
- las dimensiones deben coincidir con el canvas;
- se admiten PNG de 8 bits no entrelazado (grayscale, RGB, indexed, grayscale-alpha o RGBA) y RGBA8 sin procesar;
- los PNG se decodifican a RGBA para el modelo de animación nativo.

Límites del modelo legacy: 240 frames, 64 capas, 1–60 FPS, 1–10.000 ms por frame y 64 MiB de memoria de píxeles de animación.

## 6. PixelForge v2: paquete estructurado

En v2, el manifiesto raíz apunta a documentos especializados. Para PixelForge, las secciones estructuradas pueden incluir:

- **Frames:** `manifest.frames.manifestPath` apunta al manifiesto de frames (por ejemplo, `Frames/frames.tscn`). Cada frame tiene su propio documento y referencias a los píxeles por capa.
- **Reference Center:** `manifest.referenceCenter.manifestPath` apunta al catálogo de categorías y referencias. Cada referencia conserva metadatos, partes editables, rutas de píxeles y hashes.
- **Escenas y workspaces:** `manifest.scenes.sections` declara los manifiestos de las cinco secciones independientes: Environment, Effects, Details, Elements y Objects. Cada workspace es un documento completo, no una imagen ni una referencia viva al documento padre.
- **Recursos:** `manifest.resources[]` declara archivos adicionales y su destino lógico.
- **Integridad:** `manifest.integrityPath` apunta a `integrity.json`, que valida tamaño y SHA-256 de los archivos declarados.

El proyecto raíz conserva sus metadatos y el estado de contexto activo. Los documentos completos de las secciones se serializan en sus manifiestos propios para evitar duplicar los cinco documentos dentro de `project.json`. Al importar, el instalador reconstruye la estructura nativa que consume PixelForge.

Cada workspace debe mantener su propio canvas, capas, propiedades, frames/cels, duración/FPS y animación. Cambiar de contexto no debe mezclar píxeles ni convertir un workspace en una simple referencia del proyecto principal.

## 7. Persistencia e integración en los editores

Después de instalar y validar el paquete, el importador:
- guarda el documento normalizado en `public.codelab_project_registry`;
- guarda los archivos del paquete en `public.codelab_project_files`, con ruta canónica, MIME, tamaño, SHA-256 y bytes;
- vuelve a leer el proyecto y los archivos desde PostgreSQL y verifica hashes, tamaños, contenido y cantidades;
- publica los proyectos Web/Design en el estado de workspace que consume el editor habitual;
- para PixelForge, inserta/actualiza el documento en `public.codelab_pixelforge_projects`, el almacenamiento dedicado que utiliza el editor;
- registra el resultado de importación y actualiza los estados de solicitud y artefacto.

Por tanto, la importación de PixelForge no se limita a conservar un ZIP adjunto: materializa un documento de proyecto en el almacenamiento nativo. Los recursos también se guardan individualmente y el backend comprueba que se pueden volver a leer.

**Alcance de las garantías:** el importador confirma persistencia y lectura posterior del backend. La apertura visual desde el selector real de proyectos, la edición, el guardado mediante las rutas normales de PixelForge y una segunda reapertura deben cubrirse además con una prueba E2E del flujo completo. Las pruebas del exportador/importador de navegador y las del instalador estructurado no sustituyen esa prueba de integración del backend.

## 8. Reference Center y copia editable

Los recursos de referencia que se reconocen como imágenes y se declaran/clasifican para `reference-center` pueden incorporarse como entradas nativas. La miniatura incrustada está limitada a 4 MiB por imagen y 12 MiB en total; los archivos mayores siguen disponibles en el catálogo y en `codelab_project_files`.

La referencia original debe permanecer intacta. Las operaciones de copia al canvas materializan píxeles independientes en la capa activa; no deben convertir la referencia en un enlace vivo ni alterar la estructura de capas o la línea de tiempo.

## 9. Diagnóstico

| Síntoma | Qué comprobar |
|---|---|
| ZIP rechazado como CodeLab | Marcador válido y único en la raíz, además de `manifest.json` y `project.json` |
| Marcador/editor no coinciden | `project.codelab-<editor>` debe corresponder a `manifest.editor` |
| Manifiesto v2 rechazado | `version=2`, `schemaVersion=2`, `layout="structured"` y `entry="project.json"` |
| Error de integridad | Hash/tamaño del ZIP o entradas de `integrity.json` no coinciden con los bytes |
| Recurso no encontrado | La ruta declarada no existe exactamente dentro del ZIP |
| Ruta rechazada | Ruta absoluta, traversal, duplicada o enlace simbólico |
| Frame/cel no instalado | Mapeo incompleto, capa duplicada, dimensión incorrecta o encoding no admitido |
| Workspace de escena incompleto | Falta el manifiesto o documento de una sección, o no se puede reconstruir su estado |
| Referencia no aparece como miniatura | Destino distinto de `reference-center`, firma no reconocida o límite de incrustación superado |
| Proyecto no aparece en el editor | Comprobar la persistencia en el registro y la tabla nativa del editor; después comprobar el selector/listado de proyectos |
| Error de Object Storage | Esta ruta de importación conserva el artefacto en PostgreSQL BYTEA; Object Storage no es requisito para este flujo |

## 10. Código y pruebas relacionadas

- Importador backend: `codelab-project-artifact-import.mjs`
- Instalador de paquetes y compatibilidad v1/v2: `codelab-project-package-installer.mjs`
- Instalador estructurado v2: `codelab-project-structured-format.mjs`
- Exportador/importador ZIP de PixelForge en navegador: `public/pixelforge/src/codelab-package.js`
- Pruebas del instalador legacy y clasificación: `tests/codelab-project-package-installer.test.mjs`
- Pruebas de manifiestos y datos estructurados v2: `tests/codelab-structured-project-v2.test.mjs`
- Pruebas de exportación/importación y workspaces de navegador: `tests/pixelforge-codelab-package-browser.test.mjs`
- E2E de UI con PostgreSQL, importación ZIP del editor, guardado, reapertura y edición raster: `tests/pixelforge-integration.test.js`
- Pruebas del paquete PixelForge: `tests/pixelforge-codelab-package.test.mjs`
- Pruebas de nombre/transporte del artefacto: `tests/codelab-artifact-filename.test.mjs`

La cobertura combinada valida el formato y la instalación estructurada, el round-trip del paquete y, en la integración de UI, el flujo ZIP del editor hacia guardado/reapertura en PostgreSQL. La prueba E2E de UI importa el ZIP desde el editor; no equivale a recorrer el comando de agente `codelab_project_import` y su backend `importCodeLabArtifact`. Ese trayecto agente→solicitud→BYTEA→importador→selector nativo debe quedar cubierto por una prueba de integración específica antes de declarar cerrado el flujo de importación del agente.
