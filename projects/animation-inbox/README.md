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

## Qué hace el importador por dentro

El workflow no copia archivos a mano ni abre un navegador. Es un adaptador entre el catálogo Git del repositorio y el importador nativo de CodeLab:

1. Un push bajo `projects/animation-inbox/**` activa el workflow. También se puede usar **Actions → Import PixelForge project inbox → Run workflow** y escribir un `project_slug`; si queda vacío, procesa las carpetas disponibles.
2. Detecta las carpetas modificadas (o las solicitadas manualmente), valida el slug y busca el archivo exacto `project.codelab`.
3. Comprueba la integridad del ZIP y que en su raíz existan `project.codelab-pixelforge`, `manifest.json` y `project.json`. El manifiesto debe declarar `format: codelab` y `editor: pixelforge`.
4. Lee el ID y nombre reales desde `project.json`, calcula SHA-256 y divide el paquete en bloques de 1 MiB.
5. Usa el secreto GitHub `CODELAB_AGENT_BRIDGE_CONTROL_SECRET` para autenticarse ante el bridge existente. Crea un artefacto de tipo `codelab_zip_upload`, editor `pixelforge`, destino `ws_local_admin`, y sube cada bloque.
6. El commit del artefacto comprueba el SHA-256 y encola una orden de importación para el worker CodeLab. El workflow falla si la respuesta no es `queued`.

**Importante:** `queued` no es `imported` ni `succeeded`. Solo confirma que el servidor aceptó y encoló la orden. Espera a que el worker la procese y comprueba que el proyecto aparece en PixelForge ADMIN. No arranques A/B basándote únicamente en que el workflow del inbox quedó verde.

## Después de importar: elegir el proyecto en A/B

El slug de la carpeta (por ejemplo `creepypasta-pasillo`) sirve para organizar el inbox; no tiene por qué ser el ID interno del proyecto. El ID que A y B necesitan es el campo `id` de `project.json`, que debe coincidir con el proyecto visible en ADMIN.

- Ejecuta **CodeLab Independent Session A** primero y pasa el ID en `project_id`. Espera a que publique su estado READY.
- Ejecuta **CodeLab Independent Session B** y pasa exactamente el mismo ID en `project_id`. Deja `session_id` vacío para descubrir una sesión A activa o proporciona el ID de sesión de A.
- B comprueba el proyecto y workspace fijados por A antes de solicitar la exportación. Si el ID no coincide, se detiene sin pedir un vídeo del proyecto equivocado.
- A abre/usa la sesión web real de PixelForge y exporta desde Video Composer. B solo recibe y verifica el WebM; no anima, no crea fotogramas ni ejecuta FFmpeg.
- Al finalizar, recupera el WebM y sigue la inspección visual/entrega indicada en el documento owner A/B.

## Qué se conserva y cuándo borrar

El paquete de esta carpeta es la copia maestra del repositorio y permanece versionado. El importador crea otra copia de trabajo en ADMIN. No hay borrado automático al importar ni al terminar B.

La copia ADMIN solo se elimina desde PixelForge con la acción Delete y la confirmación explícita del usuario. **Antes de hacerlo, espera a que A ya no necesite el proyecto y haya expirado/terminado su sesión**; que B haya terminado no significa que A haya terminado. La limpieza de ADMIN también retira los recursos y registros de importación asociados. El WebM y `verification.json` quedan como artefactos independientes; el paquete fuente del inbox no se toca.

Consulta [la arquitectura principal A/B](../../docs/CODELAB-A-B-SESSION-VIDEO-ARCHITECTURE.md), [el protocolo de vídeo](../../docs/VIDEO-PROCESSING-AB.md) y [el funcionamiento del bridge](../../docs/inline-artifact-bridge.md).

## Cuándo conviene usar el inbox

Este inbox es una **vía alternativa, no el paso obligatorio de cada proyecto**. Su uso principal está pensado para:

- proyectos grandes, con muchos archivos, capas o recursos, cuyo traslado resulta más fiable como un paquete nativo completo;
- casos en los que no hay datos de transferencia disponibles o utilizables en el flujo habitual (por ejemplo, no existe un paquete/snapshot transferible o la información está incompleta).

Si el proyecto es pequeño y ya cuenta con datos de transferencia normales, completos y válidos, usa ese mecanismo habitual y no lo vuelvas a importar desde el inbox sin necesidad.

**Decisión rápida:** transferencia normal completa disponible → flujo normal. Proyecto grande o sin datos de transferencia utilizables → inbox del repositorio. En cualquiera de los dos casos, espera a que el proyecto esté realmente disponible en ADMIN antes de iniciar A/B.
