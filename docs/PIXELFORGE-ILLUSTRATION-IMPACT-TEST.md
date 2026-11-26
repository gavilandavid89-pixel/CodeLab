# PixelForge — prueba de animación nativa en modo Illustration

**Estado:** proyecto generado con Headless, transferido por el inline artifact bridge y persistido en el workspace ADMIN. La exportación real A/B y la inspección visual del WebM están en curso.  
**Rama compartida permanente:** `test/pixelforge-illustration-impact-animation`  
**Proyecto PixelForge:** `abd33d81-5480-49a7-90e8-6818d2190460`  
**Workspace destino:** `ws_local_admin`

## Regla esencial de esta prueba

La animación se creó ejecutando el runtime oficial PixelForge Headless y sus acciones nativas. **No se utilizó generación de imágenes ni generación de vídeo por IA.** Tampoco se utilizó un GIF generado externamente como sustituto del proyecto.

El dibujo se construyó mediante acciones raster de PixelForge, y los fotogramas/cels se crearon y editaron mediante el modelo de animación de Headless. El proyecto se serializó mediante `runtime.toJSON()` y se empaquetó con `createPixelForgeCodeLabPackageZip(project)`.

El builder reproducible está versionado en `projects/animation-inbox/impact-illustration/build-project.mjs`. El workflow de Project Inbox lo ejecuta para generar el paquete nativo y después transfiere los bytes fuera del Headless mediante el bridge documentado. El Headless no recibe credenciales ni se conecta al bridge.

## Objetivo y alcance visual

La secuencia es un primer animatic técnico inspirado en la acción solicitada a partir de la referencia del usuario: el atacante lanza el golpe, el oponente sale despedido, rota durante el vuelo y cae al suelo.

**Importante:** este primer pase es una reconstrucción esquemática dibujada con herramientas nativas, no una reproducción detallada del manhwa ni una animación final de calidad artística. La referencia original se usó como guía visual, no como fotograma generado. La calidad artística y la continuidad siguen sujetas a la inspección del WebM real exportado por A/B.

## Proyecto nativo persistido

- Formato: paquete CodeLab v2 / PixelForge `.codelab`.
- Project ID: `abd33d81-5480-49a7-90e8-6818d2190460`.
- Canvas: 160 × 214 px.
- Capas raster: 3 (`Escenario`, `Atacante — Illustration`, `Oponente — Illustration`).
- Frames: 8.
- FPS: 12.
- Duraciones: 100, 80, 80, 80, 80, 90, 150 y 400 ms.
- Duración total: 1.060 ms.
- Loop: desactivado.
- Memoria de cels informada por el runtime: 3.287.040 bytes.
- Todas las capas y los 24 cels tienen `authoringMode: illustration`.

## Acciones Headless usadas

- `drawing.mode.set` para activar Illustration en las capas trabajadas.
- `canvas.fill`, `canvas.draw_stroke` y `canvas.draw_shape` para construir el escenario y las figuras.
- `canvas.erase_region` para limpiar la capa del oponente antes de dibujar la pose siguiente.
- `animation.frame.capture_document` para inicializar el timeline.
- `animation.frame.set_cel` para asignar explícitamente cada cel en modo Illustration.
- `animation.frame.duplicate` para crear los fotogramas siguientes.
- `animation.frame.set_duration`, `animation.set_fps` y `animation.set_loop` para configurar el timing.
- `createProposal`, `acceptProposal` y `toJSON()` para revisar, aceptar y serializar el proyecto.

El atacante y el escenario permanecen en capas separadas y estables; la capa del oponente contiene la progresión de poses. No se mezcla Pixel Art.

## Transferencia y persistencia comprobadas

- Workflow de importación: [Import PixelForge project inbox — run 45892407880](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45892407880), conclusión **success**.
- Import request: `repo-inbox-impact-illustration-45892407880`, estado `succeeded`.
- Command ID: `8759f4b5-1739-4904-85c5-bfc21d4c4708`, acción `codelab_project_import`, estado `succeeded`.
- El worker informó 8 frames y 24 animation cels instalados en `ws_local_admin`.
- La fila persistida en `codelab_pixelforge_projects` confirma el ID, nombre, dimensiones, 3 capas, 8 frames, 12 FPS, loop desactivado y `server_revision = 1`.
- SHA-256 del contenido persistido: `21ba2d51d952adf73085836e74741444516663325209b760cc24f88b586f38f7`.

HTTP 202 se trató únicamente como confirmación de encolado; la prueba esperó el worker y verificó tanto el comando completado como el proyecto persistido en el workspace destino.

## Inspección Headless previa

Se inspeccionaron los 8 compuestos renderizados por PixelForge en una hoja de contacto. Se confirmó la progresión general de preparación, impacto, retroceso, vuelo, rotación, descenso y pose final en el suelo. Esta revisión confirma la estructura y el primer animatic, pero **no sustituye la inspección del WebM real de A/B**.

## A/B: exportación desde el editor real

- Workflow A/B: [CodeLab A/B real ADMIN export — run 45892620194](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45892620194).
- Proyecto solicitado por A/B: `abd33d81-5480-49a7-90e8-6818d2190460`.
- A mantiene la sesión del editor web y ejecuta la operación real de Video Composer.
- B solicita la exportación, recibe el WebM y lo verifica. B no dibuja ni genera la animación.

No declarar el vídeo aprobado hasta que B termine, el WebM completo se recupere y el agente inspeccione visualmente el archivo exacto que se entregará.

## Pendiente para cerrar la prueba integral

1. Esperar a que A publique READY y B termine la exportación real.
2. Recuperar el WebM desde el artefacto de B, no desde una previsualización local.
3. Reproducir/decodificar el vídeo completo y revisar continuidad, contacto, trayectoria, rotación, caída, anatomía y partes que acompañan el movimiento.
4. Si hay defectos, reabrir el proyecto persistido y corregirlo incrementalmente con el mismo Headless en modo Illustration.
5. Repetir la importación y A/B para la nueva revisión, y reinspeccionar el nuevo WebM.
6. Solo después de superar la inspección visual entregar el vídeo final.

Toda repetición y mejora de esta prueba, así como cualquier prueba futura de CodeLab, se realiza en la misma rama permanente compartida. No crear ramas de prueba adicionales.
