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

El contrato HTTP documentado para `/api/agent/bridge/artifacts` exige autenticación del lado del servidor mediante el header `x-codelab-agent-bridge-token`. Esa regla describe el endpoint y no autoriza al agente a pedirle el secreto al usuario ni a pasárselo a Headless.

La conducta correcta es:

- Reutilizar la conexión/capacidad administrativa ya autorizada que la plataforma expone al agente, si existe una acción soportada para esa operación.
- Si el flujo necesita invocar el endpoint HTTP directamente, comprobar primero cómo el servicio y la integración autorizada resuelven esa autenticación. No asumir que el agente debe leer una variable de entorno del runtime ni que el usuario debe volver a configurarla.
- No leer, imprimir, copiar ni solicitar secretos en texto claro; no incluirlos en documentación, comandos, payloads, capturas o logs.
- Si no hay ninguna acción autorizada disponible y el servidor rechaza la petición, informar el error exacto y la capa que lo produce. Pedir intervención al usuario solo si falta realmente una autorización que no puede recuperarse desde las conexiones existentes.

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
