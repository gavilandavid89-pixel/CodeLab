# PixelForge — prueba de impacto en modo Illustration

**Estado:** proyecto nativo generado y validado mediante Headless; pendiente de inspección visual dentro del editor web y del Video Composer.  
**Rama compartida de pruebas:** `test/pixelforge-illustration-impact-animation`  
**Headless utilizado:** artefacto creado desde el commit `e8a18aee68335ff0dda88301eee08826e79272a6`.

## Objetivo

Probar una secuencia de acción inspirada en la imagen de referencia proporcionada por el usuario: el personaje de camiseta clara prepara y ejecuta un golpe; el oponente sale despedido, cae al suelo y permanece tendido. Esta prueba usa exclusivamente el modo **Illustration**.

El resultado visual es una reinterpretación animada de la escena, no una edición píxel a píxel de la imagen original.

## Proyecto generado

- Formato: paquete nativo CodeLab / PixelForge v2 (`.codelab-pixelforge`).
- Canvas: 128 × 192 px, con el contenido ajustado manteniendo la proporción y margen blanco.
- Timeline: 16 frames.
- Velocidad: 8 FPS.
- Duración: 2.000 ms (16 × 120 ms).
- Loop: desactivado.
- Capas: una capa raster con la escena completa.
- Modo activo en Headless: `illustration`.

La prueba usa una capa aplanada para validar el flujo de animación primero. No demuestra todavía una separación editable de personajes, fondo, efectos o partículas en capas independientes.

## Verificaciones realizadas

1. Se obtuvo el paquete Headless desde Actions para el SHA exacto de la rama de pruebas.
2. Se creó el timeline a través de las acciones del runtime Headless.
3. Se asignó `authoringMode: illustration` explícitamente a cada operación `animation.frame.set_cel`.
4. Se verificaron los 16 contextos de frame y capa: todos devuelven `illustration`.
5. También se verificó el modo de autoría de la capa base del proyecto y de las 16 entradas de capa del paquete: todos son `illustration`.
5. Se verificó que las operaciones no bloquearon píxeles (`blockedPixels: 0`).
6. Se creó y aceptó la propuesta Headless antes de serializar el proyecto.
7. Se generó el paquete nativo y se comprobó la integridad ZIP: 43 entradas, sin errores de compresión.
8. El manifiesto identifica un proyecto PixelForge v2 con 16 frames, 8 FPS y un canvas de 128 × 192.

## CI y workflows

- [Agent Headless Package — ejecución 45884373441](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45884373441): **success**.
- [CodeLab 5s soldier animation — ejecución 45884373522](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45884373522): **success**.
- [CodeLab 5s soldier animation — ejecución anterior 45884369937](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45884369937): **success** después de fijar el runner a Ubuntu 24.04.

El workflow de 5 segundos es una prueba visual preexistente del showcase; no debe confundirse con una reproducción E2E del nuevo paquete de impacto.

## Pendiente para cerrar la prueba integral

- Importar el paquete generado en el editor web de PixelForge.
- Confirmar que el timeline muestra los 16 frames y reproduce la secuencia completa.
- Inspeccionar visualmente continuidad, golpe, trayectoria aérea, contacto con el suelo y pose final.
- Exportar la animación desde CodeLab y comprobar que el archivo se reproduce y conserva las proporciones.
- Verificar la importación/exportación del modo Illustration y que ningún flujo la convierta a Pixel Art.
- Si se separan personajes o efectos en capas, comprobar que los metadatos de modo se conservan en cada capa/frame.

No declarar la prueba integral como completada hasta resolver esos puntos. Los resultados y evidencias de cualquier repetición deben añadirse a esta misma documentación y a esta misma rama compartida; no crear otra rama de pruebas.
