# Lector de paquetes ZIP de CodeLab

Este documento describe el comportamiento real del lector e importador de paquetes CodeLab. No depende del nombre ni de la extensión del archivo comprimido.

## 1. Cómo reconoce un paquete

Un ZIP solo se considera un paquete CodeLab si contiene estos tres archivos en la raíz del archivo:

- `project.codelab` — marcador de formato.
- `manifest.json` — manifiesto y declaraciones de recursos.
- `project.json` — documento del proyecto.

Por tanto, `mi-proyecto.zip`, `export.codelab` o cualquier otro nombre pueden transportar el mismo formato. Cambiar la extensión no convierte un ZIP genérico en un paquete CodeLab.

Los tres archivos deben estar en la raíz del ZIP; no basta con que estén dentro de una carpeta envolvente. Los recursos adicionales sí pueden estar anidados en subcarpetas.

## 2. Transporte e integridad

El transporte canónico no requiere Neon Object Storage. El cliente entrega el ZIP mediante el transporte inline `artifactBase64`; el backend decodifica y persiste los bytes en `public.codelab_project_artifacts.artifact` (BYTEA).

Antes de importar, el backend comprueba el tamaño y SHA-256 de los bytes almacenados frente a los datos de la solicitud. La importación continúa desde Neon BYTEA, sin depender de Object Storage.

## 3. Validación y extracción

El importador:

1. Lee el ZIP y localiza el marcador y los dos documentos obligatorios en la raíz.
2. Parsea `manifest.json` y `project.json`.
3. Comprueba el formato y versión declarados, el editor y el tipo de proyecto solicitados.
4. Valida rutas relativas y rechaza rutas inseguras, duplicadas o entradas que escapen del directorio del proyecto.
5. Comprueba que los recursos declarados existan en el archivo.
6. Extrae los bytes y conserva las rutas relativas originales como procedencia.

No interpreta un nombre de archivo como prueba de que sea un fotograma. En particular, una imagen PNG bajo `assets/` no se convierte automáticamente en un frame de animación.

## 4. Cómo decide el destino de cada recurso

La clasificación es determinista y sigue este orden de prioridad:

1. **Declaración explícita:** una entrada de `manifest.resources[]` con `path` y `destination` prevalece sobre las heurísticas.
2. **Carpetas y alias semánticos:** se examinan los segmentos de la ruta, incluidos los anidados.
3. **Tipo de archivo:** la extensión aporta una pista MIME y de destino.
4. **Firma binaria o encabezado:** cuando la extensión no basta, se reconocen formatos como PNG, JPEG, GIF, WebP, audio, video, PDF, GLB y fuentes; también se inspeccionan encabezados SVG/HTML.
5. **Destino genérico:** solo los recursos que continúan siendo ambiguos se guardan en `project-files`.

Destinos admitidos:

- `reference-center`
- `assets`, `scenes`, `animations`, `frames`
- `audio`, `video`, `fonts`, `documents`
- `models`, `textures`, `scripts`, `styles`
- `components`, `templates`, `pages`, `exports`, `backups`, `data`
- `project-files`

Alias habituales: `reference/`, `references/`, `refs/`, `moodboard/` e `inspiration/` se normalizan a `reference-center/`; `docs/` y `guides/` a documentos; `sounds/` y `music/` a audio; `typography/` a fuentes; `views/` a páginas.

Ejemplo de una asignación explícita:

```json
{
  "resources": [
    { "path": "misc/pose.png", "destination": "reference-center" },
    { "path": "misc/brand-font.woff2", "destination": "fonts" }
  ]
}
```

## 5. Cómo se declaran los fotogramas de PixelForge

Los fotogramas no se deducen de carpetas ni extensiones. El manifiesto debe mapear explícitamente cada celda a un frame y a una capa:

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

Reglas de validación de la animación:

- Cada frame debe contener exactamente una celda para cada `layerId` definido por `project.json`.
- Cada ruta debe existir y una misma celda no puede asignarse dos veces.
- Las dimensiones de cada celda deben coincidir con el canvas del proyecto.
- Codificaciones admitidas: PNG de 8 bits no entrelazado (grayscale, RGB, indexed, grayscale-alpha o RGBA) y RGBA8 sin procesar.
- Los PNG se decodifican a RGBA antes de construir el objeto nativo que consume `PixelForgeAnimation.fromJSON`.
- Límites del modelo: 240 frames, 64 capas, 1–60 FPS, 1–10.000 ms por frame y 64 MiB de memoria de píxeles de animación.

## 6. Persistencia del proyecto y sus archivos

Tras validar e instalar el paquete:

- El proyecto se guarda en `public.codelab_project_registry`.
- Cada archivo se guarda en `public.codelab_project_files` con su ruta de destino canónica, tipo MIME, tamaño, SHA-256 y bytes.
- Para PixelForge también se actualiza `public.codelab_pixelforge_projects` con el proyecto nativo.
- Se registra la importación en `public.codelab_project_imports`, con el manifiesto, hash de origen, payload y resultado.
- La solicitud de importación y el artefacto cambian a estado `succeeded` e `imported`, respectivamente.

El catálogo `project.packageResources` conserva para cada archivo la ruta de origen, destino, ruta canónica, tamaño y tipo MIME. En PixelForge también se refleja en `drawingModel.packageResources`.

## 7. Integración nativa en PixelForge

Las imágenes de `reference-center` se incorporan como referencias del Reference Center cuando se reconocen sus firmas PNG, JPEG, GIF o WebP. Las entradas guardan su procedencia y pueden mostrarse como miniaturas. La acción de copiar una referencia al canvas crea una capa editable sin alterar el original y mantiene la proporción.

La incrustación de miniaturas está limitada a 4 MiB por imagen y 12 MiB en total. Los archivos que exceden esos límites siguen disponibles en el catálogo y en `codelab_project_files`.

El catálogo también permite localizar audio, video, documentos, fuentes, modelos, componentes y otros recursos. Que un archivo esté catalogado no significa que todos los editores tengan ya un panel visual nativo para abrirlo.

## 8. Diagnóstico de errores comunes

| Síntoma | Causa que debe comprobarse |
|---|---|
| ZIP rechazado como proyecto | Falta `project.codelab`, `manifest.json` o `project.json` en la raíz |
| Manifiesto no válido | JSON mal formado, formato/versión/editor/tipo incorrectos |
| Recurso no encontrado | El manifiesto declara una ruta que no existe en el ZIP |
| Ruta rechazada | Ruta absoluta, traversal, duplicada o insegura |
| Frame no instalado | Falta el mapeo explícito frame/capa, la celda no coincide con el canvas o la codificación no está admitida |
| Imagen no aparece como referencia | Destino no clasificado como `reference-center`, firma no reconocida o límite de incrustación superado |
| Problema de Object Storage | No debe bloquear esta importación: el transporte canónico es inline a Neon BYTEA |

## 9. Código fuente y pruebas relacionadas

- Instalador: `codelab-project-package-installer.mjs`
- Persistencia e importación: `codelab-project-artifact-import.mjs`
- Pruebas del instalador: `tests/codelab-project-package-installer.test.mjs`
- Pruebas de transporte/nombre: `tests/codelab-artifact-filename.test.mjs`
- Protocolo de animación y evidencia: `docs/ANIMATION-AUTONOMOUS-WORKFLOW.md`
