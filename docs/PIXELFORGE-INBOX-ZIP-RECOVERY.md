# Recuperación del ZIP de PixelForge desde el inbox de GitHub

**Fecha:** 2026-11-24  
**Repositorio:** `gavilandavid89-pixel/CodeLab`  
**Rama:** `main`  
**Alcance:** recuperación del paquete de prueba `inbox-smoke-test-sunrise`, sustituyendo el archivo dañado en su ruta original y reenviándolo al importador de PixelForge ADMIN.

## 1. Resultado y límites de la verificación

Se reemplazó el archivo existente, sin crear otra carpeta ni una copia paralela:

`projects/animation-inbox/inbox-smoke-test-sunrise/project.codelab`

El nuevo blob quedó publicado en `main` con SHA de Git:

`873d7cb39a6446d23ce6f357d31b3180e27d6a46`

El paquete local se validó con `unzip -t`; la prueba informó que las 15 entradas del ZIP eran legibles. Su SHA-256 fue:

`e5b7eb45b0564fd35c3bcdb82f94460cfb26c3c6977bdb4cc5dba5f76bd6f49b`

Después de publicar, se volvió a leer el archivo desde GitHub en la misma ruta y su blob SHA coincidió exactamente con el esperado. Por tanto, el archivo remoto corresponde al mismo contenido binario que se validó localmente.

El workflow de importación terminó con `status=completed` y `conclusion=success`. Sus pasos de checkout, detección del proyecto e importación finalizaron correctamente. El bridge aceptó el paquete y devolvió `status=queued`, con command ID:

`7f4a2d3e-7044-4bdc-a542-c38cbff48f82`

**Esto no prueba todavía que el worker haya terminado ni que el proyecto ya aparezca en ADMIN.** La importación solo debe declararse completada después de comprobar el resultado del worker, la existencia del proyecto en `ws_local_admin`, la revisión persistida y la posibilidad de volver a abrirlo.

## 2. Cómo se recuperó el archivo

1. Se identificó el archivo dañado en la ruta existente dentro de `projects/animation-inbox/inbox-smoke-test-sunrise/`.
2. Se preparó el ZIP correcto fuera del repositorio y se comprobó su estructura con `unzip -t`. No se modificó el nombre del proyecto ni se creó una carpeta alternativa.
3. Se calculó SHA-256 sobre los bytes completos del ZIP para disponer de una huella independiente del nombre del archivo.
4. Como el paquete es binario, se convirtió su contenido a Base64 para crear un Git blob mediante la API Git Data de GitHub. No se intentó guardar el ZIP como texto UTF-8.
5. Se comparó el SHA del blob devuelto por GitHub con el SHA de Git esperado para el contenido validado. La coincidencia confirmó que GitHub almacenó los mismos bytes.
6. Se creó un tree nuevo tomando como base el tree existente de `main` y cambiando únicamente la entrada de la ruta del paquete. Así se preservó el resto del repositorio.
7. Se creó un commit con el tree nuevo y el commit anterior como padre.
8. Se movió `refs/heads/main` al nuevo commit usando el SHA anterior como condición esperada (`expected_sha`, actualización tipo compare-and-swap). Esto evita sobrescribir silenciosamente cambios concurrentes.
9. Se volvió a descargar el archivo desde `main` y se verificó que su blob SHA fuera el esperado.

### Por qué se usó Git Data API

El paquete `.codelab` es un ZIP binario. El flujo Git Data permite almacenar el blob en Base64, crear un tree que sustituya una sola ruta y publicar un commit controlado. Es más apropiado que tratar el contenido como texto. La operación conserva el mismo path y no requiere duplicar el proyecto.

## 3. Cómo se ejecutó la importación

El workflow utilizado es:

`.github/workflows/pixelforge-project-inbox.yml`

Se activa cuando cambia algo bajo `projects/animation-inbox/**` o manualmente mediante `workflow_dispatch`. Para cada carpeta detectada, el job:

1. Comprueba que exista `project.codelab`.
2. Ejecuta `unzip -tq` y extrae el paquete en un directorio temporal del runner.
3. Exige `manifest.json`, `project.json` y `project.codelab-pixelforge`.
4. Comprueba que el manifiesto declare `format=codelab` y `editor=pixelforge`, y que el proyecto tenga ID y nombre.
5. Calcula tamaño, cantidad de chunks y SHA-256 del archivo.
6. Crea el manifiesto en `POST /api/agent/bridge/artifacts`, indicando `artifact_kind=codelab_zip_upload`, `editor_id=pixelforge` y `target_workspace_id=ws_local_admin`.
7. Envía los chunks binarios por `PUT` y finaliza la transferencia con `POST .../{artifactId}/commit`.
8. Comprueba que la respuesta del commit indique `status=queued` y registra el command ID.

El secreto `CODELAB_AGENT_BRIDGE_CONTROL_SECRET` se consume como GitHub Actions secret. No debe copiarse a documentación, logs ni mensajes.

## 4. Evidencia de esta ejecución

| Comprobación | Resultado |
|---|---|
| Ruta reemplazada | `projects/animation-inbox/inbox-smoke-test-sunrise/project.codelab` |
| Git blob SHA en `main` | `873d7cb39a6446d23ce6f357d31b3180e27d6a46` |
| SHA-256 del ZIP validado | `e5b7eb45b0564fd35c3bcdb82f94460cfb26c3c6977bdb4cc5dba5f76bd6f49b` |
| Commit de reemplazo | `0ac0eb00a4f1d60628c89bc53b7ee6b4faba1ece` |
| Workflow run | [45481804170](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45481804170) |
| Job | `import` — completed / success |
| Command ID encolado | `7f4a2d3e-7044-4bdc-a542-c38cbff48f82` |
| Respuesta del bridge | `queued` |
| Aparición y reapertura en ADMIN | **Pendiente de verificación** |

## 5. Procedimiento de verificación posterior

No volver a subir el ZIP ni volver a disparar la importación solo porque aún no se haya comprobado la interfaz: primero consultar el command ID existente para evitar duplicados.

La comprobación final debe confirmar, usando la conexión administrativa ya configurada:

- que la orden del command ID terminó en estado terminal exitoso y no sigue `queued/running`;
- que el proyecto importado existe en el workspace `ws_local_admin`;
- que su revisión persistida y los recursos asociados están presentes;
- que se puede leer de vuelta y reabrir desde PixelForge ADMIN;
- que la identidad del proyecto corresponde a `inbox-smoke-test-sunrise` y no a una importación duplicada.

Si la orden falla, diagnosticar la etapa concreta (recepción, staging, worker, parseo, persistencia o lectura de vuelta) antes de reintentar. No crear otra carpeta de inbox ni otro proyecto para ocultar un fallo de importación.

## 6. Lecciones para futuras recuperaciones

- Reemplazar el archivo en su ruta original cuando el usuario pide corregir el paquete existente.
- Para ZIP/binarios, validar el archivo y usar Base64 únicamente como transporte del blob; no reinterpretar bytes como UTF-8.
- Verificar tanto el SHA-256 del archivo como el Git blob SHA publicado.
- Construir el tree desde el tree actual para preservar los demás archivos.
- Actualizar la rama con SHA esperado para detectar carreras.
- Distinguir tres hitos: **archivo publicado**, **bridge encoló la importación** y **worker persistió el proyecto en ADMIN**. Solo el último, acompañado de lectura de vuelta y reapertura, acredita una importación terminada.
- No registrar secretos ni confundir el éxito de GitHub Actions con la finalización del worker.
