# Headless del agente: instalación y ejecución en el entorno propio

**Estado:** requisito operativo vigente.

## Regla principal

El **Headless del agente debe instalarse y ejecutarse dentro del entorno aislado donde opera el agente**. El artefacto publicado por CI/GitHub Actions es el medio para distribuir la versión correcta del Headless; no debe confundirse con el entorno de ejecución final.

Flujo canónico:

```text
GitHub Actions / artefacto Headless
          │
          ▼
Entorno aislado del agente
  ├─ descarga el paquete Headless
  ├─ instala dependencias
  ├─ inicia el runtime Headless
  ├─ crea/abre el proyecto nativo
  ├─ anima y edita con control directo del runtime
  └─ exporta el .codelab
          │
          ▼
HTTPS inline bridge
          │
          ▼
CodeLab → Neon staging → worker
          │
          ▼
workspace destino
```

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

## Separación de responsabilidades

El entorno del agente es responsable de **trabajar y animar**.

CodeLab es responsable de **recibir, validar, persistir y publicar** el proyecto.

El Headless del agente **no debe recibir**:

- `DATABASE_URL`;
- credenciales de Neon;
- credenciales de Neon Object Storage/S3;
- secretos internos de CodeLab.

La transferencia continúa usando el intermediario HTTPS inline documentado en `docs/inline-artifact-bridge.md`.

## Transferencia

Cuando el agente termina una edición:

1. exporta el proyecto nativo `.codelab`;
2. calcula tamaño y SHA-256;
3. inicia el transporte inline;
4. envía manifiesto y chunks binarios;
5. confirma el commit;
6. espera el resultado real de la orden;
7. verifica que el proyecto aparezca en el workspace destino;
8. puede abrir/guardar/recargar para comprobar persistencia.

Un HTTP 202 del bridge solo significa que la importación fue encolada; no significa que el proyecto ya esté persistido.

## Regla para pruebas

Una prueba que solamente importe módulos del checkout del repositorio **no demuestra** que el agente pueda ejecutar su Headless instalado.

La prueba correcta debe demostrar:

**artefacto Headless → descarga → instalación/ejecución dentro del entorno del agente → edición/animación → exportación .codelab → bridge HTTPS → worker → workspace destino → reapertura y persistencia.**

El CI puede representar el entorno aislado del agente mediante un job que descargue el artefacto publicado y lo ejecute allí. No debe usar directamente el código Headless del checkout como sustituto del artefacto.

## Relación con la prueba E2E actual

La integración PostgreSQL de CI ya descarga el artefacto Headless publicado y carga `HeadlessEditorRuntime` desde ese artefacto. La prueba debe mantenerse alineada con esta regla y ampliarse cuando sea necesario para comprobar explícitamente la instalación de dependencias y la ejecución desde el entorno aislado del agente.

La prueba debe seguir usando PostgreSQL efímero. **No modificar Neon production.**

## Documentación relacionada

- `docs/inline-artifact-bridge.md`: transporte Headless → CodeLab.
- `docs/agent-ai-bridge-policy.md`: política del agente y obtención del artefacto.
- `docs/CodeLab_Neon_comunicacion_extremo_a_extremo.md`: arquitectura de comunicación y persistencia.

