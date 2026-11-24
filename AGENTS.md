# CodeLab — instrucciones obligatorias para agentes

**Entrada obligatoria:** antes de cualquier trabajo, leer este archivo y [la política operativa del agente](docs/agent-ai-bridge-policy.md). Para ubicar el resto, usar el [índice documental](docs/README.md).

## 1. Modelo mental: hay dos entornos Headless distintos

No confundirlos:

- **Headless propio del agente:** se instala y ejecuta en el entorno de la IA que recibió la orden. Aquí el agente crea, edita y anima. La fuente de distribución es el artefacto real del workflow GitHub Actions. El entorno puede ser efímero; eso no elimina la obligación de instalarlo y usarlo.
- **Headless/bridge/worker de CodeLab:** pertenece al sistema CodeLab. Recibe órdenes/paquetes, importa, persiste, genera evidencia y devuelve resultados. No sustituye el entorno creativo propio del agente.

El agente es la IA que recibe la petición del usuario, no GitHub Actions, Render, Neon ni el worker.

## 2. Flujo canónico de una tarea creativa

Usuario → agente IA → Headless propio → crear/editar/animar → validar → exportar paquete .codelab → HTTPS inline bridge → staging Neon → worker CodeLab → workspace destino → lectura de vuelta → agente inspecciona resultado/evidencia → entrega.

1. Solo una petición explícita del usuario inicia una nueva tarea del agente.
2. Al comenzar una tarea creativa, comprobar si el entorno actual tiene un Headless válido. Si falta o no corresponde a la versión requerida, obtener el artefacto oficial, instalarlo y ejecutarlo en el entorno propio del agente.
3. Consultar el proyecto/revisión y las órdenes activas antes de continuar un trabajo existente. No duplicar órdenes activas.
4. Crear y modificar en el Headless propio. No enviar cada fotograma a CodeLab como mecanismo normal de edición.
5. Validar el proyecto y la animación en el Headless; generar e inspeccionar evidencia visual real.
6. Exportar el paquete nativo requerido y transferirlo mediante el bridge HTTPS documentado.
7. Esperar el resultado real del worker. HTTP 202 significa queued, no persistido.
8. Verificar que el proyecto aparezca en el workspace destino, leerlo de vuelta y comprobar revisión/bytes/estructura; reabrir cuando el flujo lo permita.
9. Inspeccionar evidencia visual de CodeLab cuando la tarea requiera comprobar la interfaz o el resultado desplegado.
10. Informar con precisión qué quedó completado y qué no pudo verificarse.

## 3. Arquitectura de órdenes: ruta separada

Las órdenes de trabajo que el agente envía al sistema usan la cola durable de Neon y PostgreSQL LISTEN/NOTIFY para despertar al listener/worker de CodeLab. El worker reclama órdenes ya autorizadas y devuelve resultados. Esta cola no es el transporte binario del paquete creativo: la transferencia de artefactos usa el inline bridge y luego crea la orden de importación correspondiente.

- Neon es la fuente durable de órdenes, proyectos, revisiones, resultados y metadatos.
- LISTEN/NOTIFY despierta al consumidor; el payload de NOTIFY no transporta el proyecto.
- El worker completa órdenes autorizadas; no inicia nuevas tareas autónomas del agente.
- No mantener polling, cron de keep-alive ni pings periódicos.
- No confundir una orden encolada con una orden completada.

## 4. Seguridad, identidad y persistencia

- Para proyectos reales, conservar la identidad/workspace que resuelve la autenticación existente. No inventar, sustituir ni hardcodear identidad.
- No pasar al Headless propio DATABASE_URL, credenciales Neon/Object Storage, secretos internos, cookies ni tokens de CodeLab.
- El Headless produce el paquete; CodeLab autentica la transferencia y realiza la persistencia.
- Las pruebas aisladas deben usar PostgreSQL efímero/temporal. **No modificar Neon production** para validar.
- Distinguir persistencia local, staging temporal, persistencia final en el workspace y lectura de vuelta.
- No declarar que Render/producción fue probado si solo se ejecutaron pruebas locales o CI.
- No desplegar ni modificar servicios ajenos al alcance solicitado.

## 5. Evidencia y calidad

- Para dibujo/animación, generar evidencia visual e inspeccionarla realmente. success, metadatos válidos o una exportación correcta no bastan.
- Screenshots y vídeos son evidencia de inspección, no la fuente canónica del proyecto.
- No reconstruir el estado editable desde memoria, screenshots o vídeo cuando el proyecto puede recuperarse desde su fuente persistida.
- Si hay defectos, corregir en el Headless propio, volver a validar y transferir una nueva versión.

## 6. A/B: uso exclusivo de vídeo

A/B no forma parte del flujo creativo normal ni del Headless propio del agente. Se reserva para procesamiento/render/captura de vídeo por la limitación de memoria de Render. Usar una sola sesión A y una sola B procesadora por trabajo. Nunca lanzar lotes de estrés ni usar A/B para edición, importación o persistencia. Consultar [VIDEO-PROCESSING-AB.md](docs/VIDEO-PROCESSING-AB.md).

## 7. Recuperación de sesión

Si la sesión del agente termina, no asumir que el worker se detuvo ni iniciar otra tarea automáticamente. Ante una nueva petición del usuario:
1. consultar el estado del bridge/órdenes;
2. recuperar project_id y última server_revision;
3. comprobar si existe una orden activa;
4. no duplicarla;
5. continuar desde el último estado persistido válido.

Seguir [SESSION-EXPIRATION-RECOVERY.md](docs/SESSION-EXPIRATION-RECOVERY.md).

## 8. Sincronización obligatoria de documentación técnica

Cualquier cambio en PostgreSQL, DATABASE_URL/TLS, pools, LISTEN/NOTIFY, triggers, cola, acciones, estados, reconexión, worker, APIs de bridge, workspace, persistencia, revisiones o evidencia debe actualizar en el mismo PR:
- docs/CodeLab_Neon_comunicacion_extremo_a_extremo.md;
- docs/CODELAB-NEON-ARCHITECTURE.md;
- README.md si afecta la descripción general;
- pruebas de contrato correspondientes.

Antes de finalizar, releer los archivos modificados y comprobar que diagramas y descripciones reflejen el código real.

## Documentos de entrada

- [Índice de documentación](docs/README.md)
- [Política operativa del agente y bridge](docs/agent-ai-bridge-policy.md)
- [Headless propio del agente](docs/HEADLESS-AGENT-RUNTIME.md)
- [Flujo autónomo de animación](docs/ANIMATION-AUTONOMOUS-WORKFLOW.md)
- [Transporte inline de artefactos](docs/inline-artifact-bridge.md)
- [Arquitectura CodeLab ↔ Neon](docs/CodeLab_Neon_comunicacion_extremo_a_extremo.md)
