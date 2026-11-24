# Política operativa del agente IA y del bridge de CodeLab

**Estado: vigente.** Esta política describe el flujo integrado: Headless propio aislado → transferencia por el agente al intermediario → CodeLab/Neon/worker → procesamiento A/B cuando la petición incluye vídeo → entrega final al usuario. A/B no es obligatorio para tareas sin vídeo. Para conexiones, esquema SQL, diagramas y detalles de implementación, consultar [la documentación técnica CodeLab ↔ Neon](CodeLab_Neon_comunicacion_extremo_a_extremo.md).

Para la transferencia de paquetes editables desde el Headless aislado del agente, consultar también [Transporte inline de artefactos Headless → CodeLab](inline-artifact-bridge.md). Inline es el intermediario HTTPS de staging/importación. El Headless no se conecta a él: el agente recoge el archivo exportado y lo transfiere fuera del Headless. A/B es una etapa integrada para producir el vídeo final cuando la tarea lo requiere.

## 0. Identidad ADMIN y autenticación existente

Antes de diagnosticar un bloqueo de bridge, reutilizar y verificar la conexión administrativa ya disponible, resolver la cuenta y el workspace destino y revisar las acciones soportadas. No pedir al usuario secretos ni reconfigurar autenticación por la ausencia de una variable visible en el runtime Headless. La autenticación de la cuenta ADMIN y el token interno de una ruta HTTP son capas distintas: comprobar la capa que falla antes de concluir. Seguir [Recuperación de identidad ADMIN y continuidad del bridge](ADMIN-AUTH-AND-BRIDGE-RECOVERY.md).

## 1. Arquitectura y responsabilidades

Flujo canónico:

```text
Usuario
  ↓ petición explícita
Agente IA
  ↓ trabaja en su entorno headless
Headless propio del agente
  ↓ empaqueta proyecto .codelab
Neon
  ↓ bridge/worker
CodeLab
  ↓ proyecto real / interfaz real cuando se requiere inspección
Resultado + evidencia visual solicitada
  ↓
Neon
  ↓
Agente IA inspecciona
  ↓
continúa en su headless propio
  o
entrega el proyecto al usuario
```

- **Agente IA:** trabaja sobre el proyecto en su propio Headless, recoge fuera de él el archivo exportado, realiza la transferencia al intermediario, verifica la persistencia y coordina el procesamiento A/B cuando la tarea requiere vídeo final.
- **Headless propio del agente:** entorno principal de trabajo. El agente **no debe clonar ni descargar el repositorio para obtener el Headless**. Debe obtener el Headless mediante la descarga de su **artefacto del editor**. Si el artefacto todavía no existe, primero debe generarlo usando el propio Headless/editor; después descarga ese artefacto y continúa con él.
- **Headless/bridge de CodeLab:** componente distinto que permite controlar CodeLab. El headless propio del agente **nunca lo sustituye ni lo modifica**.
- **Neon:** estado canónico de órdenes, proyectos, revisiones, artefactos, resultados y evidencias.
- **CodeLab:** proyecto real e interfaz real donde se entrega el proyecto y, cuando hace falta, se obtiene la evidencia solicitada.
- **Cloudflare/R2:** almacenamiento/transporte de bytes grandes de evidencia cuando está configurado; las órdenes llegan directamente desde Neon a CodeLab por PostgreSQL LISTEN/NOTIFY.

GitHub versiona el software y puede proporcionar el headless del agente; no es el transporte obligatorio de cada cambio visual.

## 2. Inicio, activación y límites

- Solo una petición explícita del usuario puede iniciar una nueva tarea del agente IA.
- Un worker puede terminar una orden que ya fue autorizada, pero un resultado, webhook, cron, error o señal de bridge no debe iniciar por sí solo una nueva ejecución del agente.
- El camino normal de una orden es insertar la fila en Neon con `status='queued'`: el trigger PostgreSQL emite `NOTIFY` y el listener de `server.js` inicia el worker si no existe. No es necesario llamar a ensure para cada orden.
- Si el listener/worker se apagó y se necesita arrancarlo explícitamente, puede usarse `POST /api/agent/bridge/ensure` con el token de control. Esta ruta es un fallback controlado, no el transporte normal de órdenes.
- El worker espera `LISTEN/NOTIFY` cuando no hay órdenes; no mantiene polling de 150 ms, cron ni pings de keep-alive. Si Neon falla al arrancar, el listener del servidor reintenta con backoff y reconcilia órdenes queued al reconectar.
- No confundas la ventana de supervisión del agente con un timeout del worker. Respeta los límites técnicos reales declarados por la operación; no mates procesos solo porque el agente dejó de esperar o la sesión de conversación se interrumpió.

## 3.1 Obtención del Headless del agente mediante workflow y artefacto

Si el agente **no encuentra un artefacto válido del Headless más reciente ni un workflow que realmente lo empaquete**, no debe detenerse ni sustituir el proceso por una copia local, un `git clone`, una reconstrucción manual o un artefacto inventado.

En ese caso, el agente debe:

1. **Modificar o crear el workflow necesario** para que empaquete el Headless más reciente correspondiente al código vigente.
2. Configurar el workflow para **publicar ese paquete como un artefacto real de GitHub Actions**.
3. **Lanzar el workflow él mismo** mediante el mecanismo soportado disponible en el entorno.
4. Esperar la ejecución real y comprobar que terminó correctamente.
5. Obtener/descargar el artefacto producido por esa ejecución.
6. Utilizar ese artefacto como el Headless propio aislado del agente.

Regla operativa adicional:

**No existe artefacto válido + no existe workflow que empaquete el Headless más reciente → agente modifica/crea el workflow → agente lo lanza → workflow empaqueta → publica artefacto → agente obtiene el artefacto → continúa con el Headless aislado.**

El agente debe preferir modificar el workflow existente cuando sea adecuado y solo crear uno nuevo cuando no exista una vía correcta que pueda adaptarse. La modificación debe limitarse a conseguir el empaquetado y publicación correctos del Headless; no debe convertir el workflow en una implementación alternativa del Headless.

## 3.1.1 Procedimiento aplicado cuando faltaba el artefacto

Cuando se detectó que los workflows existentes no estaban produciendo un paquete del Headless del agente, el procedimiento correcto fue:

1. Inspeccionar los workflows existentes y distinguir los artefactos de **evidencia visual** de un artefacto que realmente contuviera el Headless.
2. Confirmar que no había un workflow dedicado que empaquetara y publicara el Headless más reciente.
3. Crear/modificar un workflow dedicado, `agent-headless-package.yml`, con `workflow_dispatch` y ejecución sobre cambios relevantes de `main`.
4. Hacer que el workflow tomara el código vigente de `public/pixelforge/src/`, validara su sintaxis y lo empaquetara junto con los archivos de ejecución necesarios y un manifiesto de commit/ref.
5. Publicar ese paquete mediante `actions/upload-artifact@v4` como artefacto con nombre asociado al SHA de la ejecución.
6. Como el entorno del agente no disponía de un disparador manual directo expuesto por la herramienta, utilizar la ejecución soportada por el propio workflow mediante el cambio en `main` que activó su trigger de `push`.
7. Esperar la ejecución real, comprobar el job de empaquetado y verificar que el paso de publicación terminó correctamente.
8. Consultar los artefactos de esa ejecución y descargar el artefacto **real**, comprobando su identidad, tamaño, SHA-256 y que no estuviera expirado.
9. Solo después de esa verificación, considerar ese ZIP como el Headless del agente aislado.

Resultado de referencia de la primera obtención válida:

- Workflow: `Agent Headless Package`
- Run: `45128253959`
- Job: `package-headless`
- Estado: `success`
- Artefacto: `agent-headless-32f79646950eb57b60c6cf7c810d82488ddcd7af`
- Artifact ID: `14796577116`
- Digest SHA-256: `8af59de24bb3bb6a7484db68f7cc41f01567cc139acf9faa4d8e571457e42bfe`

Este procedimiento queda como ejemplo operativo de la regla anterior: **si falta el paquete canónico, el agente debe construir la vía de empaquetado y obtener el artefacto mediante una ejecución real; no debe fingir que ya existe ni sustituirlo por una copia manual.**

## 3.2 Inicio de workflows disponibles solo manualmente

La disponibilidad de un workflow únicamente mediante **ejecución manual** no impide al agente utilizarlo. Cuando el workflow es la vía requerida para producir un artefacto o realizar una operación necesaria, el agente debe **buscar primero una forma soportada de iniciarlo**, aunque la interfaz de GitHub lo muestre como `workflow_dispatch`/manual.

Reglas:

- El agente **sí puede iniciar workflows** que estén configurados para ejecución manual cuando disponga de un mecanismo autorizado para hacerlo.
- Que un workflow no se ejecute automáticamente por `push`, `pull_request` u otro evento no significa que deba omitirse.
- Si la herramienta o interfaz utilizada no expone directamente el disparo manual, el agente debe buscar **otras formas soportadas** de iniciar ese mismo workflow (por ejemplo, una acción/API/puente autorizado disponible en el entorno), en lugar de concluir inmediatamente que no puede ejecutarlo.
- No se debe sustituir el workflow por una reconstrucción local o por un artefacto inventado cuando el workflow es la fuente canónica del Headless.
- Una vez iniciado, el agente debe esperar la ejecución real, verificar su estado y obtener el artefacto real producido por esa ejecución.
- Si después de explorar los mecanismos soportados no existe ningún método autorizado para iniciar el workflow, debe informarse del bloqueo concreto; no debe simular la ejecución.

Para el Headless del agente, esto refuerza la regla anterior:

**workflow manual disponible → agente busca un mecanismo soportado para iniciarlo → workflow empaqueta el Headless más reciente → artefacto real → agente obtiene el artefacto → Headless aislado.**


El **Headless que utiliza el agente no se obtiene clonando el repositorio ni reconstruyéndolo manualmente**. La fuente operativa es un **workflow de GitHub Actions dedicado a empaquetar el Headless más reciente**.

Flujo obligatorio:

```text
Código Headless más reciente
        ↓
workflow de GitHub Actions
        ↓
empaqueta el Headless completo
        ↓
GitHub Actions publica el paquete como artefacto
        ↓
agente obtiene/descarga el artefacto
        ↓
Headless propio del agente (aislado)
        ↓
trabajo sobre el proyecto
```

Reglas:

- El workflow debe empaquetar **la versión más reciente del Headless** disponible en el código que corresponda a la ejecución.
- El resultado del empaquetado se publica como **artefacto de GitHub Actions**.
- El agente obtiene su Headless **desde ese artefacto**, no mediante `git clone`, una copia parcial del repositorio ni una implementación alternativa.
- El artefacto es la unidad de transferencia del Headless hacia el entorno aislado del agente.
- Si el artefacto de la versión que se necesita todavía no existe, primero debe ejecutarse/generarse el workflow correspondiente para producirlo; después el agente obtiene ese artefacto.
- Una vez descargado, el artefacto proporciona el Headless que el agente utiliza para trabajar. El Headless obtenido sigue estando **aislado** de Neon, CodeLab y del bridge/worker.
- Este mecanismo no debe confundirse con los artefactos de evidencia de una ejecución ni con el artefacto `.codelab` del proyecto: aquí el artefacto contiene el **Headless del agente**.

Por tanto, la regla operativa es:

**Workflow → empaquetar Headless más reciente → publicar artefacto → obtener artefacto → usar ese Headless aislado.**

## 3. Identidad y separación de entornos

- Para proyectos del usuario utiliza el workspace que proporciona la autenticación existente.
- El headless del agente y el headless/bridge de CodeLab son componentes distintos.
- El agente **no debe clonar el repositorio** para obtener o reconstruir su Headless. El mecanismo válido es descargar el **artefacto generado por el editor**. Si no existe un artefacto disponible, debe generarse uno mediante el Headless/editor y luego descargarse.
- Una sesión local aislada no demuestra persistencia en el workspace real.
- No registres ni expongas credenciales, cookies, tokens o secretos.

## 4. Ciclo de trabajo y recuperación

Antes de enviar una orden:

1. Consulta el estado del bridge y las órdenes recientes.
2. Identifica el proyecto y su última `server_revision`.
3. Comprueba si ya existe una orden equivalente activa.
4. Reutiliza el estado de una orden activa; no la dupliques.
5. Envía la operación con los identificadores de correlación requeridos.

Después de enviarla:

1. Espera el resultado real de esa orden.
2. Comprueba su estado persistido en Neon.
3. Verifica la revisión y los cambios esperados.
4. Si corresponde, recupera e inspecciona la evidencia visual.
5. Decide si el trabajo está terminado o necesita otra operación.

Estados habituales pueden incluir `queued → dispatched → running → rendering → uploading → completed/failed`; usa los estados que realmente devuelva la implementación, no los supongas si el endpoint utiliza otros.

Si la sesión del agente se interrumpe:

- Recupera el snapshot del bridge, la orden, el proyecto y la revisión desde Neon.
- Si la orden sigue activa, continúa consultándola en lugar de crear otra.
- Si terminó, inspecciona resultado/evidencia antes de continuar.
- Si falló, diagnostica el error y reanuda desde la última revisión válida.
- No reconstruyas un proyecto desde memoria, capturas o vídeos.
- No reutilices tokens de propuestas expirados.

Consulta también [SESSION-EXPIRATION-RECOVERY.md](SESSION-EXPIRATION-RECOVERY.md).

## 5. Trabajo en headless propio e inspección real

- El trabajo principal se realiza en el **headless propio del agente**.
- El agente **no debe clonar el repositorio para obtener ese Headless**.
- Debe descargar el **artefacto del editor** correspondiente al Headless. Si no existe, primero debe generarlo mediante el propio Headless/editor y después descargarlo.
- El artefacto descargado proporciona el entorno de trabajo del agente y **no reemplaza** el headless/bridge que controla CodeLab. Son dos componentes diferentes.
- El Headless exporta el proyecto `.codelab` y termina su participación. El agente IA recoge ese archivo fuera del Headless y lo entrega a CodeLab mediante el intermediario HTTPS inline documentado; CodeLab valida y usa Neon como staging durable antes de que el bridge/worker lo importe.
- Si el agente no puede continuar sin inspeccionar el proyecto real en una interfaz real, debe solicitar la evidencia visual que necesite.
- La evidencia debe corresponder al proyecto real y a la inspección solicitada.
- El agente debe inspeccionarla realmente antes de decidir.
- Tras inspeccionarla, puede continuar trabajando en su headless propio, corregir y volver a empaquetar, o entregar el proyecto al usuario.
- La evidencia visual es evidencia de inspección; no sustituye al proyecto editable ni se convierte en la fuente canónica del proyecto.

## 6. A/B: etapa integrada para producir el vídeo final

A/B está especializado en procesamiento/render/captura de vídeo por la limitación de memoria de Render, pero **no es un sistema aislado del flujo del usuario**. Es una etapa posterior y coordinada de la misma tarea: el agente crea/edita en su Headless aislado, lleva el proyecto editable al intermediario, CodeLab lo importa y persiste, y después A/B procesa el proyecto/revisión real para producir el vídeo final que el agente debe inspeccionar y entregar al usuario. A/B no crea ni persiste el proyecto editable y no reemplaza el bridge.

### 6.1 Responsabilidades

- **A (host):** una única sesión temporal de CodeLab/PixelForge, ejecutada en GitHub Actions. Mantiene el navegador y el contexto necesario, recibe la petición de vídeo y devuelve el resultado/evidencia.
- **B (procesador):** una única ejecución de trabajo a la vez. Envía a A la operación de animación/captura, espera el resultado y recoge la evidencia de vídeo.
- **Neon:** conserva el estado canónico del proyecto, órdenes, revisiones y referencias de evidencia. A/B no sustituye Neon ni la cola/worker normal.

**B no es una flota de agentes ni un pool de workers.** No se deben lanzar cinco B simultáneas, crear lotes en cola para B ni usar A/B como prueba de carga. Para cada trabajo de vídeo se utiliza una sola B conectada a la sesión A correspondiente.

### 6.2 Flujo normal y flujo de vídeo

- Para dibujo, edición, persistencia e importación normal: **Headless propio del agente → `.codelab` → Neon → bridge/worker → CodeLab**. No iniciar A/B como requisito.
- Cuando el objetivo incluye un vídeo final: después de importar y verificar el proyecto editable en CodeLab, ejecutar **una A anfitriona + una B procesadora** para ese trabajo de vídeo; recoger el archivo final, inspeccionarlo y entregarlo al usuario.
- El empaquetado/render de vídeo no debe ejecutarse en Render: su límite de memoria es la razón por la que esta ruta especializada utiliza GitHub Actions.
- La implementación de referencia del procesador persistente es `.github/workflows/codelab-independent-session-b.yml`; el host A correspondiente es `.github/workflows/codelab-independent-session-a.yml`.
- La prueba manual autocontenida de una única sesión A y una única petición B está en `.github/workflows/codelab-ab-animation.yml`.

### 6.3 Reglas obligatorias

1. **Una sola B activa por vez.** El grupo de concurrencia del workflow B debe mantenerse para impedir ejecuciones simultáneas.
2. B solo procesa operaciones de vídeo/animación y captura la evidencia correspondiente. No usarla como worker genérico de navegador ni como segunda cola de comandos.
3. No lanzar B en paralelo, no crear batches concurrentes y no hacer pruebas de estrés A/B.
4. A conserva el contexto temporal de navegador; B solicita la operación y espera el resultado. No se debe iniciar una segunda A para la misma sesión.
5. El vídeo debe corresponder al proyecto/revisión reales y regresar como evidencia asociada al trabajo.
6. El agente debe abrir/analizar la evidencia antes de declarar correcta la animación. Si detecta defectos, corrige el proyecto por el flujo normal y solicita una nueva ejecución de vídeo.
7. A/B no sustituye Neon como fuente de verdad ni el bridge/worker para operaciones normales.

El workflow de estrés que lanzaba múltiples B queda retirado. No debe recrearse ni documentarse como parte de la arquitectura.

## 6.4 Aislamiento del Headless propio del agente y transferencia al sistema

El **Headless propio del agente está completamente aislado del sistema de CodeLab**. No tiene conexión directa con Neon, el bridge/worker, CodeLab, sus APIs internas ni sus mecanismos de transporte, y **no debe incorporarse ninguna conexión directa** para permitir que el agente trabaje.

Esto es intencional:

```text
Agente
  ↓
Headless propio del agente (aislado)
  ↓
proyecto / artefacto generado
  ↓
intermediario soportado por el entorno del agente
  ↓
Neon / mecanismo de subida soportado
  ↓
CodeLab
```

Reglas:

- El Headless propio del agente **solo se utiliza como entorno de trabajo del agente**.
- Si el agente crea o modifica una animación usando ese Headless, el Headless no intenta subirla directamente a CodeLab.
- El **agente mismo** debe tomar el proyecto resultante y llevarlo, mediante un **intermediario soportado**, hasta el mecanismo de subida que acepta CodeLab.
- El intermediario es el límite entre el entorno aislado del agente y el sistema. El Headless no debe obtener credenciales del sistema ni abrir conexiones directas para saltarse ese límite.
- El proyecto editable debe conservarse como proyecto real (por ejemplo, `.codelab`) al realizar la transferencia; no se debe reducir la transferencia a capturas, frames sueltos o un vídeo cuando se necesita el proyecto editable.
- Una vez que el proyecto ha sido entregado al mecanismo soportado, CodeLab/bridge puede continuar con su procesamiento normal.
- A/B es el procesador especializado de vídeo integrado en la tarea. No crea ni importa el proyecto editable; procesa una revisión ya persistida y produce el vídeo final que se entrega al usuario.
- Si no existe un intermediario soportado para una transferencia concreta, el agente debe detener esa transferencia e indicarlo explícitamente; **no debe crear una conexión directa al sistema como workaround**.

## 6.5 Uso de Xvfb durante la animación en Headless

Cuando el **Headless propio del agente** necesita un display gráfico para ejecutar el navegador o los componentes de PixelForge durante una tarea de animación, se utiliza **Xvfb como display virtual**.

```text
Headless propio del agente
        ↓
Xvfb (display virtual, cuando el runtime lo requiere)
        ↓
PixelForge Headless
        ↓
crear / ajustar / validar la animación
```

Reglas específicas:

- Xvfb solo proporciona el display virtual necesario para el runtime; **no sustituye al Headless del agente**.
- La creación y modificación de la animación sigue realizándose mediante el Headless propio del agente.
- Xvfb no implica por sí mismo un cambio en la arquitectura Neon → bridge/worker → CodeLab.
- El uso de Xvfb debe quedar limitado a los procesos que realmente necesiten un display gráfico.
- No presentar una ejecución local o un harness como resultado del Headless real simplemente porque utilice Xvfb.

## 7. Principio de cierre

Un trabajo se declara terminado cuando el proyecto y el resultado esperado están verificados según el objetivo. Si requirió inspección del proyecto real, la evidencia solicitada debe haber sido inspeccionada. Si necesita correcciones, el agente continúa en su headless propio; si está listo, entrega el proyecto al usuario. Si algo no pudo probarse, debe indicarse expresamente como no verificado.


## 6.6 Regla obligatoria: Headless sin conexión al intermediario y entrega GIF

El Headless propio del agente está aislado también respecto del intermediario de transferencia. No abre conexiones al bridge ni a CodeLab, no conoce sus endpoints y no recibe secretos. Su salida es un archivo de proyecto editable. El agente IA debe tomar el archivo fuera del Headless, iniciar y completar la transferencia HTTPS inline, esperar la importación y verificar la persistencia.

El GIF generado localmente en Headless solo se entrega si el usuario lo solicitó expresamente. Sin petición explícita de GIF, el agente no puede dar por cumplida la tarea mostrando/adjuntando ese GIF: debe completar la transferencia del proyecto editable a CodeLab.

## 6.7 Entrega obligatoria del vídeo final A/B

Cuando la tarea incluya generar un vídeo, el agente debe identificar y persistir primero el proyecto/revisión en CodeLab, coordinar una única A y una única B, recuperar el archivo de vídeo final, comprobar que se abre y reproduce, inspeccionarlo visualmente y entregarlo al usuario. Un enlace a logs, un event_id, una captura o el estado success no son el vídeo final y no satisfacen la entrega.
