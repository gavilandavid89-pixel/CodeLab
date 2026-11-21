# PixelForge — Inventario funcional

Fecha: 2026-11-20

Referencia funcional de PixelForge dentro de CodeLab. Distingue capacidades implementadas de ideas futuras y debe actualizarse junto con cambios relevantes.

## 1. Editor raster
### Canvas y documento
- Canvas raster RGBA y dimensiones configurables dentro de los límites.
- Zoom, pan, coordenadas, rejilla de píxeles y guías visuales.
- Documento con nombre, revisión, dirty/save y render pixel-art sin suavizado.
- Estado de herramienta y mensajes de operación.

### Dibujo
- Pencil/draw por píxel.
- Eraser.
- Fill/bucket con tolerancia y modo contiguo.
- Eyedropper.
- Line, rectangle, ellipse y gradient.
- Brush size, opacity, shape y hardness.
- Simetría Off / 2 / 4 / 8 partes.
- Draw-hold para entrada táctil/continua.

### Selección
- Rectangular, elíptica, lazo y magic/color selection.
- Modos replace, add, subtract e intersect.
- Traslación, inversión y borrado de selección.
- Clipboard interno de píxeles.
- Copiar, cortar y pegar regiones.

### Edición
- Transformación de regiones con preview no destructivo.
- Crop con preview.
- Flip de regiones.
- Outline.
- Reemplazo de color.
- Fill gradient y shapes.
- Undo/redo e historial.

## 2. Capas
- Crear, seleccionar, renombrar, duplicar y eliminar capas.
- Reordenar capas arriba/abajo.
- Ocultar/mostrar.
- Bloquear/desbloquear.
- Opacidad.
- Stack de capas editable.

## 3. Color y paleta
- Foreground/background y swap.
- Presets y colores recientes.
- Paleta local por cuenta CodeLab.
- Añadir/quitar colores.
- Importar RGB/hex desde texto.
- Exportar paleta GPL.
- Eyedropper y reemplazo de color.

## 4. Importación y exportación
- Importación raster con preflight.
- Exportación de canvas/arte.
- Sprite sheet + manifest.
- ZIP de proyecto de animación.
- ZIP con proyecto + frames PNG + manifest.
- Proyecto `.pforge` conservando capas y cels editables.
- Paquete de vídeo/animación con FPS, loop y velocidad.
- Exportación de vídeo mediante el flujo de renderer/evidencia de CodeLab.

## 5. Timeline de animación
PixelForge reutiliza el mismo raster/layers del editor para cada frame; no crea un segundo editor de dibujo.

### Frames y timing
- Crear timeline desde el documento.
- Crear frame desde una capa.
- Capturar frame compuesto o documento completo.
- Duplicar, eliminar, reordenar y seleccionar frame.
- Duración individual por frame.
- FPS global de 1 a 60.
- Hasta 240 frames.
- Hasta 64 capas raster por timeline.
- Cels RGBA independientes por capa/frame.
- Thumbnails.
- Onion skin anterior/siguiente.
- Contexto de frame/cel para automatización.
- Composite y lectura/escritura de cels.
- Presupuesto de memoria y preflight de serialización.
- El timing base del proyecto no se destruye al cambiar la reproducción.

### Velocidad de reproducción — NUEVO
- `1×` es la velocidad base/normal.
- UI: `0.1×`, `0.25×`, `0.5×`, `0.75×`, `1×`, `1.25×`, `1.5×`, `2×`, `3×`, `4×`.
- Cambiar velocidad solo modifica la reproducción; no modifica píxeles ni duración base de frames.
- La velocidad se guarda con la configuración de animación.
- Permite inspección lenta y análisis rápido sin alterar el proyecto.
- El manifest de exportación registra la velocidad.
- Headless expone `animation.set_playback_speed`.
- Rango interno: `0.1×`–`4×`.

### Loop — IMPLEMENTADO
- Loop activable/desactivable.
- Reproduce la secuencia de nuevo sin duplicar frames.
- No copia ni modifica cels.
- Permite ciclos reutilizables para caminar, correr, idle, efectos, NPCs y elementos de juego.
- El estado de loop se guarda con la animación.

## 6. Reference Center
Reference Center trata las referencias como estructuras editables, no como una imagen plana.

### Categorías
- Characters.
- Objects.
- Environment.
- Scenes.
- Effects.

### Estructura
- Reference → Frame → Object → Part → Layer → Pixel.

### Funciones
- Crear, empaquetar, listar, inspeccionar, aplicar y eliminar referencias.
- Copiar una parte como capas editables.
- Copiar un frame completo como capas editables.
- Copiar una capa de un frame.
- Metadata de categoría, partes, dimensiones y contexto.
- Contexto de capas con opacidad anterior/siguiente y cantidad de vecinos.
- Panel Reference Center con navegación y restauración.
- Las instancias copiadas continúan siendo raster editable normal.

## 7. Inteligencia de dibujo / AI
### Inspección
- Modelo estructural del dibujo.
- Resumen de documento y capas.
- Contexto de capa.
- Lectura de píxel y región.
- Referencia visual del canvas.
- Inspección de objetos, capas, paleta y frames/cels.
- Contexto visual anterior/actual para animación.

### Canvas
- `canvas.draw_line`
- `canvas.draw_stroke`
- `canvas.fill`
- `canvas.clear_region`
- `canvas.copy_region`
- `canvas.paste_region`
- `canvas.crop`
- `canvas.draw_shape`
- `canvas.fill_gradient`
- `canvas.flip_region`
- `canvas.create_outline`
- `canvas.replace_color`
- `canvas.preview_transform_region`
- `canvas.transform_region`

### Layers
- `layer.add`, `layer.select`, `layer.move`, `layer.rename`.
- `layer.set_opacity`, `layer.set_visibility`, `layer.set_locked`.
- `layer.duplicate`, `layer.delete`, `layer.get_context`.

### Selection
- `selection.clear`.
- `selection.create_rect`, `selection.create_ellipse`, `selection.create_lasso`, `selection.create_magic`.
- `selection.modify`, `selection.combine`, `selection.translate`.

### Reference Center
- `drawing.reference.create`.
- `drawing.reference.package_current`.
- `drawing.reference.list` / `drawing.reference.get`.
- `drawing.reference.apply`.
- `drawing.reference.copy_part` / `copy_frame` / `copy_frame_layer`.
- `drawing.reference.remove`.
- `drawing.layer.context.set`.
- `drawing.reference.extract_line_guide`.

### Workflow / escena
- `drawing.workflow.start`.
- `drawing.workflow.set_scene`, `get_scene`, `get_state`.
- `drawing.workflow.record_action`, `visual_feedback`, `pause`, `resume`, `correct`, `advance`.
- `drawing.scene.normalize`, `validate`, `compile`.
- `drawing.sheet.configure`, `drawing.sheet.get`.
- `drawing.object.select_at`, `drawing.object.inspect`.
- `drawing.motion.analyze`.

### Animación
- `animation.get_summary`.
- `animation.frame.add_from_layer`.
- `animation.frame.capture_composite` / `capture_document`.
- `animation.frame.duplicate` / `delete` / `reorder`.
- `animation.frame.set_duration` / `set_active`.
- `animation.set_fps` / `animation.set_loop` / `animation.set_playback_speed`.
- `animation.frame.get_cel` / `get_context` / `set_cel`.
- `animation.frame.get_onion_skin` / `get_composite`.
- `animation.undo` / `animation.redo`.

## 8. Headless y automatización
- Runtime headless sobre sandbox.
- Separación entre fuente, sandbox y proposal.
- Diff visual y diff de animación.
- Create/accept/discard proposal.
- Sincronización desde fuente.
- Inspección estructurada de proyecto y timeline.
- Batch de hasta 500 acciones.
- Validación de capacidades.
- Mapeo seguro de IDs de capas.
- Serialización solo después de aceptar propuestas.
- Velocidad de reproducción aparece como metadata de animación en el diff de settings.

## 9. Persistencia
- Guardado en cuenta CodeLab.
- Carga del proyecto más reciente.
- Lista y apertura por project ID.
- Eliminación de proyecto.
- Autosave.
- Versionado/revisión.
- Snapshot documento + timeline.
- Recuperación de loop y velocidad de reproducción.

## 10. Vídeo y evidencia
- Captura automática asociada a mutaciones de animación aprobadas.
- Exportación explícita de vídeo.
- Captura después de persistir el estado aprobado.
- Carga del proyecto real antes de capturar.
- Reproducción real en Chromium.
- Evento de evidencia asociado a proyecto/revisión.
- WebM como evidencia.
- Decodificación del vídeo para verificar frames reales, no solo metadata.
- Preview de frames desde Neon BYTEA.
- Correlación por project ID, revision y event ID.
- El vídeo es evidencia/auditoría; el proyecto persistente es la fuente canónica.

## 11. Uso orientado a juegos
- Crear ciclos cortos reutilizables.
- Reproducirlos en loop sin duplicar frames.
- Ajustar velocidad sin modificar timing original.
- Reutilizar una animación para personajes, NPCs, enemigos y efectos.
- Mantener frames editables para cambios mínimos entre ciclos.

Ejemplo: `walk: F1 → F2 → F3 → F4 → F5 → F6 → loop → F1`.

## 12. Límites actuales
- Canvas: hasta 4096×4096 y máximo de 16 megapíxeles.
- Layers: hasta 64.
- Frames: hasta 240.
- FPS: 1–60.
- Duración individual: 1–10.000 ms.
- Memoria de animación: 64 MiB.
- Serialización JSON segura: 96 MiB.
- Playback speed: 0.1×–4×.

## 13. Ideas futuras — NO marcar como implementadas
- Loop ping-pong y hold en extremos.
- Rangos A/B.
- Eventos/marcadores de timeline.
- Múltiples animaciones nombradas dentro de un personaje/proyecto.
- Clips reutilizables independientes del timeline principal.
- Velocidad por clip.
- Exportación directa por clip orientada a sprites de juego.
- Anchors y motion constraints semánticos avanzados.
- Selección semántica de objetos/regiones.
- Edición semántica de píxeles por región/layer/frame/rango.
- Undo transaccional semántico.
- Navegador de grid avanzado.
- Overlay line-reference de alta precisión.
- Digital sheet de producción.
- Paleta semántica.

## 14. Reglas de compatibilidad
1. No modificar destructivamente cels existentes.
2. Mantener `1×` como referencia/base.
3. Separar timing del proyecto de velocidad de reproducción.
4. Loop reutiliza frames; no los duplica.
5. Cambios de reproducción deben ser persistibles y auditables.
6. Editor y runtime headless deben entender las mismas propiedades.
7. Exportación/evidencia debe respetar la velocidad configurada cuando se reproduce el proyecto.
8. Cambios de velocidad/loop no alteran el contenido raster.
9. Las pruebas de animación deben verificar vídeo real además de metadata.

## 15. Archivos principales
- `public/pixelforge/index.html` — interfaz y timeline.
- `public/pixelforge/src/editor.js` — editor, reproducción, persistencia y UI.
- `public/pixelforge/src/animation.mjs` — modelo de frames/cels/timing.
- `public/pixelforge/src/animation.js` — timeline, validación, acciones y exportaciones.
- `public/pixelforge/src/core.js` — documento raster, capas, dibujo, selección e historial.
- `public/pixelforge/src/reference-center-ui.js` — UI Reference Center.
- `public/pixelforge/src/drawing-intelligence.js` — inteligencia/contexto.
- `public/pixelforge/src/ai-tools.js` — herramientas AI/automatización.
- `public/pixelforge/src/headless.js` — runtime headless y capacidades.
- `public/pixelforge/src/headless-bridge.js` — puente headless.
- `public/pixelforge/src/headless-vision.js` — snapshots/visión.
- `public/pixelforge/src/persistence.js` — guardado/carga.
- `public/pixelforge/src/asset-export.js` — assets.
- `public/pixelforge/src/image-import.js` — importación raster.
- `public/pixelforge/src/video-composer-core.mjs` — composición de vídeo.
- `public/pixelforge/src/zip-export.js` — empaquetado ZIP.
- `public/pixelforge/src/showcase-animation.mjs` — showcase de animación.
- `public/pixelforge/src/workspaces.js` — workspace AI/dibujo.

Estado: este archivo es la referencia funcional de PixelForge para futuras implementaciones y pruebas. Debe actualizarse junto con cambios funcionales relevantes.
