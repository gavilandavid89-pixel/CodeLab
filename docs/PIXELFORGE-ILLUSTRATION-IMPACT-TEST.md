# PixelForge — prueba de animación nativa en modo Illustration

**Estado:** primera animación mejorada creada con Headless, transferida por el inline artifact bridge, persistida en ADMIN, exportada desde el Video Composer real y verificada por la sesión B.  
**Rama compartida permanente:** `test/pixelforge-illustration-impact-animation`  
**Proyecto PixelForge:** `6f9cdb50-55a3-4d78-bd34-9cc95b54a5be`  
**Workspace destino:** `ws_local_admin`

## Regla esencial de esta prueba

La animación se creó ejecutando el runtime oficial PixelForge Headless y sus acciones nativas. **No se utilizó generación de imágenes ni generación de vídeo por IA.** Tampoco se utilizó un GIF generado externamente como sustituto del proyecto.

El dibujo se construyó mediante acciones raster de PixelForge. Los fotogramas/cels se crearon con el modelo de animación de Headless, y el movimiento del oponente se aplicó con la acción nativa `canvas.transform_region`, transformando el cel completo para conservar juntas sus partes durante el vuelo, giro y caída.

El builder reproducible está versionado en `projects/animation-inbox/impact-illustration/build-project.mjs`. El workflow de Project Inbox lo ejecuta para generar el paquete nativo y después transfiere los bytes fuera del Headless mediante el bridge documentado. El Headless no recibe credenciales ni se conecta al bridge.

## Objetivo y alcance visual

La secuencia interpreta la acción solicitada a partir de la referencia del usuario: el atacante lanza el golpe, el oponente de chaqueta oscura retrocede, sale despedido, gira y cae al suelo.

**Alcance artístico:** es un animatic estilizado de prueba, no una reproducción detallada del manhwa ni una animación final de calidad profesional. La anatomía, el contacto del golpe y la caída se pueden pulir más; esta pasada valida el flujo nativo completo de creación, importación, reproducción y exportación.

## Proyecto nativo persistido

- Formato: paquete CodeLab v2 / PixelForge `.codelab`.
- Project ID: `6f9cdb50-55a3-4d78-bd34-9cc95b54a5be`.
- Canvas: 240 × 426 px (proporción 9:16).
- Capas raster: 3 (`Escenario`, `Atacante — Illustration`, `Oponente — Illustration`).
- Frames: 6.
- FPS: 12.
- Duraciones: 100, 80, 90, 90, 90 y 400 ms.
- Duración total: 850 ms.
- Loop: desactivado.
- Cels instalados: 18.
- Todas las capas, los 6 frames y los 18 cels tienen `authoringMode: illustration`.

## Acciones Headless usadas

- `drawing.mode.set` para activar Illustration.
- `canvas.fill`, `canvas.draw_stroke` y `canvas.draw_shape` para construir escenario y personajes.
- `canvas.transform_region` para mover y rotar el cel completo del oponente entre fotogramas, con interpolación bilinear.
- `animation.frame.capture_document`, `animation.frame.duplicate` y `animation.frame.set_cel` para construir el timeline.
- `animation.frame.set_duration`, `animation.set_fps` y `animation.set_loop` para configurar el timing.
- `createProposal`, `acceptProposal` y `toJSON()` para revisar, aceptar y serializar el proyecto.

El atacante y el escenario permanecen en capas separadas y estables; el oponente conserva una única capa animada. No se mezcla Pixel Art.

## Transferencia y persistencia comprobadas

- Workflow de importación: [Import PixelForge project inbox — run 45893844052](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45893844052), conclusión **success**.
- Import request: `repo-inbox-impact-illustration-45893844052`.
- Command ID: `2aac1b61-c04f-4aa6-9140-141e99e1c177`, acción `codelab_project_import`, estado `succeeded`.
- El worker informó 6 frames y 18 animation cels instalados en `ws_local_admin`.
- La fila persistida en `codelab_pixelforge_projects` confirma el ID, nombre, dimensiones, 3 capas, 6 frames, 12 FPS, loop desactivado y `server_revision = 1`.
- SHA-256 del contenido persistido: `add526ac66705282b0db3b67ac224b3123eec3a2c3a891a063508c27f1ce18a6`.
- Verificación SQL de solo lectura: todas las capas, frames y cels devuelven modo `illustration`.

HTTP 202 se trató únicamente como confirmación de encolado; la prueba esperó el worker y verificó tanto el comando completado como el proyecto persistido en el workspace destino.

## Exportación A/B desde el editor real

<badge color="success">A/B verificado</badge>

- Workflow: [CodeLab A/B real ADMIN Illustration impact export — run 45894038992](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45894038992), conclusión **success**.
- Sesión A: [Independent Session A — run 45894076022](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45894076022). A abrió el proyecto y realizó la exportación mediante el Video Composer real.
- Sesión B recibió el WebM, lo reconstruyó y lo decodificó con Chromium; no dibujó ni generó la animación.
- B confirmó proyecto, revisión, hash, 6 frames, 12 FPS y duración esperada de 850 ms.
- Decodificación: 1080 × 1917, 0,85 s, `readyState = 4`, 5 muestras decodificadas.
- Errores de página/consola reportados por A: ninguno.
- A permaneció activo después de que B terminó, como exige el contrato A/B.

**WebM verificado**
- Archivo: `Impact-Illustration-Improved-codelab-pixelforge.webm`.
- Bytes: 132.852.
- SHA-256: `7084dfa4cb54310fe4f08360514182e343e3b9888d4952a915db8a7a1a690685`.
- Artefacto B: `codelab-impact-illustration-webm-45894038992`.

## Revisión visual del WebM

El WebM exacto entregado por B fue descargado y revisado por el agente. La secuencia muestra al atacante fijo, contacto, retroceso del oponente, giro en el aire y pose horizontal final en el suelo.

La prueba técnica completa pasó, pero la revisión artística detecta margen para pulir la silueta, la continuidad de las poses y la composición del aterrizaje. No confundir aprobación técnica A/B con aprobación artística final.

## Próxima iteración

1. Mejorar anatomía y silueta de ambos personajes, usando la referencia del usuario como guía.
2. Añadir poses intermedias para suavizar el golpe, el vuelo y la caída.
3. Mantener la transformación de la figura completa o separar sus partes en capas coherentes si se requiere animación articulada.
4. Reimportar mediante el mismo Project Inbox y volver a ejecutar A/B.
5. Revisar el WebM exacto antes de declarar la versión artística final.

Toda repetición y mejora de esta prueba, así como cualquier prueba futura de CodeLab, se realiza en la misma rama permanente compartida. No crear ramas de prueba adicionales.
