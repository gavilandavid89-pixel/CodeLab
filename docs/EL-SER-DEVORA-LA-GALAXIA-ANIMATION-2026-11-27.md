# PixelForge — El ser devora la galaxia (27-11-2026)

**Estado creativo:** continuación v8 construida con PixelForge Headless; 60 fotogramas, 8 FPS, dos capas editables y movimiento del ser respecto al fondo.  
**Estado de revisión:** MP4 de previsualización reproducido con FFplay bajo Xvfb y hoja de contacto de los 60 fotogramas inspeccionada.  
**Estado de entrega:** paquete local preparado; todavía no importado en `ws_local_admin`. El Video Composer queda expresamente pospuesto hasta que el usuario lo solicite.

## Corrección de continuidad solicitada

La versión anterior fue descartada como base creativa porque añadía otra galaxia delante del ser y dejaba al ser prácticamente inmóvil. La nueva versión parte del frame 0 original del proyecto/captura:

- No se introduce una segunda galaxia.
- El óvalo luminoso que ya aparece dentro de la boca se conserva como la galaxia original.
- La galaxia no se reduce ni colapsa como un agujero negro.
- La mandíbula permanece abierta; no se agrega masticación ni ciclo de cierre.
- El ser se mueve respecto al fondo: avanza hacia delante y a la derecha, aumenta de escala y presenta una ondulación suave durante el avance.
- La galaxia permanece dentro de la boca y acompaña el movimiento del ser. No se simula un desplazamiento independiente de la galaxia respecto de la boca en esta versión.

## Capas y composición

Se separó la imagen de origen en dos capas:

1. **Fondo atmosférico:** placa reconstruida con la textura/grano del fondo visible original, estática durante la secuencia.
2. **Ser colosal · cuerpo y galaxia original:** recorte con máscara suave que conserva la criatura, dientes, boca abierta y el brillo galáctico original.

El frame 0 compuesto se comparó con la fuente redimensionada; el error absoluto medio de los canales RGB fue aproximadamente 0,61 niveles sobre 255. La separación mantiene prácticamente intacta la apariencia de la imagen original.

El canvas se fija en 360 × 360 px para conservar dos capas editables durante 60 fotogramas dentro del límite de memoria raster de PixelForge.

## Movimiento implementado con Headless

Cada una de las 59 poses posteriores se generó abriendo el proyecto base en el runtime Headless instalado y aplicando `canvas.transform_region` únicamente a la capa del ser. Cada pose editada pasó por `createProposal`, `getDiff` y `acceptProposal` antes de reutilizar sus píxeles.

Movimiento aplicado de forma progresiva:

- Traslación horizontal máxima aproximada: 22 px.
- Escala horizontal máxima aproximada: 1,18×.
- Escala vertical máxima aproximada: 1,12×.
- Cizalla horizontal/vertical suave y oscilante para dar una ligera sensación de ondulación corporal.
- Interpolación bilineal para evitar escalones en el borde del recorte.

El fondo permanece fijo, por lo que el desplazamiento y crecimiento del ser se perciben respecto al entorno y no como un zoom aplicado a toda la imagen. La galaxia original forma parte de la misma capa del ser: conserva su tamaño relativo y sigue dentro de la boca.

## Timeline validada por Headless

| Propiedad | Valor |
|---|---:|
| Canvas | 360 × 360 px |
| Fotogramas | 60 |
| FPS | 8 |
| Duración | 7,5 s |
| Duración por fotograma | 125 ms |
| Capas | 2 |
| Memoria raster de animación | 62.208.000 bytes |
| Límite de memoria | 64 MiB |
| Loop | Desactivado |
| Formato | CodeLab / PixelForge v2 |

El proyecto final se reabrió con `createHeadlessRuntime`; `animation.get_summary` confirmó 60 fotogramas, 8 FPS, 7.500 ms, dos capas y 62.208.000 bytes, por debajo del límite de 64 MiB. Se serializó con `runtime.toJSON()` después de revisar y aceptar la propuesta final, y se empaquetó mediante el helper oficial `createPixelForgeCodeLabPackageZip()`.

## Previsualización e inspección

El MP4 local se generó con FFmpeg para revisión; no es una exportación del Video Composer.

- Archivo: `el-ser-devora-la-galaxia-v8-preview.mp4`
- Códec: H.264
- Resolución: 360 × 360 px
- Frecuencia: 8 FPS
- Duración: 7,500 s
- Tamaño: 157.394 bytes
- SHA-256: `dccb6c7055a53216e0e811d9379ee33a2149054d8fef448d2f38b9a628954b52`

Se reprodujo con `ffplay` bajo Xvfb; el proceso terminó con código 0. También se generó una hoja de contacto con los 60 fotogramas y se inspeccionó visualmente la progresión. La revisión confirma que el ser crece y avanza respecto al fondo, el brillo original permanece dentro de la boca, no aparece otra galaxia y la mandíbula sigue abierta.

La hoja de contacto local es `el-ser-devora-la-galaxia-v8-contact.jpg`.

## Paquete editable preparado

- Archivo: `el-ser-devora-la-galaxia-continuacion-v8.codelab`
- Tamaño: 63.768.727 bytes
- SHA-256: `0fbe76e1f9a8ed41fc3b3200422bf5ba5c787909e698da4b7726e45e0a9ed869`
- Project ID: `ceded9dd-3738-4a2e-ae86-fd09d3e7bc4a`
- Capas: fondo atmosférico y ser colosal con la galaxia original
- Timeline: 60 fotogramas a 8 FPS

## Pendiente de persistencia

El paquete permanece en el entorno de trabajo local. No se ha enviado a Neon ni importado en `ws_local_admin` en esta continuación. Cuando se solicite persistirlo, usar el flujo ya documentado y verificar el estado terminal, lectura de vuelta y hash.

## Video Composer

No se modificó ni se integró el Video Composer en esta tarea, por indicación expresa del usuario. La previsualización MP4 se produjo con FFmpeg únicamente para revisar el movimiento. La integración del Composer directamente en el Headless del agente queda pendiente hasta que el usuario la solicite.

## Conservación

El frame 0 original y el paquete anterior se conservaron. Esta continuación usa una identidad de proyecto compatible y un nuevo paquete local; no se sobrescribió ningún proyecto persistido en CodeLab/Neon.
