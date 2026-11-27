# PixelForge — El ser devora la galaxia (27-11-2026)

**Estado creativo:** animación editable de 60 fotogramas construida y validada con el Headless distribuido; vista previa WebM reproducida e inspeccionada bajo Xvfb.  
**Estado de entrega:** el paquete está preparado localmente, pero todavía no se ha importado ni leído de vuelta desde el workspace ADMIN. El vídeo A/B del Video Composer real queda pendiente hasta completar esa importación.

## Objetivo visual

Partir del frame 0 original de la captura del usuario, recortando exclusivamente la ilustración central y descartando toda la interfaz de TikTok. El ser conserva su diseño y la boca permanece abierta. La galaxia entra desde la derecha, se acelera hacia la boca, se comprime y desaparece dentro de ella. No hay movimiento de masticación ni ciclo de cierre de mandíbula.

## Recursos y dibujo

- Frame 0: recorte cuadrado de la ilustración central de la captura del 26-11-2026, redimensionado a 384 × 384 px.
- Textura auxiliar: se tomó únicamente el disco galáctico de una de las referencias generadas en la sesión anterior; no se sustituyó la criatura del usuario por la criatura generada.
- Dibujo Headless: se añadieron brazos espirales y estrellas con las acciones raster documentadas `canvas.draw_shape` y `canvas.draw_stroke`. La textura generada y el dibujo raster se combinaron como el sprite de galaxia que se mueve en los cels posteriores.
- Movimiento de cámara: avance progresivo de aproximadamente 5,5 % y una traslación de 8 px hacia delante alrededor de la boca para dar sensación de que el ser colosal se impulsa hacia la galaxia.
- La galaxia comienza completamente dentro del lienzo; la primera prueba se corrigió porque el sprite quedaba cortado por el borde derecho.

## Timeline implementado

| Propiedad | Valor |
|---|---:|
| Canvas | 384 × 384 px |
| Fotogramas | 60 |
| FPS | 8 |
| Duración | 7,5 s |
| Duración por fotograma | 125 ms |
| Capas | 1 |
| Loop | Desactivado |
| Memoria raster reportada | 35.389.440 bytes |
| Formato | PixelForge / CodeLab v2 |

Los 60 fotogramas tienen IDs únicos y cels RGBA independientes. La secuencia cubre atracción, aproximación/absorción y desaparición con resplandor residual. El frame 0 conserva la ilustración original sin galaxia añadida.

## Headless y validación

Se utilizó el artefacto oficial `agent-headless-latest` del workflow de empaquetado y se extrajo el runtime distribuido junto con el exportador canónico `pixelforge-codelab-package.mjs`.

- El artefacto del runtime se inició con `createHeadlessRuntime`.
- El dibujo auxiliar de la galaxia se realizó con las acciones raster de PixelForge Headless.
- El frame 0 se convirtió en la base de la timeline; los cels de los 59 fotogramas siguientes contienen el movimiento de la galaxia y el avance de cámara.
- La propuesta de revisión de la timeline fue aceptada por Headless.
- La reapertura del proyecto en Headless validó 60 fotogramas, 8 FPS, 7.500 ms y 35.389.440 bytes de memoria raster.
- El exportador canónico produjo un paquete CodeLab v2 con 131 entradas.
- `unzip -t` terminó sin errores de estructura/CRC.

## Vídeo de vista previa e inspección visual

Se generó una vista previa local para inspección, no como sustituto del A/B final:

- Archivo: `el-ser-devora-la-galaxia-preview.webm`
- Códec: VP9
- Resolución: 384 × 384 px
- Frecuencia: 8 FPS
- Duración: 7,500 s
- Tamaño: 95.663 bytes
- SHA-256: `a5e52cb4465be7b715cfab21baf547c1a6a0b0ad2fd0e812c05a67d27652847c`

La reproducción se abrió con FFplay bajo Xvfb y se inspeccionaron capturas intermedias y tardías, además de una hoja de contacto con muestras distribuidas por la timeline. Se comprobó que la galaxia se desplaza hacia la boca, entra y desaparece; la mandíbula permanece abierta. Durante la revisión se corrigió el recorte inicial del sprite en el borde derecho. La captura de Chromium sobre `file://` y localhost quedó bloqueada por la política del navegador del entorno; la reproducción visual bajo Xvfb se realizó con FFplay.

Esta vista previa es evidencia visual local de la composición actual. **No es todavía el WebM exportado por el Video Composer A/B de CodeLab**, por lo que no se debe etiquetar como entrega A/B final.

## Paquete editable preparado

- Archivo: `el-ser-devora-la-galaxia-final.codelab`
- Tamaño: 36.285.228 bytes
- SHA-256: `cd0bf1bdb5b1505477b3706d6555c1eeed8970daebe5bb1cb1718de88fd6b11f`
- Project ID: `ceded9dd-3738-4a2e-ae86-fd09d3e7bc4a`

El paquete usa el formato CodeLab v2: `project.codelab-pixelforge`, `manifest.json`, `project.json`, `integrity.json`, `Frames/frames.tscn`, JSON de fotogramas y cels RGBA.

## Bloqueo de importación y siguiente paso

El paquete todavía no está persistido en `ws_local_admin`. El destino previsto sigue siendo la carpeta privada de Neon Object Storage:

- Bucket: `codelab-agent-projects`
- Prefijo: `incoming/`
- Panel alternativo de importación ADMIN: https://codelab-qedi.onrender.com/admin/project-folder

En esta sesión el entorno de trabajo no dispone de una operación de subida binaria HTTP PUT hacia la URL firmada de Neon, y el acceso de red saliente desde el contenedor no resuelve DNS. El panel alternativo exige una sesión ADMIN del navegador que no está disponible en este runtime. Por tanto, no se ha podido depositar el paquete ni disparar el importador real.

Cuando el paquete se cargue, el cierre obligatorio es: esperar estado terminal `succeeded`, comprobar el proyecto en `ws_local_admin`, leerlo de vuelta y verificar revisión/hash; después iniciar el workflow A/B independiente para que A exporte el proyecto ADMIN real mediante el Video Composer y B reciba/verifique el WebM. El agente debe inspeccionar ese mismo WebM bajo Xvfb, corregir el proyecto si encuentra defectos y repetir A/B antes de entregar el vídeo final.

## Conservación

No se modificó ni eliminó ningún proyecto preexistente. La captura original y las referencias generadas se conservaron en el entorno de trabajo; el paquete editable contiene la imagen de base y los cels finales. La importación debe crear una identidad nueva con el Project ID indicado arriba.
