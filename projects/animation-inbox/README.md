# PixelForge project inbox

Esta carpeta es el punto de entrada de proyectos fuente que deben aparecer en PixelForge ADMIN para que el flujo A/B existente pueda trabajar con ellos.

## Añadir un proyecto

1. Exporta el proyecto desde PixelForge como paquete nativo **CodeLab `.codelab`**.
2. Crea una carpeta con un identificador corto en minúsculas y guiones, por ejemplo `creepypasta-pasillo`.
3. Coloca el paquete exportado dentro con el nombre exacto `project.codelab`:

```text
projects/animation-inbox/
└── creepypasta-pasillo/
    └── project.codelab
```

4. Haz push a `main`. El workflow **Import PixelForge project inbox** detecta la carpeta modificada, valida el paquete y lo importa mediante el bridge inline al workspace ADMIN `ws_local_admin`.
5. Cuando el workflow indique que la orden quedó `queued`, el worker de CodeLab realizará la importación. La orden encolada no equivale todavía a importación completada; comprobar el proyecto en PixelForge antes de lanzar A/B. Después, iniciar A con el ID del proyecto como input `project_id` y B con ese mismo ID como input `project_id`. B rechaza una sesión A fijada a otro proyecto.

También se puede ejecutar el workflow manualmente indicando `project_slug`; vacío significa procesar las carpetas válidas del inbox.

## Contrato del paquete

El ZIP `.codelab` debe ser un paquete PixelForge nativo válido, con estos archivos en la raíz del ZIP:

- `project.codelab-pixelforge`
- `manifest.json` con `format: "codelab"` y `editor: "pixelforge"`
- `project.json`

Los recursos declarados por el manifiesto viajan dentro del mismo paquete. No se aceptan paquetes de otros editores en este inbox.

## Separación A/B (no modificar)

- Este workflow/catalog importer lee los archivos del repositorio y los entrega a CodeLab. **No es A ni B.**
- **A no lee GitHub ni el repositorio.** A conserva su función actual: ejecutar la web real de CodeLab/PixelForge, recibir la orden de B y realizar la operación solicitada en su sesión.
- **B conserva su función actual:** decide qué proyecto/operación pedir, envía la orden a A, recibe el WebM y lo verifica. B no anima, no genera fotogramas, no usa FFmpeg y no recibe credenciales del bridge/Neon.
- El pipeline A/B de vídeo permanece sin cambios.

## Limpieza

El paquete fuente de esta carpeta es la copia maestra y **nunca se elimina** por el cierre de una tarea. La importación crea una copia de trabajo en el workspace ADMIN. Esa copia de trabajo solo debe eliminarse después de terminar A/B y tras una confirmación explícita del usuario; el WebM y su evidencia se conservan por separado. No se implementa borrado automático al completar la importación ni al terminar B.
