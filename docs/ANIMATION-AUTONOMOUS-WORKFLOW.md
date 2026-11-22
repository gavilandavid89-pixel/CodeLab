# Protocolo de trabajo autónomo del agente para animación

**Estado:** política operativa solicitada por el usuario.  
**Ámbito:** tareas de dibujo y animación en CodeLab/PixelForge, incluida la animación «PixelForge — Soldier Walk 60F».  
**Objetivo:** que el agente IA sea responsable del proceso completo durante la sesión de trabajo y que el usuario reciba únicamente el resultado final.

## 1. No es un servicio 24/7

El agente IA **no debe mantenerse activo 24/7**, ni crear un proceso permanente para aparentar que sigue trabajando cuando no hay una sesión de trabajo activa.

La responsabilidad es distinta: cuando el usuario solicita una tarea y el agente inicia su ejecución, el agente debe permanecer involucrado durante el trabajo que pueda realizar dentro de esa sesión: enviar órdenes, esperar sus resultados, inspeccionarlos, corregir errores y continuar con los siguientes pasos.

Los workers o servicios de CodeLab pueden ejecutar una orden ya solicitada conforme a su diseño, pero eso no autoriza a crear un agente IA siempre activo ni a iniciar nuevas tareas por su cuenta. Solo una petición explícita del usuario inicia una nueva ejecución del agente IA, conforme a la política actual del agente y del bridge.

Si la sesión del agente se interrumpe o termina, el agente no debe afirmar que siguió trabajando en segundo plano. Al reanudarse mediante una nueva petición del usuario, debe recuperar el estado real y continuar desde allí, sin repetir operaciones ya completadas.

## 2. Ciclo de trabajo obligatorio

El agente IA es responsable de conducir el ciclo completo:

1. **Preparar:** consultar el estado real del proyecto, la tarea pendiente y las evidencias necesarias.
2. **Ordenar:** enviar a CodeLab/A la operación concreta que corresponda.
3. **Esperar:** esperar el resultado de esa orden. No asumir que fue ejecutada solo porque se envió, se aceptó o quedó encolada.
4. **Verificar:** consultar el estado persistido y comprobar que el cambio ocurrió realmente.
5. **Inspeccionar:** evaluar la evidencia visual cuando la tarea afecte dibujos, frames, capas o animación.
6. **Revisar calidad visual:** la revisión visual es **obligatoria** antes de considerar terminada una tarea visual. No basta con que el worker, bridge o exportador informe "success": el agente debe inspeccionar la evidencia visual real y comprobar que el resultado cumple el objetivo de calidad solicitado.
7. **Corregir:** si hay errores, resultados parciales o defectos visuales, diagnosticar la causa, preparar una corrección y volver a ejecutar.
8. **Continuar:** avanzar al siguiente bloque o paso usando el estado real recién verificado.
9. **Finalizar:** exportar y validar el resultado completo antes de declarar la tarea terminada.

El ciclo se repite tantas veces como sea necesario dentro del trabajo solicitado:

**Agente IA → orden → espera → resultado → verificación → inspección → corrección/continuación → nueva orden.**

El agente no debe detenerse después de enviar una única orden ni trasladar al usuario la supervisión rutinaria de cada fotograma o bloque.

## 3. Autonomía y límites de intervención del usuario

- No pedir al usuario que envíe código, capturas, estados o datos que el agente pueda consultar de forma segura mediante las herramientas y conexiones disponibles.
- No pedir confirmación entre fotogramas, bloques o reintentos rutinarios.
- No exigir que el usuario despierte manualmente al agente para cada paso.
- Resolver por cuenta propia los errores técnicos recuperables, siguiendo las políticas de seguridad y permisos del proyecto.
- Consultar al usuario únicamente cuando exista un bloqueo real que requiera una decisión suya, un permiso no concedido, un dato indispensable que no pueda recuperarse o una acción irreversible/destructiva que necesite autorización.
- No inventar resultados ni declarar completada una operación que no tenga evidencia de ejecución y persistencia.

## 4. Espera, supervisión y servicios auxiliares

Este protocolo complementa la política vigente Neon/bridge de AGENTS.md y docs/agent-ai-bridge-policy.md. No depende de los antiguos workflows A/B ni de sus ventanas de supervisión.

La supervisión debe estar vinculada a una tarea iniciada por el usuario; no debe convertirse en vigilancia permanente 24/7. Si una orden sigue en cola o un worker no responde:

1. consultar el identificador, acción, payload y estado real de la orden;
2. identificar qué servicio consume esa orden;
3. inspeccionar logs/estado para localizar la causa;
4. realizar, si corresponde, **un único toque/despertar bajo demanda** del servicio correcto;
5. esperar y verificar la orden concreta antes de reenviar o duplicar operaciones.

No crear polling permanente, bucles de pings ni despertares periódicos. Un ping al frontend no demuestra que el worker consumidor esté activo. No reiniciar ni desplegar servicios ajenos a la tarea.

## 5. Reglas específicas para animación

- Trabajar por bloques cuando sea razonable, sin pedir intervención del usuario entre bloques.
- Consultar el frame anterior real desde CodeLab/A antes de construir el siguiente frame dependiente.
- Después de crear o modificar un bloque, comprobar que los frames quedaron guardados y que el estado activo/índices corresponden.
- Evaluar continuidad, silueta, proporciones, anatomía, pose, dirección del movimiento, pies, manos, cabeza, torso, extremidades y objetos sostenidos.
- **La revisión visual es obligatoria:** toda animación, dibujo, modificación de frames o cambio de capas debe pasar por una inspección visual antes de la entrega.
- La revisión debe utilizar evidencia visual real del resultado producido, no una inferencia basada en el estado de la orden, metadatos, hashes, existencia del archivo o un mensaje de "success".
- En animaciones, revisar como mínimo continuidad entre frames, fluidez del movimiento, silueta, proporciones, anatomía, pose, dirección del movimiento, pies, manos, cabeza, torso, extremidades, objetos y coherencia temporal.
- Para una revisión de calidad suficiente, inspeccionar el resultado completo o una muestra representativa que permita detectar defectos entre frames; cuando existan dudas, revisar los frames afectados individualmente.
- **No declarar terminada una tarea si la revisión visual no se realizó, no está disponible o no permite comprobar la calidad.**
- Rechazar resultados visualmente defectuosos aunque la orden o el workflow informe "success".
- Corregir y repetir los pasos necesarios hasta alcanzar el objetivo o identificar un bloqueo no resoluble.
- Para la entrega, comprobar la cantidad de frames, FPS, duración, loop, archivo exportado y reproducción visual real, además de completar la revisión visual obligatoria. La existencia del archivo por sí sola no demuestra que la animación esté bien.

## 6. Comunicación con el usuario: solo resultado final

Durante la ejecución normal, el agente **no debe enviar informes de progreso, mensajes de "sigo trabajando", solicitudes de confirmación por cada paso ni actualizaciones intermedias**.

Al terminar, debe enviar **un único informe final** que indique:

- si la tarea quedó completada;
- qué resultado se produjo y dónde quedó disponible;
- qué verificaciones técnicas y visuales se realizaron;
- qué defectos se corrigieron;
- cualquier limitación o bloqueo que haya quedado pendiente.

Si aparece un bloqueo que realmente requiere intervención del usuario, debe explicar solo ese bloqueo de forma clara y concreta; no debe fingir que la tarea continúa avanzando.

## 7. Seguridad y alcance

- No modificar ni borrar datos de Neon de forma destructiva sin autorización explícita.
- No tocar otros servicios o aplicaciones de Render que no formen parte de esta tarea.
- No exponer secretos, tokens, cookies ni credenciales en documentación, logs o mensajes.
- Antes de reiniciar, desplegar o cambiar configuración, identificar el servicio exacto y confirmar que la acción es necesaria y está dentro del alcance autorizado.

## Transporte de proyectos: Neon BYTEA, sin Object Storage

El flujo de proyectos y animaciones **no utiliza Object Storage como dependencia del transporte o importación**.

El transporte canónico de un paquete `.codelab` es:

`proyecto.codelab → comando/endpoint → Neon BYTEA → importador → proyecto CodeLab`

El importador admite el transporte inline mediante `artifactBase64` y persiste los bytes directamente en `public.codelab_project_artifacts.artifact`. Object Storage puede existir en la infraestructura, pero **no debe ser requerido, consultado ni usado como condición para completar una importación**.

Si Object Storage no está disponible, el flujo debe continuar mediante el transporte inline de Neon. Una incidencia de DNS, disponibilidad o acceso a Object Storage no debe bloquear una tarea de CodeLab.

La integridad del paquete se verifica siempre sobre los bytes reales almacenados en Neon mediante tamaño y SHA-256, seguida de validación del archivo `.codelab` antes de iniciar la importación.

## 8. Criterio de finalización

La tarea solo se considera terminada cuando:
- el resultado está persistido;
- la exportación existe y puede abrirse/reproducirse;
- la cantidad de frames, FPS, duración y loop son correctos;
- la evidencia técnica confirma que el resultado fue realmente ejecutado y guardado;
- **la revisión visual obligatoria confirma que la calidad del resultado cumple el objetivo**.

Si la revisión visual detecta defectos, la tarea vuelve al ciclo de corrección y no puede declararse terminada hasta repetir la verificación.

La revisión visual es un requisito de aceptación, no un paso opcional ni una comprobación meramente decorativa.

**Principio rector:** el usuario define el objetivo; el agente conduce el trabajo completo durante la sesión activa y comunica el resultado final. No se requiere que el usuario supervise cada orden, fotograma o corrección.
