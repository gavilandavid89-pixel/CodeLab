# Informe de resolución: transferencia inline e importación en ADMIN

**Fecha de verificación:** 24 de noviembre de 2026  
**Resultado:** transferencia e importación real de un paquete CodeLab Web verificadas en producción.

## 1. Problema que se corrigió

La ruta de prueba del bridge y la importación no estaban alineadas en cuanto al workspace destino. El workflow de GitHub Actions todavía enviaba un identificador de workspace invitado (`ws_guest_pixelforge`), mientras que el servidor y el worker ya estaban siendo ajustados para que las importaciones de usuario terminaran en ADMIN. Eso podía hacer que una transferencia se rechazara o que el destino esperado no coincidiera con el destino efectivo.

También hubo un fallo puntual en el paso de commit del workflow: el JSON del SHA se construía con quoting incorrecto. La petición no llegaba como un cuerpo JSON válido y el commit fallaba aunque el paquete ya estuviera preparado y las partes hubieran sido enviadas.

## 2. Cambios aplicados

### 2.1 Destino ADMIN coherente

- El workflow de prueba dejó de enviar `ws_guest_pixelforge` y pasó a enviar explícitamente `ws_local_admin`.
- El inicio de importación inline valida/resuelve el destino ADMIN; no se permite que un destino invitado suministrado por el cliente convierta la importación real en una importación de invitado.
- El worker de importación usa el workspace ADMIN resuelto por CodeLab como destino de PixelForge y ya no migra proyectos a un workspace guest durante el arranque.
- La transferencia conserva la separación entre el buzón interno que mantiene el staging del bridge y el workspace real donde se persiste el proyecto.

Commits relacionados:
- `917634f2796017115f6dfdcd56aeab5ed69883d1`: endurece el destino ADMIN en el inicio de importación y en rutas PixelForge.
- `80a716839e1a1cb6992a31be917947dbfb82a4a0`: el worker usa ADMIN como workspace PixelForge y elimina la migración automática a guest.
- `c9a53ec109019aff3999a2d00d860c6213ca0ed2`: corrige el smoke test HTTP para resolver y enviar el workspace ADMIN.

### 2.2 Workflow de transferencia real

Se actualizó `.github/workflows/inline-bridge-smoke-test.yml` para que no se limite a enviar un byte de autoprueba. Ahora construye un paquete CodeLab Web estructurado y válido:

- marcador `project.codelab-web`;
- `project.json` con HTML, CSS, JS e ID único por ejecución;
- recurso SVG de prueba;
- `integrity.json` con SHA-256 y tamaño del recurso;
- `manifest.json` con formato CodeLab v2, layout structured y editor `web`;
- ZIP final `.codelab`.

El workflow calcula tamaño, cantidad de partes y SHA-256 del archivo completo. Después usa el contrato HTTP real del bridge:

1. `POST /api/agent/bridge/artifacts` para crear el manifiesto de staging.
2. `PUT /api/agent/bridge/artifacts/{artifact_id}/{chunk_index}` para subir las partes binarias.
3. `POST /api/agent/bridge/artifacts/{artifact_id}/commit` para verificar integridad y encolar la importación.

La autenticación se entrega al job mediante el secreto de GitHub Actions `CODELAB_AGENT_BRIDGE_CONTROL_SECRET`, enviado en el header `x-codelab-agent-bridge-token`. El secreto no está escrito en el repositorio, no se imprime y no se pasa al Headless.

### 2.3 Corrección del JSON de commit

El body del commit se genera con `jq -n --arg sha "$SHA" '{sha256:$sha}'`. Así el SHA se codifica como una cadena JSON válida, sin interpolación manual propensa a errores de comillas.

Commit del workflow corregido: `ef1951ad75b21633bfb86e2ea9d585b873c8726d`.

## 3. Arquitectura y límites de confianza

```text
Headless propio del agente
  └─ crea/edita y exporta el .codelab; no conoce el bridge
             │
             ▼ archivo exportado
Agente IA fuera del Headless
  ├─ calcula bytes, chunks y SHA-256
  └─ envía HTTPS autenticado
             │
             ▼
CodeLab inline bridge
  ├─ valida autorización y manifiesto
  ├─ recibe chunks binarios
  ├─ verifica secuencia, tamaños y hashes al hacer commit
  └─ crea solicitud/orden de importación
             │
             ▼
Neon + worker CodeLab
  ├─ reconstruye y analiza el paquete
  ├─ importa usando el editor declarado
  ├─ persiste en el workspace ADMIN destinatario
  └─ devuelve estado y datos de lectura de vuelta
             │
             ▼
Agente consulta el resultado y verifica el proyecto persistido
```

Responsabilidades importantes:

- **ADMIN/CodeLab** es la autoridad sobre autenticación, autorización, destino, reglas de negocio y persistencia.
- **Headless propio** es un entorno creativo aislado. Solo ejecuta las acciones solicitadas y exporta el paquete; no recibe secretos, no decide el workspace y no llama al bridge.
- **Agente IA**, fuera del Headless, coordina la transferencia autorizada y verifica el resultado.
- **Bridge** es el intermediario HTTPS autenticado; no es el workspace final.
- **Neon staging** contiene temporalmente el artefacto y sus chunks. No es el lugar donde el usuario edita el proyecto.
- **Worker** importa el paquete y persiste el proyecto en el workspace destino ADMIN.
- No se evita el bridge escribiendo chunks o staging directamente en Neon.

## 4. Prueba real completada

- Workflow: **Inline bridge end-to-end import test**.
- GitHub Actions run: [45338080211](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45338080211).
- Resultado: `completed / success`.
- Proyecto de prueba: `Bridge E2E Web Import 45338080211`.
- Project ID: `bridge-e2e-web-45338080211`.
- Import request: `codelab-e2e-web-45338080211`.
- Workspace destino: `ws_local_admin`.
- Editor: `web`.
- Estado de la solicitud de importación en Neon: `succeeded`.
- Estado del artefacto: `imported`.
- Tamaño del paquete transferido: 1.649 bytes.
- SHA-256 del paquete: `27ff053b5665678d8c2af1ca7d70ea316c55c7d15c6e47612a14bf510653623e`.
- SHA-256 del contenido del proyecto persistido: `0793920a0bd52619ddb176d17e24694719b84fdf7478d7215a1d9740747504e8`.
- Recurso SVG importado: 112 bytes; SHA-256 `3d4fc8455faaffd532f3994d0eb8939b9b77a3f31abac2abf8f36c670f7a35a1`.
- Workspace ADMIN después de la importación: revisión 12.
- Lectura de vuelta: `reloadedFromPersistence: true`; el HTML persistido contiene el encabezado `ADMIN import verified`.

El resultado confirma que el archivo pasó por el endpoint HTTP autenticado, fue dividido y recibido, se verificó su integridad, se encoló la importación, el worker lo importó y el proyecto fue leído nuevamente desde la persistencia del workspace ADMIN. No fue solamente una prueba `self_test` del transporte.

## 5. Resultado verificado

### 5.1 Importación CodeLab Web

La ejecución [45338080211](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45338080211) transfirió e importó el paquete Web v2 en `ws_local_admin`. La solicitud terminó en `succeeded`, el artefacto en `imported` y la lectura de vuelta confirmó `reloadedFromPersistence: true`.

### 5.2 Importación PixelForge nativa y animación

La ejecución [45344660920](https://github.com/gavilandavid89-pixel/CodeLab/actions/runs/45344660920) completó el flujo nativo Headless → inline bridge → worker → ADMIN → lectura de vuelta.

- Solicitud: `codelab-soldier-walk-60f-fixed-45344660920`.
- Proyecto: `soldier-walk-60f-20261124`, **PixelForge — Soldier Walk**.
- Destino: `ws_local_admin`; editor: `pixelforge`.
- Animación principal: 20 fotogramas, 12 FPS, bucle de 1,667 segundos.
- Estructura: 4 capas editables, cada fotograma con cuatro rutas RGBA independientes y cuatro hashes de píxeles distintos.
- Organización: cinco espacios de trabajo independientes (`Entorno`, `Efectos`, `Detalles`, `Elementos`, `Objetos`), cada uno con su propia línea de tiempo de 4 fotogramas.
- Reference Center: 1 referencia maestra.
- Persistencia: 110 archivos del proyecto.
- Estado de la orden, solicitud y artefacto: `succeeded`, `succeeded` e `imported`.
- Lectura de vuelta: `reloadedFromPersistence: true`, `persistedAnimationFrameCount: 20`, `persistedReferenceCount: 1`.
- SHA-256 del contenido persistido: `82db7ee3d5195063fdff109f7e0ad7a30089a8c907e7387e81d13b1742e8b67f`.

### 5.3 Integridad al reemplazar una versión

El exportador PixelForge asigna una ruta de píxeles distinta a cada capa de cada fotograma. La prueba de paquete comprueba tanto la unicidad de esas rutas como la igualdad de los bytes RGBA exportados con los cels originales.

Al reimportar un proyecto existente, CodeLab verifica primero todos los archivos esperados (ruta, tamaño, SHA-256 y bytes). Solo después elimina los archivos obsoletos que no forman parte del paquete nuevo y confirma el recuento final. Así la persistencia no conserva fotogramas ni cels huérfanos de una versión anterior.

## 6. Procedimiento de diagnóstico para futuras transferencias

Si una transferencia falla:

1. Confirmar que el paquete exportado existe y registrar tamaño y SHA-256; no reconstruirlo desde screenshots.
2. Confirmar que el workflow usa el workspace ADMIN resuelto/autorizado y no un ID guest antiguo.
3. Comprobar que el secreto está disponible como secreto de Actions, sin imprimirlo ni copiarlo a logs.
4. Revisar por separado la respuesta de begin, cada chunk y commit. Un `202 queued` no equivale a importación terminada.
5. En commit, comprobar el SHA del archivo completo, el número de chunks y el tamaño total.
6. Consultar el estado de la solicitud y del worker; esperar `succeeded`.
7. Leer el proyecto desde el workspace destino y comparar project ID, contenido/hash y recursos persistidos.
8. Si falla, diagnosticar la capa exacta. No pedir al usuario que reconfigure secretos sin evidencia, no entregar secretos al Headless y no escribir directamente en las tablas de staging de Neon para saltarse el bridge.

## 7. Relación con otros documentos

- [Transporte inline de artefactos](inline-artifact-bridge.md): contrato HTTP, límites, seguridad y staging.
- [Recuperación ADMIN y bridge](ADMIN-AUTH-AND-BRIDGE-RECOVERY.md): diagnóstico de identidad y autenticación existente.
- [Política operativa del agente](agent-ai-bridge-policy.md): separación entre Headless propio, agente y CodeLab.
- [Arquitectura CodeLab ↔ Neon](CodeLab_Neon_comunicacion_extremo_a_extremo.md): worker, cola y persistencia.
