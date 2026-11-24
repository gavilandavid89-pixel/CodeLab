# Incidente de importación PixelForge y diagnóstico de Neon

**Fecha de observación:** 2026-11-24  
**Repositorio:** `gavilandavid89-pixel/CodeLab`  
**Rama:** `main`  
**Incidente relacionado:** [recuperación del ZIP de inbox](PIXELFORGE-INBOX-ZIP-RECOVERY.md)

## 1. Cuenta de infraestructura obligatoria

La primera sección del `README.md` establece explícitamente:

- Cuenta actual para Neon y Render: `xxsuperwarriorx@gmail.com`.
- Deben usarse las conexiones de esa cuenta para operar CodeLab.
- No cambiar a otras cuentas salvo indicación explícita del usuario.

Esta instrucción es la referencia operativa. Una búsqueda de proyectos en otra conexión no sirve para verificar el estado de CodeLab.

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

La orden existía en la base correcta, pero en la lectura observada seguía encolada y sin marca de inicio ni resultado. Esto **no acredita que el ZIP se haya importado ni persistido en ADMIN**.

En la misma lectura había otras dos órdenes `codelab_project_import` antiguas todavía en `queued`, con expiraciones 20:04:05Z y 20:05:32Z. No se deben volver a encolar esas solicitudes automáticamente: primero hay que reconciliar su estado y evitar duplicados.

## 4. Restricción SQL y discrepancia con los logs de Render

Los logs de arranque de Render del servicio CodeLab registraron repetidamente un error al crear/reconectar el listener de Neon:

```text
check constraint "codelab_agent_commands_action_check"
of relation "codelab_agent_commands" is violated by some row
```

Se inspeccionó directamente la restricción en el proyecto Neon correcto. La definición observada es un `CHECK` sobre `action` que admite, entre otros valores, `codelab_project_import`. La restricción aparece con `convalidated = true`.

También se agruparon las filas existentes por `action` y `status`. Los valores observados estaban dentro de la lista permitida; en particular, la orden de este incidente usa `codelab_project_import`, que está expresamente permitido.

**Conclusión limitada por la evidencia:** el mensaje de Render y el estado actual de la tabla no coinciden de forma directa. La fila de esta importación no viola la restricción según su valor `action`, y la restricción actual está validada. No se identificó qué fila, operación, conexión o versión de esquema originó el error del listener. No atribuirlo a esta orden ni modificar/borrar filas para intentar silenciarlo.

La discrepancia requiere comprobar que el `DATABASE_URL` efectivo del servicio Render apunta al mismo proyecto/branch, inspeccionar la consulta exacta de arranque/reconexión y revisar el historial de migraciones/DDL que administra esa restricción. No registrar ni exponer el valor secreto de `DATABASE_URL`; basta comparar el host/proyecto de forma saneada.

## 5. Qué queda sin verificar

- Si el worker reclamó posteriormente la orden existente.
- Si la orden alcanzó un estado terminal y generó un resultado.
- Si el proyecto `inbox-smoke-test-sunrise` se publicó en `ws_local_admin`.
- Si su revisión y recursos quedaron persistidos.
- Si PixelForge ADMIN puede leerlo de vuelta y reabrirlo.
- Qué originó exactamente el error de la restricción en los logs del listener.

El hecho de que otros comandos `codelab_project_import` hayan terminado exitosamente en horas anteriores demuestra que hubo importaciones funcionales antes, pero no demuestra que esta orden concreta se haya procesado.

## 6. Próximo procedimiento seguro

1. Leer siempre la cuenta indicada al principio de `README.md` antes de usar Neon o Render.
2. Verificar el proyecto `Codelab` y la rama `production` de esa cuenta.
3. Comparar de forma saneada el destino de `DATABASE_URL` del servicio Render con ese proyecto/branch.
4. Inspeccionar el código y migraciones que crean o modifican `codelab_agent_commands_action_check`, además del SQL exacto usado por el listener.
5. Consultar por `command_id` las órdenes existentes y registrar su estado antes de cualquier reintento.
6. No borrar órdenes, relajar la restricción, ejecutar DDL ni crear una importación duplicada sin identificar primero la causa y confirmar el alcance.
7. Declarar la importación completada únicamente tras confirmar el estado exitoso, la publicación en `ws_local_admin`, la revisión persistida y la lectura de vuelta/reapertura en ADMIN.

## 7. Evidencia de referencia

- Workflow que encoló la orden: [GitHub Actions run 45481804170](https://github.com/gavilandavid-pixel/CodeLab/actions/runs/45481804170).
- Paquete y hash publicados: [PIXELFORGE-INBOX-ZIP-RECOVERY.md](PIXELFORGE-INBOX-ZIP-RECOVERY.md).
- Cuenta y orden de lectura: `README.md`, primera sección; proyecto `withered-violet-39964819`, rama `br-sweet-waterfall-bea35bjz`.
