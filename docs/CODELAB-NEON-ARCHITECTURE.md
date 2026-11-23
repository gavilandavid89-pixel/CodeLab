# CodeLab — arquitectura Neon y persistencia de proyectos

Este archivo es el resumen de arquitectura de persistencia. La especificación técnica detallada y el diagrama de comunicación se mantienen en [CodeLab ↔ Neon: comunicación técnica extremo a extremo](CodeLab_Neon_comunicacion_extremo_a_extremo.md).

## Principios

- Neon PostgreSQL es la fuente de verdad de cuentas, órdenes, proyectos persistentes, revisiones, resultados y metadatos de evidencia.
- El navegador puede mantener caché/estado temporal, pero no sustituye la persistencia del servidor.
- Los proyectos PixelForge y sus animaciones se guardan como documentos editables asociados a workspace, revisión y hash.
- Los vídeos e imágenes son evidencia de inspección; no son la fuente canónica del proyecto.
- Cloudflare/R2 o almacenamiento S3-compatible guarda bytes de evidencia cuando está configurado; Neon conserva las referencias y metadata.
- GitHub versiona el software y ejecuta CI; no es el transporte normal de cada edición de proyecto.

## Comunicación y activación del worker

El servidor \`server.js\` mantiene un pool PostgreSQL y un cliente dedicado \`pg.Client\` con \`LISTEN codelab_agent_bridge_wake\`. Un trigger AFTER INSERT/UPDATE de una orden a estado \`queued\` emite \`pg_notify\`. El listener arranca \`agent-bridge-worker.mjs\` bajo demanda si no está activo.

El worker tiene su propio pool SQL y su propio cliente dedicado LISTEN. Reclama órdenes de la tabla durable con transacciones y \`FOR UPDATE SKIP LOCKED\`. Cuando la cola queda vacía, espera una notificación; **no ejecuta polling de 150 ms ni un cron de keep-alive**. La notificación despierta; la fila SQL es la fuente durable.

Ambos listeners convierten el hostname Neon pooled a endpoint directo cuando detectan \`-pooler.\`, porque mantienen conexiones estables LISTEN/NOTIFY. Los pools de consultas normales pueden seguir usando el endpoint configurado en \`DATABASE_URL\`. El servidor y el worker usan \`CODELAB_DATABASE_SSL\` con TLS habilitado por defecto.

## Proyectos y animación

Las modificaciones persistentes deben seguir el flujo:

\`editor/API → validación → Neon project JSONB → server_revision + 1 → content_sha256\`.

Las escrituras críticas verifican la revisión esperada y usan locks por workspace. Un conflicto de revisión debe devolverse como conflicto, no sobrescribir el proyecto.

Para dibujo/animación:
- conservar frames, cels, capas, timings y metadatos dentro del documento persistente;
- validar los datos raster/vectoriales antes de exportar;
- generar PNG/vídeo como evidencia cuando corresponda;
- relacionar cada evidencia con proyecto, revisión y event_id;
- inspeccionar realmente el vídeo/captura antes de afirmar que la animación se ve correcta.

## Recuperación y límites

NOTIFY puede perderse si se produce antes de que LISTEN esté activo; por eso el servidor consulta órdenes queued no expiradas al terminar de armar el listener. El worker también vuelve a consultar la cola al reconectar. Las órdenes tienen expiración, heartbeat durante ejecución y recuperación limitada de filas running abandonadas.

El polling de 150 ms fue retirado. La transferencia todavía puede ser alta si se consultan snapshots con payload/result grandes, proyectos con Base64 o vídeos/imágenes. Medir por endpoint antes de atribuir cuota a un único origen.

## Mantenimiento obligatorio

Cualquier cambio de conexión, TLS, pooling, LISTEN/NOTIFY, trigger, cola, ciclo de vida, persistencia, revisiones, animación o evidencia requiere actualizar el documento técnico enlazado, el README y las pruebas correspondientes en el mismo PR. El diagrama debe describir el código actual, no una arquitectura aspiracional o histórica.
