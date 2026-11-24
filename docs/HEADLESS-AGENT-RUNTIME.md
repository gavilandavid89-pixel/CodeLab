# Headless del agente: instalación y ejecución en el entorno propio

**Estado:** requisito operativo vigente.

## Qué significa “agente” en CodeLab

En este proyecto, **el agente es la IA a la que el usuario le da una orden para realizar un trabajo dentro de CodeLab**.

Por tanto, cuando esta documentación habla de **“entorno del agente”**, se refiere al entorno de ejecución controlado por esa IA mientras atiende la orden del usuario. La IA/agente es quien debe poder instalar, iniciar y controlar su instancia de Headless durante la tarea.

No debe interpretarse “agente” como un runner genérico de CI, un servicio de GitHub Actions ni como CodeLab por sí mismo.

## Regla principal

El **Headless del agente debe instalarse y ejecutarse dentro del entorno aislado donde opera el agente**. El artefacto publicado por CI/GitHub Actions es el medio para distribuir la versión correcta del Headless; no debe confundirse con el entorno de ejecución final.

Flujo canónico:

```text
GitHub Actions / artefacto Headless
          │
          ▼
Entorno aislado del agente (IA que recibió la orden del usuario)
  ├─ descarga el paquete Headless
  ├─ instala dependencias
  ├─ inicia el runtime Headless
  ├─ crea/abre el proyecto nativo
  ├─ anima y edita con control directo del runtime
  └─ exporta el archivo nativo .codelab
          │
          ▼
El Headless termina aquí

Agente IA (fuera del Headless)
  └─ toma el archivo exportado y lo transfiere por HTTPS inline bridge
          │
          ▼
CodeLab → Neon staging → worker
          │
          ▼
workspace destino
```

## El entorno del agente no necesita ser persistente

La ausencia de un entorno persistente **no es una excepción ni una razón para omitir la instalación**. El agente debe instalar y ejecutar Headless en el entorno de ejecución que tenga disponible para atender la orden, aunque ese entorno sea temporal, efímero, se destruya al terminar la sesión o no conserve archivos entre conversaciones.

Reglas obligatorias:

- Al comenzar cada nueva sesión/tarea en la que necesite editar o animar, el agente comprueba si dispone de una instalación utilizable de Headless en su entorno actual.
- Si no existe, está incompleta, no corresponde al artefacto requerido o el entorno fue recreado, descarga el artefacto vigente, lo extrae e instala allí sus dependencias.
- Inicia y utiliza esa instalación durante la tarea. No debe limitarse a inspeccionar el artefacto, importar fuentes desde el checkout, delegar la edición normal a CI ni afirmar que está instalado porque GitHub Actions lo empaquetó.
- Si el entorno es efímero, trabaja en él igualmente. Antes de que desaparezca, exporta el proyecto `.codelab`. Después, el agente, fuera del Headless, recoge el archivo y lo transfiere por el intermediario HTTPS; el proyecto persistido en CodeLab es lo que permite continuar después.
- En una sesión posterior o tras perderse el entorno, vuelve a descargar/instalar Headless. La instalación puede repetirse; no se exige conservar el runtime entre sesiones.
- Si la plataforma no proporciona ningún entorno donde el agente pueda ejecutar procesos e instalar dependencias, debe informar esa limitación concreta y no simular que ejecutó Headless. Debe solicitar/habilitar el entorno de ejecución necesario; la falta de persistencia por sí sola nunca justifica saltarse el paso.

**Persistencia del trabajo y persistencia del entorno son cosas distintas:** el runtime Headless puede ser temporal; el proyecto y sus resultados deben persistirse mediante el flujo CodeLab/bridge/worker documentado. No se debe introducir Neon ni credenciales internas en el entorno Headless para resolver esta diferencia.

## Por qué debe ejecutarse allí

El agente necesita control directo del runtime mientras trabaja. La animación no debe depender de transportar continuamente el proyecto a CodeLab para cada operación.

El Headless del agente debe permitir, como mínimo:

- abrir y modificar el documento nativo;
- controlar frames, cels, capas y timeline;
- ejecutar operaciones de dibujo/edición;
- aplicar y revisar cambios en memoria;
- generar y validar animaciones;
- exportar el estado final a `.codelab`;
- decidir cuándo transferir el resultado a CodeLab.

Esto mantiene la edición/animación dentro del entorno controlado por el agente y deja a CodeLab como destino de persistencia, revisión e interfaz real.

## Instalación

El agente no debe obtener el Headless mediante una copia arbitraria del repositorio ni sustituirlo por una implementación reconstruida.

Cuando exista un artefacto válido del Headless:

1. descargar el artefacto;
2. extraerlo dentro del entorno aislado del agente;
3. instalar sus dependencias;
4. comprobar que el runtime puede arrancar;
5. ejecutar el runtime desde esa instalación;
6. conservar esa instancia durante la sesión de trabajo del agente.

Si no existe un artefacto válido, el agente debe generar/publicar primero el artefacto mediante el workflow documentado y después instalarlo en su entorno.

## Responsabilidad del agente IA

Cuando el usuario entrega una orden al agente, el agente debe ser capaz de realizar el ciclo de trabajo completo desde su propio entorno:

1. interpretar la orden del usuario;
2. obtener la versión válida del Headless;
3. instalar y ejecutar el Headless en su entorno;
4. realizar las operaciones de edición/animación necesarias;
5. validar el resultado;
6. exportar el `.codelab`;
7. salir del contexto Headless y, como agente IA, tomar el archivo exportado;
8. transferirlo mediante el intermediario HTTPS;
9. comprobar el resultado en el workspace destino.

El agente no debe considerar que una prueba de CI, por sí sola, equivale a haber ejecutado el Headless como agente IA.

## Separación de responsabilidades

El entorno del agente es responsable de **trabajar y animar**.

CodeLab es responsable de **recibir, validar, persistir y publicar** el proyecto.

El Headless del agente **no debe recibir**:

- `DATABASE_URL`;
- credenciales de Neon;
- credenciales de Neon Object Storage/S3;
- secretos internos de CodeLab.

**El Headless no participa en la transferencia.** No conoce el intermediario, no hace llamadas de red al sistema CodeLab y no recibe tokens ni credenciales. La transferencia HTTPS inline es una acción posterior realizada por el agente IA, que toma el archivo exportado desde su entorno y lo envía siguiendo `docs/inline-artifact-bridge.md`.

## Transferencia

Cuando el Headless termina una edición, su única salida es el archivo nativo. A continuación, el agente IA (no el Headless):

1. recoge el proyecto nativo `.codelab` exportado;
2. calcula tamaño y SHA-256;
3. inicia el transporte inline desde fuera del Headless;
4. envía manifiesto y chunks binarios;
5. confirma el commit;
6. espera el resultado real de la orden;
7. verifica que el proyecto aparezca en el workspace destino;
8. puede abrir/guardar/recargar para comprobar persistencia.

Un HTTP 202 del bridge solo significa que la importación fue encolada; no significa que el proyecto ya esté persistido.

## Regla para pruebas

Una prueba que solamente importe módulos del checkout del repositorio **no demuestra** que el agente pueda ejecutar su Headless instalado.

La prueba correcta debe demostrar:

**artefacto Headless → descarga → instalación/ejecución dentro del entorno del agente IA → edición/animación → exportación .codelab → bridge HTTPS → worker → workspace destino → reapertura y persistencia.**

El CI puede representar un entorno aislado equivalente para validar el artefacto y el flujo técnico, pero **no debe describirse como la IA agente que recibió la orden del usuario** ni como sustituto del entorno real del agente.

## Relación con la prueba E2E actual

La integración PostgreSQL de CI ya descarga el artefacto Headless publicado y carga `HeadlessEditorRuntime` desde ese artefacto. La prueba debe mantenerse alineada con esta regla y ampliarse cuando sea necesario para comprobar explícitamente la instalación de dependencias y la ejecución desde un entorno aislado equivalente.

La validación del flujo de persistencia debe seguir usando PostgreSQL efímero. **No modificar Neon production.**

## Documentación relacionada

- `docs/inline-artifact-bridge.md`: transporte Headless → CodeLab.
- `docs/agent-ai-bridge-policy.md`: política del agente y obtención del artefacto.
- `docs/CodeLab_Neon_comunicacion_extremo_a_extremo.md`: arquitectura de comunicación y persistencia.


## Regla de salida visual: GIF solo bajo petición explícita

El GIF que pueda generarse localmente en el entorno Headless es una vista previa opcional, no la entrega por defecto. **Solo entregar un GIF local si el usuario pidió expresamente un GIF.** Si no lo pidió, el agente debe exportar el proyecto editable, tomarlo fuera del Headless y completar la transferencia al intermediario para persistirlo en CodeLab. Pedir un vídeo final no equivale a pedir un GIF; para vídeo, seguir `docs/VIDEO-PROCESSING-AB.md`.
