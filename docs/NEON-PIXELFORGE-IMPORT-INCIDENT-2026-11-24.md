# Incidente de importación PixelForge y diagnóstico de Neon

**Fecha de observación:** 2026-11-24  
**Repositorio:** `gavilandavid89-pixel/CodeLab`  
**Rama:** `main`  
**Incidente relacionado:** [recuperación del ZIP de inbox](PIXELFORGE-INBOX-ZIP-RECOVERY.md)

## 1. Fuente de verdad para elegir la cuenta de infraestructura

**No fijar ni copiar una cuenta, correo, nombre de conexión o identificador de cuenta en este informe.** Esos datos pueden cambiar.

Antes de cada operación sobre Neon o Render, leer la sección inicial **“Cuentas de infraestructura activas”** del `README.md` en la rama que se esté usando. Esa sección es la única fuente de verdad para saber qué cuenta está activa en ese momento. Después:

1. Identificar la cuenta y las conexiones que el README indique actualmente.
2. Seleccionar esas conexiones en Neon/Render.
3. Confirmar que el proyecto y servicio pertenecen a esa cuenta antes de consultar o modificar nada.
4. Si el README cambia, seguir el valor nuevo; los informes históricos no deben imponer una cuenta anterior.

El dato de cuenta no se replica aquí deliberadamente para evitar que esta documentación quede obsoleta cuando cambie la cuenta activa. Una búsqueda en otra conexión no sirve para verificar CodeLab.

## 2. Corrección de la verificación anterior

La inspección anterior utilizó una conexión/proyecto de Neon equivocados. Por eso el resultado HTTP 402 de aquella consulta no demuestra que la base Neon usada por CodeLab esté agotada o bloqueada.

Al volver a leer el README y seleccionar la conexión identificada como **Neon**, se encontró:

| Dato | Valor observado |
|---|---|
| Proyecto | `Codelab` |
| Project ID | `withered-violet-39964819` |
| Rama | `production` |
| Branch ID | `br-sweet-waterfall-bea35bjz` |
| Estado de la rama | `ready` |
| Base de datos | `neondb` |
| Rol de lectura usado | `neondb_owner` |

Se pudo ejecutar SQL de solo lectura correctamente en este proyecto. Por tanto, **no se debe registrar el 402 anterior como una cuota agotada de la base correcta**. La consulta previa se hizo contra el destino equivocado; el origen exacto de aquel 402 no quedó demostrado.

## 3. Estado real de la orden de importación

Consulta directa de solo lectura a `public.codelab_agent_commands`:

- `command_id`: `7f4a2d3e-7044-4bdc-a542-c38cbff48f82`
- `workspace_id`: `ws_local_admin`
- `action`: `codelab_project_import`
- `artifact_filename`: `inbox-smoke-test-sunrise.codelab`
- `import_request_id`: `repo-inbox-inbox-smoke-test-sunrise-45481804170`
- `native_artifact_id`: `d309e18e7ac64da282348643998d7fd7`
- `status`: `queued`
- `started_at`: `NULL`
- `finished_at`: `NULL`
- `result`: `NULL`
- `created_at`: `2026-11-24T20:32:17.873Z`
- `expires_at`: `2026-11-24T20:47:17.873Z`
- `updated_at`: igual a `created_at`

### Cómo interpretar `queued` (según el contrato documentado)

`queued` es un estado normal e intencional del ciclo de vida: significa que la orden durable ya fue insertada en Neon y está esperando a que el listener/worker la reclame. No significa por sí solo que haya fallado, que el ZIP esté importado ni que el worker esté ejecutándose.

El contrato de [Transporte inline de artefactos](inline-artifact-bridge.md), junto con la [arquitectura CodeLab ↔ Neon](CodeLab_Neon_comunicacion_extremo_a_extremo.md), especifica:

- HTTP 202 / `status: "queued"` confirma únicamente que la orden quedó encolada.
- PostgreSQL NOTIFY despierta el consumidor cuando el listener está conectado.
- Si el listener no estaba conectado cuando se emitió la señal, al iniciar/reconectar debe reconciliar la cola durable y buscar órdenes `queued` no expiradas.
- El worker reclama la fila mediante transacción y `FOR UPDATE SKIP LOCKED`; luego procesa y escribe el estado/resultado terminal.
- La expiración inicial documentada de la orden es de 15 minutos. Una orden que continúa `queued` después de su expiración requiere reconciliación/diagnóstico; no debe tratarse como importada ni reenviarse a ciegas.

Por tanto, el hecho de que la orden estuviera `queued` en la primera consulta no era por sí solo un defecto: era un estado intermedio previsto. Lo relevante en este incidente es que la orden concreta seguía sin `started_at`, `finished_at` ni `result` al acercarse/pasar su `expires_at`, y los logs mostraban fallos de reconexión del listener. Eso apunta a un problema de activación/consumo que debe investigarse, no a que el estado `queued` sea incorrecto.

En la misma lectura había otras dos órdenes `codelab_project_import` antiguas en `queued`, con expiraciones 20:04:05Z y 20:05:32Z. Su presencia tampoco prueba importación ni fallo definitivo por sí sola; al estar expiradas y no reclamadas, requieren reconciliación individual. No se deben volver a encolar automáticamente: primero hay que consultar su estado y comprobar si existe una importación ya persistida para evitar duplicados.

**Criterio de finalización:** solo declarar completada una importación cuando la orden tenga resultado exitoso y la persistencia del proyecto/revisión pueda leerse de vuelta en el workspace destino. `queued`, HTTP 202 y una notificación emitida no satisfacen ese criterio.

## 4. Causa raíz confirmada y corrección del listener

Los logs de Render mostraban repetidamente:

```text
check constraint "codelab_agent_commands_action_check"
of relation "codelab_agent_commands" is violated by some row
```

La comparación del código desplegado con el esquema real de Neon permitió identificar la causa:

- La restricción CHECK vigente en Neon permitía `pixelforge_preview_evidence_video`, `pixelforge_import_zip`, `pixelforge_export_zip` y `pixelforge_video_composer`.
- El bloque de inicialización del listener en `server.js` reconstruía esa restricción con una lista antigua que omitía esos cuatro valores.
- Ya existía una orden histórica con `action='pixelforge_preview_evidence_video'`. Al intentar añadir de nuevo el CHECK sin permitir ese valor, PostgreSQL rechazaba la operación y revertía la transacción. Por eso el listener no podía completar su inicialización/reconexión.
- El worker ya contemplaba esas acciones; el desfase estaba en la lista duplicada de `server.js`.

**Corrección aplicada:** se sincronizó la allowlist del listener con las acciones admitidas por el worker y se añadió una prueba de contrato para impedir que vuelvan a faltar esas cuatro acciones.

- Commit del arreglo: `136e4743fc74d77145e2934934b1fb5c0c5f02b2`.
- Commit de la prueba: `752a8493bc9beeb2b1accfbb2715fa2095d67e2e`.
- Deploy Render del arreglo: `dep-dc2vkm8ae00c73fmu0vg` (live).
- Tras el despliegue, los logs confirmaron `Neon wake listener armed`, reconciliación de una orden durable y arranque del worker. En el nuevo arranque no volvió a aparecer el error CHECK.

No se modificó la restricción directamente en producción, no se borraron filas y no se relajó ninguna validación SQL.

## 5. Expiración de la orden original y recuperación sin duplicar trabajo

La orden original `7f4a2d3e-7044-4bdc-a542-c38cbff48f82` no fue importada: cuando el worker volvió a estar operativo ya había superado su expiración. El worker la marcó explícitamente como `expired`, con resultado `command_expired`.

Antes de reintentar se comprobó de forma individual que:

- no existía el proyecto `inbox-smoke-test-sunrise-20261124` en `codelab_pixelforge_projects`;
- no existía una fila de importación exitosa correspondiente en `codelab_project_imports`;
- la solicitud de importación original seguía en estado `queued`;
- el ZIP canónico permanecía en la misma ruta y conservaba su SHA-256 original.

Con esa evidencia, se volvió a ejecutar el workflow del inbox sobre el mismo paquete fuente, sin crear otra carpeta ni modificar el ZIP. El nuevo intento generó una nueva orden porque la anterior ya estaba expirada y no había persistido el proyecto.

## 6. Resultado verificado de la recuperación

<badge>Importación completada</badge>

- Workflow: [Import PixelForge project inbox — run 45486594896](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45486594896) — `success`.
- Orden nueva: `c714677b-ac84-4357-b550-43cc38d5b0fe` — `succeeded`.
- Solicitud: `repo-inbox-inbox-smoke-test-sunrise-45486594896`.
- Proyecto: `inbox-smoke-test-sunrise-20261124`.
- Workspace destino: `ws_local_admin`.
- Editor: `pixelforge`.
- Nombre: `Inbox Smoke Test — Sunrise`.
- Revisión persistida: `1`.
- Tamaño persistido: `20,211` bytes.
- Frames de animación persistidos: `2`.
- SHA-256 de origen: `e5b7eb45b0564fd35c3bcdb82f94460cfb26c3c6977bdb4cc5dba5f76bd6f49b`.
- SHA-256 del contenido persistido: `ddfcf968c225518620475b64a059cd976ef36f28cf115db8fcbef3873f8c5fa3`.
- Resultado del worker: `reloadedFromPersistence=true`, `persistedAnimationFrameCount=2`.

La lectura SQL posterior confirmó una fila en `codelab_pixelforge_projects` bajo el workspace ADMIN y una fila correspondiente en `codelab_project_imports` con `status='succeeded'` y el SHA de origen esperado.

La respuesta del importador indicó `workspacePublication.published=false` con motivo `editor_uses_dedicated_workspace`. Esto es esperado para el editor PixelForge: el proyecto se guarda en la tabla/workspace dedicado de PixelForge, no en el registro genérico de proyectos web de CodeLab. No debe interpretarse como un fallo de persistencia.

El listener también volvió a arrancar correctamente después del deploy posterior; los logs muestran `Neon wake listener armed` sin el error CHECK.

## 7. Verificaciones de CI y despliegue

- [CodeLab QA and command mailbox](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45486594801) — `success`.
- [Agent Space Browser Runner](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45486594763) — `success`.
- [CodeLab 5s soldier animation](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45486594626) — `success`.
- La ejecución amplia [Validate CodeLab](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45486594925) seguía en curso al registrar esta actualización; no se declara completada aquí.

## 8. Evidencia de referencia

- Workflow inicial que encoló la orden expirada: [run 45481804170](https://github.com/gavilandavid-pixel/CodeLab/actions/runs/45481804170).
- Workflow que completó la importación recuperada: [run 45486594896](https://github.com/gavilandavid-pixel/CodeLab/actions/runs/45486594896).
- Paquete fuente y hash original: [PIXELFORGE-INBOX-ZIP-RECOVERY.md](PIXELFORGE-INBOX-ZIP-RECOVERY.md).
- La cuenta activa sigue obteniéndose dinámicamente de la primera sección de `README.md`; este informe no copia ninguna identidad de cuenta.
