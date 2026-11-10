# CodeLab + Penpot: motor de diseño integrado

## Principio arquitectónico

CodeLab es el único dueño de los datos y de la experiencia de producto. Penpot aporta el motor visual y los procesos técnicos que CodeLab no tiene. No se crea una segunda plataforma de usuarios, workspaces ni proyectos de producto.

| Recurso | Autoridad |
| --- | --- |
| Cuentas, autenticación, sesiones y permisos | CodeLab |
| Workspaces y proyectos web | CodeLab (estado de workspace y APIs existentes) |
| Relación proyecto CodeLab ↔ documento Penpot | Registro de integración propiedad de CodeLab |
| PostgreSQL | El mismo servidor y la misma base de datos PostgreSQL de CodeLab |
| Tablas internas de Penpot | Esquema PostgreSQL aislado `penpot`, con rol SQL dedicado |
| Archivos y assets | Almacenamiento persistente existente de CodeLab, subdirectorio `penpot/` |
| Canvas, capas, páginas, componentes y prototipos | Motor Penpot |
| Generación, editor web, preview y deploy | CodeLab |
| Animación avanzada y composición | PixelForge de CodeLab, preservado íntegramente |

## Infraestructura y aislamiento de datos

El compose de desarrollo contiene los procesos del motor: frontend, backend, exporter, admin console y Valkey. No crea otro PostgreSQL ni volúmenes de datos Docker separados.

- **PostgreSQL:** Penpot espera una URI PostgreSQL `postgresql://...`, no una JDBC URL. No se debe asumir que `currentSchema=penpot` funciona. La separación se realiza con un rol SQL dedicado cuyo `search_path` es `penpot,public`; el script `infra/penpot/bootstrap-existing-postgres.sql` prepara el esquema y el rol en la base ya existente. No reutilizar el rol de aplicación de CodeLab para Penpot.
- **Archivos:** el backend Penpot escribe en `$CODELAB_DATA_DIR/penpot`. En desarrollo, ambos procesos pueden montar el mismo directorio existente. En producción hay que demostrar que la topología permite compartir ese almacenamiento: los discos persistentes de Render no se comparten automáticamente entre servicios. Si Penpot se ejecuta como servicio separado, se requiere un adaptador compatible con el almacenamiento existente o un despliegue conjunto que comparta el mismo disco; no crear un bucket/disco paralelo sin resolverlo como parte de la integración.
- **Valkey:** cola/cache/notificaciones efímeras; no guarda cuentas, proyectos ni documentos durables.
- **Red:** backend/exporter/admin console permanecen privados. El navegador usa `/penpot/` por el mismo origen. La documentación upstream confirma que Penpot admite subpath si el proxy conserva la ruta sin reescribirla y preserva WebSockets.

## Identidad: bloqueo seguro hasta completar SSO

La configuración del runtime desactiva registro y contraseña nativos (`disable-registration`, `disable-login-with-password`). Así no aparecen cuentas paralelas. **Todavía no se habilita el acceso de usuarios finales:** CodeLab no expone hoy un proveedor OIDC compatible para Penpot. Hay que implementar y probar SSO/OIDC de CodeLab antes de permitir entrar al editor. No se debe reemplazar esto por un iframe Cloud, login duplicado, cookie compartida inventada ni acceso sin autorización.

Cada apertura, guardado, exportación y sincronización debe validar la sesión CodeLab y el ownership del workspace/proyecto. El identificador de documento Penpot se asocia al ID estable del proyecto CodeLab mediante un registro administrado por CodeLab; nunca se acepta un project ID enviado por el navegador sin comprobar su propietario.

## Integración con el generador

El adaptador server-side debe convertir documentos Penpot en un contrato versionado de CodeLab:
- páginas/boards → pantallas;
- capas, grupos y componentes → elementos y componentes reutilizables;
- estilos y tokens → sistema visual;
- imágenes y recursos → assets del proyecto;
- interacciones/prototipos → navegación y acciones;
- identificadores de origen y versión → trazabilidad para sincronización idempotente y reversible.

No se debe interpretar una exportación visual como navegación funcional si no hay interacciones explícitas. El generador CodeLab sigue produciendo la aplicación final.

## PixelForge

No eliminar ni sustituir PixelForge. Su almacenamiento, composición, timeline, validaciones, presupuestos, endpoints y pruebas permanecen bajo CodeLab. Las transiciones Penpot son una fuente adicional de especificación, no reemplazan el motor de animación.

## Despliegue y validación

La configuración de esta rama es infraestructura de desarrollo, no un despliegue listo para Render. Antes de habilitar el runtime hay que validar la versión exacta de imágenes, el esquema y permisos SQL, SSO, autorización por proyecto, almacenamiento compartido real, proxy HTTP/WebSocket, importador del documento, exportación y pruebas E2E móviles. El editor visual existente se conserva hasta alcanzar paridad y pasar las pruebas.

## Estado real

Implementado en la rama: stack privado de desarrollo, proxy same-origin y documentación inicial. En progreso: identidad OIDC CodeLab, asociación segura de documentos a proyectos, almacenamiento compartido en topología Render y adaptador Penpot→generador. No desplegar ni presentar como funcional hasta completar esas piezas.
