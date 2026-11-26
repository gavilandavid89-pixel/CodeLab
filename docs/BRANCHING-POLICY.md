# CodeLab — Branching Policy

## Regla única: solo se trabaja en main

**CodeLab tiene una única rama de desarrollo y pruebas: main.**

Todo trabajo nuevo, incluyendo implementación, pruebas, regresiones, experimentos, documentación y correcciones, se realiza directamente sobre main.

No se crean ni se mantienen ramas paralelas de trabajo para features, fixes, tests, regresiones, integration, experimentos, documentación, PixelForge, Illustration, Pixel, Animation, Video Composer, Headless, Agent, importación o exportación.

### Flujo obligatorio

~~~text
main
  ↓
cambio
  ↓
verificación local / CI / Actions
  ↓
corrección si hace falta
  ↓
verificación nuevamente
  ↓
main
~~~

Si una tarea necesita varias etapas, todas las etapas continúan sobre main. Si una prueba necesita repetirse, se repite sobre el estado actual de main.

**Una prueba no justifica crear otra rama.**

## Antes de cualquier trabajo

Todo agente debe:

1. Consultar el estado actual de main.
2. Confirmar el SHA actual de main.
3. Trabajar únicamente sobre main.
4. Ejecutar las verificaciones correspondientes.
5. Volver a comprobar main después de las verificaciones.
6. Documentar los cambios importantes.

origin/main es la fuente de verdad del estado vigente de CodeLab.

## Documentación: no puede haber dos verdades

**Antes de fusionar, integrar o considerar terminado cualquier cambio, la documentación relacionada de ambos lados debe coincidir.**

No se debe aceptar una integración mientras una parte diga una cosa y la otra otra.

Antes de dar por listo un cambio hay que:

- comparar la documentación relevante con main;
- actualizar la documentación necesaria;
- comprobar que nombres, contratos, comportamiento, límites y flujos descritos coincidan con la implementación real;
- comprobar que no queden instrucciones contradictorias;
- verificar nuevamente después de integrar.

**Código y documentación deben representar el mismo estado del sistema.**

No se debe fusionar una implementación que deje documentación vieja, incompleta o contradictoria con el código.

## Cómo se hacen las pruebas

Las pruebas deben ejecutarse sobre el main vigente.

Cuando una prueba sea experimental o de diagnóstico:

1. se parte del main actual;
2. se ejecuta la prueba sobre ese estado;
3. se registra el resultado;
4. si hay un problema, se corrige sobre main;
5. se vuelve a ejecutar la prueba;
6. se documenta el resultado.

No se conserva una rama paralela únicamente para guardar el resultado de una prueba.

## Ramas antiguas: clasificación para eliminación

Las siguientes ramas fueron identificadas durante la limpieza y **no forman parte del flujo de desarrollo actual**. Se consideran candidatas a eliminación porque están obsoletas, divergidas de main o corresponden a trabajo ya integrado/cerrado:

- feat/pixelforge-tiled-package-export
- test/pixelforge-raster-tools-e2e
- test/pixelforge-animation-browser-e2e
- test/video-composer-actions-worker
- feat/pixelforge-ui-tools-e2e
- feature/pixelforge-core-tool-regressions
- feature/pixelforge-raster-regression-tests
- integration/reconcile-main-2026-11-03

La rama feat/pixelforge-tiled-spritesheet-export ya fue integrada en main. Si todavía existe como referencia remota, debe tratarse como histórica y eliminarse cuando las herramientas de repositorio lo permitan.

### Qué hacer con una rama antigua

Si un agente encuentra una de estas ramas:

- **no debe continuar desarrollándola**;
- no debe tomarla como fuente de verdad;
- debe comparar cualquier trabajo exclusivo contra main;
- solo debe rescatar cambios que todavía sean necesarios;
- esos cambios deben aplicarse y verificarse sobre main;
- la rama debe quedar como histórica hasta poder eliminarla.

Las ramas antiguas no son una alternativa de desarrollo ni una segunda versión de CodeLab.

## Regla estricta para futuros agentes

Un agente **no debe crear otra rama** porque la tarea sea grande, tenga muchas etapas, necesite pruebas, sea experimental, requiera una regresión o pueda tardar varios días.

Todo eso se hace sobre main, con verificaciones intermedias y documentación.

### Principio final

~~~text
UNA RAMA DE DESARROLLO
        ↓
      main
        ↓
UNA FUENTE DE VERDAD
        ↓
código + documentación coherentes
~~~

**CodeLab se desarrolla y se prueba en una sola línea: main.**

**Antes de integrar cualquier cambio, la documentación de las partes involucradas debe coincidir con la implementación real.**

La existencia de ramas antiguas en GitHub no modifica esta política.
