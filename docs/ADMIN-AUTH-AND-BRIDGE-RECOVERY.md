# Recuperación de identidad ADMIN y continuidad del bridge

**Estado: regla operativa vigente.** Este documento registra la corrección de diagnóstico para evitar que un agente vuelva a pedir al usuario secretos o una reconfiguración de autenticación que ya está resuelta.

## 1. Principio: reutilizar la identidad ya conectada

Cuando la plataforma/agente dispone de una conexión administrativa válida a Neon y CodeLab, debe reutilizar esa identidad y el contexto de cuenta existente. No debe tratar la ausencia de una variable de entorno visible en el runtime Headless como prueba de que la autenticación de la tarea está rota.

En particular:

- La autenticación de la cuenta ADMIN y la autenticación interna de una ruta HTTP del servidor son capas distintas.
- Una conexión administrativa disponible para el agente puede permitir consultar la cuenta, resolver el workspace y utilizar las operaciones/acciones soportadas sin revelar credenciales al Headless.
- El Headless propio del agente permanece aislado: nunca recibe credenciales Neon, cookies, tokens, secretos internos ni acceso directo al bridge.
- No solicitar al usuario que copie, pegue, genere o vuelva a configurar secretos cuando la conexión administrativa ya está disponible.
- No inventar ni asumir nombres de variables de entorno, tokens, endpoints alternativos o mecanismos de autenticación.

## 2. Secuencia obligatoria de diagnóstico

Antes de declarar un bloqueo de autenticación:

1. **Inspeccionar las conexiones y herramientas disponibles** para Neon, CodeLab y el bridge. Identificar qué cuenta/conexión está activa y qué acciones soportadas ofrece.
2. **Resolver la identidad real** mediante lectura de la cuenta autenticada en Neon (por ejemplo, la fila ADMIN y su rol), sin exponer datos sensibles en logs o mensajes.
3. **Resolver el workspace destino** desde la identidad/cuenta y el registro de workspace correspondiente. No confundir el buzón interno ADMIN del bridge con el workspace donde debe guardarse el proyecto.
4. **Consultar el estado existente**: órdenes, artefactos temporales, solicitudes de importación, proyectos y revisiones. Reutilizar órdenes activas y evitar duplicados.
5. **Elegir el mecanismo soportado** de transferencia/operación que corresponda a las conexiones disponibles. El agente IA coordina el transporte fuera de Headless; Headless solo exporta el paquete nativo.
6. **Verificar el resultado** leyendo el estado de la orden y el proyecto desde el workspace destino. Una respuesta aceptada o HTTP 202 no demuestra persistencia.
7. Solo si una operación soportada falla realmente por autenticación, inspeccionar el código, la configuración del servicio y los permisos de la conexión para localizar la capa exacta que rechazó la petición.

## 3. No confundir cuenta ADMIN con secreto del endpoint

El contrato HTTP documentado para `/api/agent/bridge/artifacts` exige autenticación del lado del servidor mediante el header `x-codelab-agent-bridge-token`. La conexión de lectura a Neon y la identidad ADMIN no sustituyen ese token ni autentican automáticamente la ruta HTTP. Esa regla describe el endpoint y no autoriza al agente a pedirle el secreto al usuario ni a pasárselo a Headless.

La conducta correcta es:

- Reutilizar la conexión/capacidad administrativa ya autorizada que la plataforma expone al agente para resolver identidad y workspace. Para la transferencia HTTP, usar únicamente una acción/proxy ya autorizado que gestione el token del lado del servicio; no asumir que el acceso SQL de Neon lo sustituye.
- Si el flujo necesita invocar el endpoint HTTP directamente, comprobar primero cómo el servicio y la integración autorizada resuelven esa autenticación. No asumir que el agente debe leer una variable de entorno del runtime ni que el usuario debe volver a configurarla.
- No leer, imprimir, copiar ni solicitar secretos en texto claro; no incluirlos en documentación, comandos, payloads, capturas o logs.
- Si no hay ninguna acción/proxy autorizado disponible para ejecutar la transferencia y no se puede invocar el endpoint con la autorización ya gestionada por el entorno, no inventar un mecanismo alternativo ni escribir staging/chunks directamente en Neon. Informar el bloqueo de transporte exacto sin pedir secretos ni reconfiguración general.

La existencia de una fila ADMIN en Neon confirma identidad/rol en la base de datos; por sí sola no demuestra que una ruta HTTP concreta haya aceptado una petición. Mantener ambas comprobaciones separadas y no inferir una falla de autenticación HTTP por la mera ausencia de una variable local.

## 4. Workspace correcto y persistencia

- El workspace propietario del buzón interno ADMIN usado para staging no es necesariamente el workspace destino del proyecto.
- El manifiesto debe señalar el workspace destino real resuelto desde la cuenta autenticada.
- El worker debe persistir el proyecto y sus revisiones bajo ese workspace destino, no bajo el buzón ADMIN.
- Verificar el destino mediante lectura de vuelta en las tablas/proyecciones de proyecto y revisar que `workspace_id`, `project_id`, revisión y hash correspondan a la importación.
- Neon production se consulta en modo lectura para diagnóstico y verificación. No insertar ni modificar directamente proyectos, chunks o estados para forzar el flujo.

## 5. Continuación de tareas creativas y A/B

Una vez resuelta la identidad, continuar el flujo sin pedir al usuario que repita pasos:

1. Headless aislado → editar/animar → validar → exportar paquete nativo.
2. Agente IA fuera de Headless → transferir por el mecanismo autorizado.
3. CodeLab/worker → esperar la orden y verificar importación/persistencia en el workspace destino.
4. Agente → leer de vuelta e inspeccionar el proyecto real.
5. Si la petición incluye vídeo, ejecutar una única sesión A y una única B sobre la revisión persistida.
6. Recuperar el archivo de vídeo final real, abrirlo/reproducirlo e inspeccionarlo visualmente.
7. Si hay defectos, corregir incrementalmente el proyecto editable, persistir una nueva revisión y repetir A/B.
8. Entregar el proyecto editable y el vídeo final solicitado.

No declarar terminado el trabajo si solo existe un ZIP local, un hash, una orden encolada, un event ID o un resumen de CI. El GIF local no sustituye el vídeo final salvo petición explícita de GIF.

## 6. Registro de la corrección

El error que este documento evita es concluir que falta `CODELAB_AGENT_BRIDGE_CONTROL_SECRET` en el entorno del agente y pedir al usuario que lo configure, sin haber comprobado primero la conexión administrativa existente, la cuenta ADMIN, el workspace y las acciones autorizadas disponibles.

**Regla final:** primero reutilizar y verificar la autenticación/conexión existente; después diagnosticar la capa concreta que falla. Nunca trasladar al usuario una solicitud de secreto basada en una suposición.


## 7. Verificación de producción — 24 de noviembre de 2026

Se corrigieron los valores predeterminados para evitar que una importación del bridge sin `target_workspace_id` explícito termine en un workspace invitado:

- `server.js`: el destino por defecto del manifiesto inline ahora es el workspace ADMIN resuelto por el servidor (`workspaceId`), en vez de un identificador invitado fijo.
- `agent-bridge-worker.mjs`: el modo invitado solo se activa si `PIXELFORGE_GUEST_MODE` está explícitamente configurado como `true`; el valor por defecto del código es `false`.
- Commits desplegados: `333f6905ed973683137ebda75c8d2c054e12c2ff` y `5d294e8930fbd1d53df35d45afe7d3d246645a8e`. Render confirmó el segundo despliegue como `live`.
- La orden de estado posterior al despliegue se ejecutó con `succeeded` y devolvió `workspaceId: ws_local_admin`, runtime Headless y persistencia PostgreSQL.
- Una inspección de solo lectura del proyecto existente, pasando `target_workspace_id: ws_local_admin`, terminó `succeeded` y devolvió revisión de servidor `8`, hash `ee37520bd62b6710ec4ce120c3a2b21c058f22f73b394de92c1580d4ee31dbbc` y validación nativa `passed` (100 puntos, cero incidencias).

**Alcance de esta verificación:** queda comprobado el despliegue, la comunicación Neon → worker y el acceso/lectura de un proyecto cuando la orden especifica el workspace ADMIN. El log también mostró que el proceso general mantiene `ws_pixelforge_guest` como workspace PixelForge predeterminado porque el servicio tiene el modo invitado habilitado en su configuración actual. Por eso, las operaciones administrativas deben enviar explícitamente `target_workspace_id: ws_local_admin`; no se debe interpretar el estado general del worker como prueba de que todo el modo invitado fue desactivado.

La prueba de inspección no ejercitó una carga HTTP real contra `/api/agent/bridge/artifacts` ni verificó el valor/aceptación del secreto `x-codelab-agent-bridge-token`. Por tanto, no afirmar que esa autorización HTTP específica está probada por esta prueba. Para certificarla se requiere una transferencia end-to-end autorizada, seguida de importación y lectura de vuelta del proyecto en ADMIN; nunca exponer el secreto ni saltarse el bridge escribiendo chunks directamente en Neon.
