# CodeLab — instrucciones obligatorias para agentes

**Entrada obligatoria:** antes de cualquier trabajo, leer este archivo y [la política operativa del agente](docs/agent-ai-bridge-policy.md). Para ubicar el resto, usar el [índice documental](docs/README.md).

## 1. Modelo mental: hay dos entornos Headless distintos

No confundirlos:

- **Headless propio del agente:** se instala y ejecuta en el entorno de la IA que recibió la orden. Aquí el agente crea, edita y anima. La fuente de distribución es el artefacto real del workflow GitHub Actions. El entorno puede ser efímero; eso no elimina la obligación de instalarlo y usarlo.
- **Headless/bridge/worker de CodeLab:** pertenece al sistema CodeLab. Recibe órdenes/paquetes, importa, persiste, genera evidencia y devuelve resultados. No sustituye el entorno creativo propio del agente.

El agente es la IA que recibe la petición del usuario, no GitHub Actions, Render, Neon ni el worker.

## 2. Flujo canónico de una tarea creativa

Usuario → agente IA → Headless propio aislado → crear/editar/animar → validar → exportar paquete .codelab → el agente recoge el archivo y lo transfiere por HTTPS inline bridge → staging Neon → worker CodeLab → workspace destino → lectura de vuelta → agente inspecciona → entrega.

1. Solo una petición explícita del usuario inicia una nueva tarea del agente.
2. Al comenzar una tarea creativa, comprobar si el entorno actual tiene un Headless válido. Si falta o no corresponde a la versión requerida, obtener el artefacto oficial, instalarlo y ejecutarlo en el entorno propio del agente.
3. Consultar el proyecto/revisión y las órdenes activas antes de continuar un trabajo existente. No duplicar órdenes activas.
4. Crear y modificar en el Headless propio. No enviar cada fotograma a CodeLab como mecanismo normal de edición.
5. Validar el proyecto y la animación en el Headless; generar e inspeccionar evidencia visual real.
6. Exportar el paquete nativo requerido. El Headless no inicia ni conoce el transporte: el agente, fuera del Headless, toma el archivo exportado y lo transfiere mediante el intermediario HTTPS documentado.
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

## 5.1. Inspección y reparación antes de entregar vídeo

- Todo vídeo final debe compararse explícitamente con los requisitos originales del usuario: contenido, acciones, continuidad, composición, duración, ritmo, resolución/formato y cualquier detalle solicitado.
- La inspección visual del archivo final es obligatoria; comprobar solo que existe, abre o reproduce no demuestra que cumpla el pedido.
- Si hay errores, omisiones, elementos incoherentes, frames defectuosos o resultados que no tienen sentido, **no entregar todavía**. Volver al proyecto editable y usar Headless para corregirlo de forma incremental.
- Headless puede trabajar sobre el proyecto existente: abrir la última revisión, modificar los frames/capas/elementos afectados, conservar las partes correctas, validar y exportar una nueva revisión. No reiniciar desde cero por defecto.
- Tras corregir, transferir y persistir la nueva revisión, volver a generar el vídeo A/B e inspeccionar otra vez el archivo final. Repetir hasta cumplir los requisitos o identificar un bloqueo real.
- Solo reconstruir desde cero si la reparación incremental no es viable o si el usuario lo pide. No afirmar que se corrigió algo sin comprobar el vídeo resultante.

## 6. A/B: etapa integrada de entrega de vídeo

A/B no es un sistema aislado ni un flujo alternativo de creación. Es la etapa de procesamiento/render/captura de vídeo integrada en la misma tarea del usuario, después de que el proyecto editable y su revisión estén disponibles en CodeLab. El agente coordina A/B, espera el vídeo final, lo inspecciona y entrega ese vídeo al usuario. A/B no reemplaza la persistencia del proyecto editable. Usar una sola sesión A y una sola B procesadora por trabajo. Nunca lanzar lotes de estrés ni usar A/B para edición, importación o persistencia. Consultar [VIDEO-PROCESSING-AB.md](docs/VIDEO-PROCESSING-AB.md).

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


## 9. Aislamiento absoluto del Headless y formato de entrega

- El Headless propio del agente **no se conecta a ningún entorno intermediario**: no llama al bridge, CodeLab, Neon, S3, worker ni APIs internas. No conoce tokens ni endpoints de transferencia.
- El Headless solo crea/modifica el proyecto y exporta el archivo nativo.
- El **agente IA**, fuera del Headless, recoge ese archivo exportado y lo lleva al intermediario soportado (HTTPS inline bridge) para importarlo en CodeLab. La responsabilidad de orquestar la transferencia y verificar la persistencia es del agente.
- El GIF local solo se entrega cuando el usuario pide expresamente un GIF. Si no lo pide, no se presenta como resultado ni como sustituto del flujo: se entrega el proyecto editable a través del intermediario y se verifica en CodeLab.
- Para tareas que incluyen vídeo final, A/B es una etapa posterior integrada: procesa la revisión real del proyecto, produce el archivo de vídeo final, el agente lo inspecciona y lo entrega al usuario. A/B no reemplaza la persistencia del proyecto editable.
