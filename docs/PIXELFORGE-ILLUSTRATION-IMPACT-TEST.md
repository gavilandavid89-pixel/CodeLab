# PixelForge — prueba de animación nativa en modo Illustration

**Estado:** primera prueba técnica nativa creada con Headless; pendiente de importación al workspace CodeLab y revisión dentro del editor/Video Composer.  
**Rama compartida permanente:** `test/pixelforge-illustration-impact-animation`  
**Artefacto Headless ejecutado:** paquete publicado desde `e8a18aee68335ff0dda88301eee08826e79272a6`.  
**Fuente Headless:** sin cambios entre ese commit y el SHA `8df1a91fadc119d26a2580a30b6a76d932f4fa8c`; el diff intermedio contiene únicamente este documento de prueba.

## Regla esencial de esta prueba

La animación se creó ejecutando el runtime oficial PixelForge Headless y sus acciones nativas. **No se utilizó generación de imágenes ni generación de vídeo por IA.** Tampoco se utilizó un GIF generado externamente como sustituto del proyecto.

El dibujo se construyó mediante acciones raster de PixelForge, y los fotogramas/cels se crearon y editaron mediante el modelo de animación de Headless. El paquete final procede de `runtime.toJSON()` y `createPixelForgeCodeLabPackageZip(project)`.

## Objetivo y alcance visual

La secuencia es un primer animatic técnico inspirado en la acción solicitada a partir de la referencia del usuario: el atacante lanza el golpe, el oponente sale despedido, rota durante el vuelo y cae al suelo.

**Importante:** este primer pase es una reconstrucción esquemática dibujada con herramientas nativas, no una reproducción detallada del manhwa ni una animación final de calidad artística. La referencia original no se ha convertido en píxeles del proyecto ni se ha usado como fotograma generado. La siguiente iteración visual debe mejorar anatomía, semejanza con la referencia, poses intermedias, impacto y continuidad sin sustituir el flujo Headless.

## Proyecto nativo creado

- Paquete: `.codelab-pixelforge`, formato CodeLab v2 / PixelForge.
- Canvas: 160 × 214 px.
- Capas raster: 3 (`Fondo`, `Atacante`, `Oponente`).
- Frames: 8.
- FPS: 12.
- Duraciones: 7 frames de aproximadamente 83,33 ms y pose final de 500 ms.
- Duración total: aproximadamente 1.083 ms.
- Loop: desactivado.
- Memoria de cels informada por el runtime: 3.287.040 bytes.
- Todas las capas y todos los frames/cels tienen `authoringMode: illustration`.

## Acciones Headless usadas

- `drawing.mode.set` para activar Illustration en las capas trabajadas.
- `canvas.fill`, `canvas.draw_stroke` y `canvas.draw_shape` para construir el escenario y las figuras.
- `canvas.erase_region` para limpiar únicamente la región del oponente al avanzar de pose.
- `animation.frame.capture_document` para inicializar el timeline vacío con sus capas.
- `animation.frame.duplicate` para crear los fotogramas siguientes.
- `animation.frame.set_cel` con `authoringMode: illustration` para escribir cada cel de forma explícita.
- `animation.frame.set_duration`, `animation.set_fps` y `animation.set_loop` para configurar el timing.
- `createProposal`, `acceptProposal` y `toJSON()` para revisar, aceptar y serializar el proyecto.

El atacante y el fondo permanecen en capas separadas y estables; la capa del oponente contiene la progresión de poses. La prueba no mezcla Pixel Art.

## Verificación local del runtime y paquete

- El artefacto oficial Headless fue descargado desde GitHub Actions, extraído y ejecutado en Node.js dentro del entorno aislado disponible.
- El proyecto se creó mediante `createHeadlessRuntime` / `HeadlessEditorRuntime.fromJSON`.
- La propuesta fue aceptada antes de serializar.
- El paquete nativo se creó con el helper oficial incluido en el artefacto Headless.
- El manifiesto declara 3 capas, 8 frames, 12 FPS y canvas 160 × 214.
- Se inspeccionaron los 8 compuestos renderizados por `PixelForgeAnimation` en una hoja de contacto; se confirmó visualmente la progresión de golpe, vuelo, caída y pose final.
- Se verificó por lectura del proyecto que los 8 frames y los 24 cels tienen modo `illustration`.

## Evidencia

- Proyecto nativo local generado: `codelab-impact-illustration-native.codelab-pixelforge`.
- Hoja de contacto visual local: `codelab-impact-illustration-contact-sheet.jpg`.
- Resumen estructural: `codelab-impact-illustration-native-summary.json`.

Los archivos locales son evidencia de ejecución Headless, pero **todavía no prueban que el proyecto esté persistido en CodeLab**.

## Pendiente para cerrar la prueba integral

1. Transferir el paquete por el inline artifact bridge documentado, fuera del runtime Headless.
2. Esperar el resultado real del worker y comprobar el proyecto en el workspace destino; HTTP 202 por sí solo no demuestra persistencia.
3. Reabrir el proyecto en PixelForge y comprobar capas, timeline, modos y reproducción.
4. Mejorar la calidad artística y la continuidad usando el mismo flujo de dibujo/animación Headless, conservando el proyecto existente y corrigiendo incrementalmente.
5. Ejecutar la exportación desde el flujo real de CodeLab/Video Composer y revisar el vídeo reproducible.
6. No declarar la prueba completa hasta que la revisión visual confirme el resultado y la persistencia esté verificada.

Toda repetición y mejora de esta prueba, así como cualquier prueba futura de CodeLab, se realiza en la misma rama permanente compartida. No crear ramas de prueba adicionales.
