# CodeLab A/B: sesión temporal y generación de video

**Estado:** contrato funcional acordado; implementación y entrega del video del proyecto Soldier Walk pendientes de completar y verificar.

## Responsabilidades, sin solapamiento

### Workflow A — anfitrión de sesión

A crea una máquina/sesión temporal, inicia CodeLab/PixelForge y mantiene esa sesión abierta durante el tiempo elegido por el usuario.

A:
- Inicia la sesión y publica su identificador/endpoint de mailbox cuando está lista.
- Mantiene el proceso, el runtime y el contexto vivos durante el plazo configurado.
- Atiende las solicitudes autenticadas que B le envía mientras la sesión está disponible.
- Renueva el lease del mailbox mientras la sesión siga activa.
- Cierra sus recursos temporales cuando vence el tiempo elegido o se produce una cancelación/fallo.

A **no**:
- Decide cuándo termina B.
- Genera, codifica, renderiza ni entrega el MP4.
- Espera a que se agote su propio plazo para permitir que B entregue.
- Usa su grabación de sesión como sustituto del video de la animación.

La duración de A y la duración de B son independientes. Si B termina antes, A puede seguir viva hasta que venza su plazo.

### Workflow B — cliente, productor y entregador

B se conecta a una sesión A que ya esté READY y comprueba que sigue viva. B es responsable de todo el ciclo de producción del video:

1. Identifica la sesión A correcta y valida su disponibilidad.
2. Obtiene desde ADMIN, por el mecanismo autorizado, la revisión exacta del proyecto PixelForge que se va a procesar.
3. Transfiere/restaura el proyecto en la sesión temporal A sin dar credenciales de Neon, S3 ni del bridge a Headless.
4. Solicita a A los datos de los fotogramas/contexto necesarios y coordina el procesamiento.
5. En la máquina B, codifica el resultado final a MP4 (por ejemplo, con FFmpeg); la sesión A no realiza la codificación.
6. Comprueba existencia, tamaño, duración, códec y decodificación del MP4; inspecciona visualmente el resultado.
7. Publica y entrega el artefacto final al usuario.
8. Finaliza su workflow inmediatamente después de la entrega verificada. No espera a que A termine su temporizador.

B debe fallar de forma explícita si A expira, si no puede restaurarse el proyecto autorizado, si falta algún fotograma o si el MP4 no pasa la validación. Nunca debe sustituir silenciosamente el proyecto por una demo procedural.

## Relación temporal

- A se inicia y queda READY.
- B se conecta a A y trabaja mientras A está disponible.
- B termina al haber generado, validado y entregado el MP4.
- A continúa independientemente hasta cumplir el tiempo elegido; entonces cierra la sesión.
- Si una máquina temporal desaparece, una ejecución posterior reconstruye el estado desde la revisión persistida en ADMIN. No se depende de discos ni procesos de ejecuciones anteriores.

## Persistencia y seguridad

- ADMIN es la autoridad de propiedad, autorización, revisión y persistencia del proyecto.
- A y B son máquinas efímeras. Los archivos temporales solo sirven durante la ejecución.
- Headless no recibe credenciales de Neon, S3 ni del inline bridge, ni decide el destino del proyecto.
- La restauración/transferencia debe usar el bridge autenticado y el flujo de importación autorizado existente.
- Cada ejecución debe registrar el ID de proyecto, revisión, hash de contenido, ID de sesión A, run de B y hash del MP4 entregado.
- La recuperación debe ser idempotente: repetir una ejecución no puede duplicar proyectos ni corromper el original en ADMIN.

## Criterios de aceptación

1. A mantiene la sesión durante el plazo elegido y no produce el MP4.
2. B puede conectarse a A ya iniciada, procesar y entregar sin esperar el vencimiento de A.
3. B genera el MP4 en su propio runner y termina después de validar y entregar.
4. La fuente es la revisión real del proyecto recuperada de ADMIN, no un proyecto demo ni un ID local inexistente.
5. El MP4 se puede abrir y decodificar; su duración y contenido visual se inspeccionan.
6. La pérdida de A/B no pierde el proyecto persistido y permite una nueva ejecución limpia.

## Estado técnico observado al documentar

El workflow `.github/workflows/codelab-independent-session-a.yml` ya permite elegir `session_minutes` (por defecto 360) y mantiene un host que atiende solicitudes del mailbox. El workflow B descubre una sesión READY y envía operaciones PixelForge/browser a A.

Sin embargo, el flujo actual **todavía no cumple el contrato completo**:
- `scripts/codelab-session-host.mjs` crea un workspace guest local y efímero; no restaura por sí solo el proyecto ADMIN `soldier-walk-60f-20261124`.
- A crea un contexto Playwright con grabación de video de la sesión; eso no es la codificación final del proyecto y no debe considerarse la entrega.
- La acción `record_video` en `executeBrowser` solo espera el tiempo indicado; no genera ni devuelve un MP4.
- `scripts/codelab-b-a-context-cycle.mjs` crea una demo procedural de 60 fotogramas si no recibe un proyecto local válido. Ese fallback no puede usarse para entregar el Soldier Walk real.
- El workflow B actual publica un resultado JSON de verificación, pero no genera, valida ni adjunta un MP4 final.

Por lo tanto, este documento fija el comportamiento esperado, pero **no declara que la generación/entrega del video ya esté implementada**. El trabajo pendiente es: restauración autenticada de la revisión ADMIN en A; extracción de fotogramas desde A; codificación y validación del MP4 en B; y publicación del artefacto desde B.

## Proyecto al que se aplica ahora

- Proyecto: PixelForge — Soldier Walk.
- ID histórico: `soldier-walk-60f-20261124` (la versión final guardada tiene 20 fotogramas, no 60).
- Workspace ADMIN: `ws_local_admin`.
- Revisión persistida documentada: SHA-256 `82db7ee3d5195063fdff109f7e0ad7a30089a8c907e7387e81d13b1742e8b67f`.
- Animación: 20 fotogramas a 12 FPS.

La entrega solo se considera terminada cuando B entrega el MP4 real y verificable, además del proyecto editable que ya está persistido en ADMIN.
