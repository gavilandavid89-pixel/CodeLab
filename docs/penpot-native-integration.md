# CodeLab + Penpot: motor de diseño integrado

## Principio arquitectónico

CodeLab es el único dueño de los datos y de la experiencia de producto. Penpot aporta el motor de diseño y los procesos técnicos que CodeLab no tiene. No se instala una segunda plataforma de usuarios, proyectos, archivos ni almacenamiento.

| Recurso | Autoridad |
| --- | --- |
| Cuentas, autenticación, sesiones y permisos | CodeLab |
| Workspaces y proyectos | CodeLab |
| Persistencia PostgreSQL | Base de datos PostgreSQL existente de CodeLab |
| Archivos y assets | Directorio/almacenamiento persistente existente de CodeLab |
| Historial, cuotas y propiedad | CodeLab |
| Canvas, capas, páginas, componentes y prototipos | Motor Penpot |
| Renderizado/exportación de diseño | Procesos internos de Penpot |
| Cola/cache efímera requerida por Penpot | Valkey privado |
| Generación, editor web, preview y deploy | CodeLab |
| Animación avanzada y composición existente | PixelForge de CodeLab |

## Infraestructura permitida

El compose contiene únicamente los procesos que Penpot necesita como motor: frontend, backend, exporter, admin console y Valkey. **No crea otro PostgreSQL ni volúmenes Docker de datos separados.**

- PostgreSQL: reutilizar el mismo servidor y base de datos de CodeLab, con un esquema dedicado `penpot` para evitar colisiones de tablas. Configurar el JDBC URL de Penpot con `currentSchema=penpot`.
- Archivos: montar el mismo directorio persistente que CodeLab ya usa; Penpot escribe sus assets en el subdirectorio `penpot/`. No crear un segundo disco ni un segundo sistema de almacenamiento.
- Valkey: proceso efímero de cola/cache que Penpot requiere; no se usa para usuarios, proyectos ni datos durables.
- Servicios Penpot: privados, sin puertos públicos. El navegador accede a través del origen de CodeLab en `/penpot/`.

## Identidad y propiedad de proyectos

No habilitar registro autónomo para usuarios finales. CodeLab debe autenticar al usuario y autorizar el workspace/proyecto antes de abrir, guardar, exportar o sincronizar un documento Penpot. El adaptador debe vincular el identificador de documento Penpot a los IDs de workspace/proyecto existentes de CodeLab, guardando esa relación en la base de datos existente de CodeLab. La sesión de Penpot debe emitirse o federarse desde el backend de CodeLab; no pedir una segunda cuenta.

## Integración con el generador

El adaptador server-side debe leer el documento de diseño y normalizar:
- páginas/boards como pantallas de CodeLab;
- capas y componentes como elementos reutilizables;
- estilos/tokens como sistema visual;
- assets como recursos del proyecto existentes;
- conexiones y transiciones del prototipo como navegación/acciones reales.

La sincronización debe ser versionada, idempotente y reversible. El generador CodeLab sigue produciendo la aplicación; Penpot no genera ni aloja la app final.

## Animación

No eliminar ni reemplazar PixelForge. Su almacenamiento, composición, timeline, validaciones, presupuestos, endpoints y pruebas permanecen bajo CodeLab. Las transiciones de prototipo Penpot se importan como especificaciones de navegación/transición y no sustituyen el motor de animación existente.

## Configuración

Copiar `.env.example` y completar las variables con credenciales de la infraestructura **existente** de CodeLab. No crear un PostgreSQL nuevo ni mover datos de usuarios/proyectos. `CODELAB_DATA_DIR` debe apuntar al directorio persistente actual de CodeLab. En producción, la URL pública debe ser el dominio HTTPS de CodeLab y el proxy debe conservar rutas, cookies, cabeceras y WebSocket.

## Estado real

La rama añade la base de infraestructura privada y el proxy same-origin. La unificación de identidad, la autorización por workspace, la asociación de documentos con proyectos, el adaptador del generador y la integración de interfaz todavía requieren implementación y pruebas antes de reemplazar el editor visual actual o desplegar a producción.
