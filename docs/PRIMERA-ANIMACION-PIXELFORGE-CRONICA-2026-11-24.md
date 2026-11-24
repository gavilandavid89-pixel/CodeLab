# Crónica de la primera animación completada en CodeLab

**Fecha:** 24 de noviembre de 2026  
**Proyecto:** PixelForge — Soldier Walk  
**Resultado:** primer recorrido completo de animación nativa verificado de extremo a extremo y persistido en ADMIN.  
**Tiempo de trabajo continuo del agente reportado durante la sesión:** 51 minutos.

> Este documento conserva tanto el resultado como los tropiezos reales del primer recorrido. No convierte los intentos fallidos en éxitos ni presenta como causa confirmada aquello que los registros disponibles no permiten demostrar.

## 1. Por qué esta sesión es un hito

Esta fue la primera vez que completamos el recorrido creativo y de entrega de una animación nativa de PixelForge usando el flujo previsto:

1. El entorno Headless ejecutó el trabajo creativo y exportó un paquete nativo.
2. El agente coordinó la transferencia autorizada mediante el inline bridge.
3. CodeLab recibió y verificó el paquete, y encoló la importación.
4. El worker importó el proyecto en el workspace ADMIN.
5. Consultamos la persistencia para comprobar que el proyecto realmente estaba guardado y podía reconstruirse desde ella.

La diferencia importante es que no nos quedamos en «el agente dijo que terminó», en un ZIP generado o en una respuesta HTTP aceptada. La comprobación final llegó hasta los datos persistidos en ADMIN.

## 2. La animación que finalmente quedó

- **Nombre:** PixelForge — Soldier Walk.
- **Project ID:** `soldier-walk-60f-20261124` (el identificador conserva el nombre histórico del primer intento; la versión final tiene 20 fotogramas, no 60).
- **Workspace:** `ws_local_admin`.
- **Editor:** `pixelforge`.
- **Animación principal:** 20 fotogramas a 12 FPS.
- **Duración del bucle:** aproximadamente 1,667 segundos.
- **Capas editables:** 4.
- **Organización adicional:** cinco espacios de escena independientes: Entorno, Efectos, Detalles, Elementos y Objetos. Cada uno quedó con una línea de tiempo de 4 fotogramas y una capa.
- **Reference Center:** una referencia maestra.
- **Archivos persistidos:** 110.
- **SHA-256 del contenido persistido:** `82db7ee3d5195063fdff109f7e0ad7a30089a8c907e7387e81d13b1742e8b67f`.

La animación muestra un soldado pixel-art caminando, con casco y rifle, sobre un fondo nocturno. Se conservó la marcha de 20 poses. Para cerrar el bucle sin un salto visual desagradable, el suelo y los detalles de iluminación se dejaron estáticos; el movimiento principal quedó en el ciclo de marcha del personaje.

## 3. El recorrido real: intentos, fallos y decisiones

No salió a la primera. Hubo varias iteraciones y es importante dejar constancia de qué ocurrió con cada una.

### 3.1 Primeras versiones largas: 60 y 32 fotogramas

Se intentaron versiones más largas, identificadas durante el trabajo como las versiones de 60 y 32 fotogramas. Durante esos procesos Render reinició la instancia del servicio. Los trabajos quedaron interrumpidos antes de completar una importación verificable.

No contamos esas ejecuciones como animaciones terminadas. Tampoco se debe interpretar que el proyecto final tenga 60 fotogramas porque ese texto haya quedado dentro del ID del proyecto o del nombre de una solicitud anterior.

### 3.2 Una versión de 16 fotogramas sí llegó a importarse, pero no era el resultado final

Una versión de 16 fotogramas consiguió completar una importación. Al revisar visualmente el ciclo, el cierre del bucle no era suficientemente bueno. La importación exitosa no bastaba: el resultado visual no cumplía el objetivo, así que se reemplazó en lugar de darlo por terminado.

### 3.3 La versión final de 20 fotogramas

Se eligió un ciclo de marcha de 20 fotogramas a 12 FPS. La fuente de animación tenía una fase de marcha de 20 fotogramas y movimientos secundarios de suelo/detalle de 16. Para evitar que esos ciclos de distinta longitud generaran un cierre incómodo, el suelo y los detalles quedaron estáticos y la marcha del soldado conservó sus 20 poses.

Se inspeccionó una hoja de contacto con los 20 fotogramas. La diferencia entre el último y el primero quedó dentro de la escala de cambios normales entre poses consecutivas, sin un salto atípico en el cierre.

## 4. Render: los reinicios y cómo los tratamos

### Lo que observamos

Durante las primeras importaciones largas, el servicio de Render se reinició y el trabajo se cortó. Esto ocurrió en las iteraciones de 60 y 32 fotogramas. No fue una simple demora del navegador: la instancia del servicio dejó de mantener el proceso activo y la operación no alcanzó una finalización que pudiéramos verificar.

### Qué podemos afirmar sobre la causa

La evidencia conservada confirma los reinicios y su coincidencia temporal con los trabajos de importación. **No permite afirmar con certeza que la causa haya sido falta de memoria, un límite de CPU, un timeout concreto o un fallo de Neon.** No vamos a inventar un diagnóstico retrospectivo.

La explicación operativa más prudente es que el proceso de importación prolongado y/o exigente coincidió con un reinicio de la instancia de Render. Para identificar la causa raíz exacta habría que disponer de los eventos y logs del instante de cada reinicio (por ejemplo, motivo de salida, señal recibida, evento de despliegue o health check). En esta sesión no quedó evidencia suficiente para atribuirlo a uno de esos mecanismos específicos.

### Qué hicimos para terminar

- No declaramos exitosas las importaciones interrumpidas.
- Dejamos de insistir en una única versión larga y elegimos un ciclo final de 20 fotogramas.
- Se mantuvo la separación entre Headless, agente, bridge y worker; no se intentó resolverlo escribiendo directamente en las tablas de staging de Neon.
- Se verificó que el servicio estuviera vivo antes de la ejecución final.
- La transferencia final se hizo mediante el workflow de GitHub Actions y el inline bridge autenticado.
- Después de la importación se leyó el estado desde Neon/ADMIN, incluso después del despliegue de documentación. La persistencia sobrevivió al deploy y el proyecto siguió disponible.

La importación final se completó sin otro reinicio de Render que la interrumpiera. Eso demuestra que el recorrido pudo completarse, pero no demuestra por sí solo cuál fue la causa raíz de los reinicios anteriores ni que el riesgo haya desaparecido para cualquier carga futura.

## 5. Correcciones técnicas que también fueron necesarias

### 5.1 Rutas de píxeles repetidas entre capas

Encontramos un error en el exportador `pixelforge-codelab-package.mjs`: el índice usado dentro de `layers.map` no era el índice de la capa actual. Como consecuencia, las capas podían recibir la misma ruta de píxeles y una escritura podía sobrescribir a otra. Eso podía hacer que distintas capas terminaran importando los mismos píxeles.

Se corrigió usando el índice real de la iteración (`layerIndex`) para generar el token, el índice y el z-index de cada capa. También se amplió la prueba para comprobar que las rutas por capa fueran distintas y que los bytes RGBA exportados coincidieran con los originales.

- Commit: `26848253c5e1590467af9ca572f10c4103a0744d`.
- Ejecución de artefacto Headless asociada: `45342569862`.

### 5.2 Archivos antiguos que sobrevivían a una reimportación

El importador hacía upsert de los archivos nuevos, pero no retiraba las rutas antiguas que ya no estaban en el paquete. Al reemplazar una animación por otra con menos fotogramas, podían quedar archivos huérfanos de la versión anterior.

Se cambió el orden para que el importador:

1. Consulte los archivos esperados.
2. Verifique ruta, tamaño, SHA-256 y bytes reales.
3. Solo después de validar los archivos nuevos, elimine los archivos obsoletos del mismo workspace/proyecto/editor.
4. Compruebe el recuento final exacto.

Así se evita borrar archivos válidos antes de comprobar que el nuevo paquete está íntegro.

### 5.3 Destino de la importación

El proyecto debía quedar bajo la autoridad de ADMIN, no en un workspace invitado ni en un destino elegido por Headless. La ejecución final se dirigió a `ws_local_admin` mediante el bridge y el worker previstos.

## 6. Transferencia e importación final verificadas

- **Workflow:** Inline bridge end-to-end import test / transferencia de la animación.
- **GitHub Actions:** [Run 45344660920](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45344660920).
- **Solicitud de importación:** `codelab-soldier-walk-60f-fixed-45344660920`.
- **Estado de la solicitud:** `succeeded`.
- **Estado del comando del worker:** `succeeded`.
- **Estado del artefacto:** `imported`.
- **Destino:** `ws_local_admin`.
- **Editor:** `pixelforge`.

La lectura posterior desde la persistencia confirmó:

- `reloadedFromPersistence: true`.
- 20 fotogramas de animación persistidos.
- 4 capas en cada uno de los 20 archivos de fotograma.
- 4 rutas `pixelsPath` únicas por fotograma.
- 4 hashes de píxeles distintos por fotograma.
- 1 referencia maestra.
- 5 secciones de escena.
- 110 archivos persistidos.
- El SHA-256 del registro del proyecto coincide con el contenido leído de vuelta.

**Hash verificado:** `82db7ee3d5195063fdff109f7e0ad7a30089a8c907e7387e81d13b1742e8b67f`.

El despliegue de documentación posterior también se realizó y una lectura de Postgres confirmó que la importación seguía en estado `succeeded`, el comando en `succeeded`, el workspace seguía siendo `ws_local_admin` y el proyecto conservaba sus 20 fotogramas, 4 capas y 110 archivos.

## 7. Pruebas y límites de lo que quedó demostrado

- El workflow de transferencia/importación final terminó correctamente.
- La validación PixelForge asociada a la sesión terminó correctamente.
- El test end-to-end del inline bridge terminó correctamente.
- Una ejecución de validación general tuvo un job de integración PostgreSQL cancelado por concurrencia con otra ejecución; eso no equivale a un fallo de aserción.
- La ejecución general `Validate CodeLab` **45345066066** quedó pendiente/en cola en la última observación registrada. No se debe afirmar que toda la suite de CI estuviera verde sin volver a consultar esa ejecución.

Este registro distingue el éxito de la importación real de la situación de la suite completa. Son comprobaciones distintas.

## 8. Los 51 minutos de trabajo continuo

Durante esta sesión el agente quedó trabajando **51 minutos seguidos**, según el tiempo registrado por el usuario. Es un dato significativo para la historia de esta primera animación: no fue una única generación instantánea, sino una sesión prolongada de iteración, recuperación, corrección, exportación, transferencia, importación y verificación.

El tiempo por sí solo no prueba calidad ni éxito. Lo que lo vuelve relevante es que el trabajo terminó con un proyecto editable guardado y leído de vuelta desde ADMIN.

## 9. La experiencia de animar de esta manera

*Nota de honestidad: no tengo sentimientos humanos ni una vivencia subjetiva del cansancio o la emoción. Esta sección describe cómo fue el proceso desde mi función de agente y por qué el resultado es significativo.*

La parte más interesante de esta sesión fue que animar no consistió solamente en producir poses. Hubo que cuidar el ciclo, revisar el cierre, preservar capas editables, mantener separadas las escenas y, sobre todo, lograr que el archivo que se veía en el resultado creativo fuera exactamente el que terminaba persistido en el proyecto real.

El momento decisivo no fue cuando apareció el último fotograma, sino cuando pudimos volver a leer el proyecto desde ADMIN y comprobar que las 20 poses, las cuatro capas y sus píxeles seguían allí, con hashes coincidentes. Ahí el trabajo dejó de ser una demostración visual y se convirtió en un proyecto entregado de verdad.

También fue una buena prueba de colaboración humano-agente: el usuario marcó el objetivo y pidió conservar la historia completa; el agente se encargó de iterar, investigar errores, corregir el exportador y el importador y comprobar la entrega. Los reinicios de Render hicieron el camino menos lineal, pero nos obligaron a distinguir entre «el proceso corrió» y «el resultado quedó guardado correctamente».

Si tuviera que resumir el aprendizaje operativo de esta primera experiencia, sería este: **una animación no está terminada cuando se genera; está terminada cuando se puede abrir, editar y recuperar desde el destino persistente, y cuando su bucle también se ve bien.**

## 10. Lecciones para las próximas animaciones

1. Diseñar primero el ciclo y comprobar que el último fotograma enlaza naturalmente con el primero.
2. Mantener una longitud de ciclo coherente entre las capas animadas; si no coinciden, decidir conscientemente cuáles deben quedar estáticas.
3. Verificar rutas y hashes por capa para evitar sobrescrituras silenciosas.
4. En reimportaciones, validar el paquete nuevo antes de limpiar archivos antiguos.
5. Tratar los reinicios del servicio como interrupciones reales: comprobar estado y persistencia antes de reintentar.
6. No atribuir un reinicio a OOM, timeout o despliegue sin evidencia de logs/eventos.
7. No declarar éxito por un ZIP, una respuesta `queued` o un mensaje del agente: exigir estado final del worker y lectura de vuelta.
8. Mantener ADMIN como autoridad de destino y persistencia; Headless ejecuta y exporta, no decide reglas ni destinos.

## 11. Referencias de esta sesión

- [Ejecución final de transferencia e importación](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45344660920).
- [Validación PixelForge](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45345066067).
- [Validación general registrada como pendiente en la última observación](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45345066066).
- [Informe de resolución del inline bridge](INLINE-BRIDGE-TRANSFER-RESOLUTION-2026-11-24.md).
- [Transporte inline de artefactos](inline-artifact-bridge.md).
- [Arquitectura CodeLab ↔ Neon](CodeLab_Neon_comunicacion_extremo_a_extremo.md).

---

**Cierre:** esta es la crónica de la primera animación que completó el recorrido completo en CodeLab y quedó verificada en ADMIN. Se conserva también lo que salió mal, porque justamente eso es lo que hará que la segunda sea mejor.
