# PixelForge Video Composer — composición multiplataforma

## Propósito

El Video Composer adapta una animación de PixelForge a distintos formatos de salida sin modificar el proyecto maestro. La composición de salida cambia únicamente durante preview/exportación.

El proyecto maestro conserva:
- dimensiones originales del lienzo;
- píxeles y capas;
- fotogramas y duración;
- metadatos de authoringMode;
- capas Illustration y Pixel Art mezcladas;
- modelos vectoriales y demás datos editables.

## Perfiles de plataforma

Los perfiles viven en VIDEO_COMPOSITION_PROFILES dentro de public/pixelforge/src/video-capture-layout.mjs.

| Perfil | Plataforma | Relación | Salida 1080 |
|---|---|---:|---:|
| youtube-landscape | YouTube | 16:9 | 1920×1080 |
| tiktok-vertical | TikTok | 9:16 | 1080×1920 |
| shorts-vertical | YouTube Shorts | 9:16 | 1080×1920 |
| instagram-feed | Instagram feed | 4:5 | 1080×1350 |
| instagram-square | Instagram | 1:1 | 1080×1080 |
| facebook-landscape | Facebook | 16:9 | 1920×1080 |

El selector de Video Composer también permite auto, que conserva la proporción del lienzo original dentro de límites seguros.

Un perfil es un preset de salida, no un nuevo tipo de lienzo. Elegir Instagram 4:5, por ejemplo, no convierte el proyecto maestro a 4:5.

## Resolución y proporción

getCaptureDimensions(resolution, aspect, sourceWidth, sourceHeight) calcula las dimensiones finales.

- 720p usa 720 como dimensión base.
- 1080p usa 1080 como dimensión base.
- La proporción se mantiene exactamente.
- auto usa la proporción del lienzo original, limitada a un rango operativo de 1:3 a 3:1.

La salida nunca debe obtenerse aplicando factores independientes de X e Y.

## Ajustes de contenido

Hay dos estrategias:

### Contain

Escala uniformemente para que todo el lienzo original entre en la salida.

Si las proporciones no coinciden:
- no se recorta contenido;
- no se deforma;
- quedan espacios libres que pueden rellenarse con el fondo.

### Cover

Escala uniformemente hasta llenar toda la salida.

Si las proporciones no coinciden:
- no se deforma;
- se recorta la parte que queda fuera del encuadre;
- el recorte actual se calcula alrededor del centro.

Esto es importante: cover es un recorte, no un estiramiento.

## Guía de composición

getCompositionGuide(sourceWidth, sourceHeight, targetWidth, targetHeight) calcula:
- tamaño del origen;
- tamaño objetivo;
- safeArea;
- coordenadas normalizadas de esa zona segura.

La safeArea representa la parte del lienzo original que será visible cuando se use cover. El agente puede usarla para mantener personajes, texto y acción importante dentro de los límites de una futura salida.

## Perfiles y agentes

buildAgentCompositionGuide() expone al agente:
- plataforma;
- relación de aspecto;
- perfil de salida;
- dimensiones;
- modo contain o cover;
- zona segura;
- modos de dibujo presentes;
- modo de cada capa por fotograma;
- reglas para no estirar el contenido.

El agente debe tratar el perfil como una restricción de composición, nunca como permiso para modificar el proyecto fuente.

## Pixel Art e Illustration

La composición global puede escalarse uniformemente, pero cada capa conserva su tratamiento:
- Illustration → interpolación suave.
- Pixel Art → muestreo sin suavizado.

Esto permite mezclar ambos estilos en un mismo fotograma sin que la exportación de uno altere el tratamiento del otro.

## Arquitectura actual y evolución

El sistema actual separa correctamente:
1. Proyecto maestro — contenido editable.
2. Perfil de salida — plataforma y proporción.
3. Ajuste — contain o cover.
4. Render de salida — composición temporal.
5. Codificación — WebM mediante el encoder existente.

La evolución Smart Reframe ya tiene una primera implementación. Debe seguir siendo una capa adicional sobre esta arquitectura, no reemplazarla.

La primitiva coverSourceRectAtFocalPoint(sourceWidth, sourceHeight, targetWidth, targetHeight, focalPoint) calcula un recorte con escala uniforme alrededor de un punto normalizado. El punto se limita a 0..1 y el recorte se desplaza hasta no salir de los límites del lienzo.

El Video Composer expone actualmente cinco preferencias simples de reencuadre: centro, arriba, abajo, izquierda y derecha. Estas preferencias se convierten en puntos normalizados y se aplican tanto a la captura como al encoder/worker. El lienzo maestro y sus capas no cambian.

Esta primera versión es deliberadamente determinista: no pretende detectar personajes mediante IA todavía. El siguiente paso es sustituir el punto fijo por una trayectoria de interés por fotograma y suavizar esa trayectoria temporalmente, evitando saltos de cámara.

## Regla de no deformación

Nunca usar una escala donde scaleX sea diferente de scaleY para adaptar el proyecto completo al formato de una plataforma.

Para contain y cover, la escala global debe ser uniforme. La diferencia de proporciones se resuelve mediante espacio libre o recorte.

## Pruebas

La cobertura del Video Composer verifica:
- presets 16:9, 9:16, 1:1 y 4:5;
- cálculo de dimensiones;
- zonas seguras;
- contain;
- cover;
- ausencia de estiramiento;
- muestreo independiente de Illustration/Pixel Art;
- propagación de fitMode hasta el encoder/worker;
- guía legible por agentes;
- desplazamiento del crop hacia un punto de interés sin cambiar su tamaño ni deformar el origen.

Cuando se agregue Smart Reframe, deberá existir una prueba independiente que compruebe que el encuadre puede desplazarse sin cambiar las dimensiones del proyecto fuente y que el movimiento del encuadre es estable entre fotogramas.