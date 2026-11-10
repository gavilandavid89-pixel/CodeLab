# CodeLab + Penpot: integración nativa

## Objetivo

Penpot pasa a ser el motor del espacio visual de CodeLab. No se abre Penpot Cloud, no se envía al usuario a otra web y no se depende de una cuenta ni de una API de terceros. La experiencia pública debe permanecer bajo el mismo origen de CodeLab, en `/penpot/`, y el resto de las pantallas (espacios, editor web, Preview/Run, proyectos, agentes, historial, APIs y deploy) siguen siendo de CodeLab.

## Qué se incorpora

El stack privado definido en `infra/penpot/docker-compose.yml` contiene frontend, backend, exportador, consola administrativa, PostgreSQL y Valkey. Ninguno de esos servicios publica un puerto al exterior; solo el servidor web de CodeLab debe ser público. Las llamadas internas del propio Penpot entre frontend/backend/exportador son parte de su arquitectura, no una dependencia de Penpot Cloud.

La configuración se basa en el despliegue oficial de Penpot y su arquitectura documentada. Penpot utiliza frontend ClojureScript/React, backend Clojure/JVM, PostgreSQL, Valkey/Redis y un exportador separado.

## Integración requerida en CodeLab

1. El servidor CodeLab debe actuar como reverse proxy same-origin para `/penpot/*`, preservando rutas, query strings, cookies y cabeceras de WebSocket. No se debe exponer directamente el frontend ni sus servicios internos.
2. Penpot debe usar `PENPOT_PUBLIC_URI=https://<dominio-codelab>/penpot/`. El proxy debe conservar el subpath sin reescribirlo.
3. La sesión de CodeLab y la identidad de usuario deben ser la autoridad de acceso a proyectos CodeLab. La estrategia de identidad de Penpot debe evitar que el usuario tenga que registrarse en un segundo sistema; la vinculación de identidades debe implementarse antes de habilitar usuarios finales.
4. Los documentos Penpot deben persistirse en su PostgreSQL y almacenamiento de assets persistente, con backups y aislamiento por usuario/workspace.
5. Un adaptador del lado servidor debe traducir páginas/boards, componentes, tokens, assets y prototipos a la representación de pantallas/acciones del generador CodeLab. Las conexiones de prototipo deben convertirse en navegación real; no basta con importar capturas o HTML estático.
6. La exportación/preview debe seguir usando el generador y el editor web de CodeLab.
7. Pixelforge y sus módulos de animación no se eliminan ni se sustituyen. Se conserva su pipeline, sus formatos, sus límites y sus pruebas. Las animaciones de prototipo de Penpot se mapean como una fuente adicional de especificación, sin degradar la animación de Pixelforge.

## Desarrollo local

1. Copiar `.env.example` a `.env` y establecer secretos únicos.
2. Levantar el stack privado: `docker compose -f infra/penpot/docker-compose.yml --env-file infra/penpot/.env up -d`.
3. El proxy de CodeLab debe apuntar a `http://penpot-frontend:8080` desde la misma red Docker.
4. No exponer los puertos internos ni habilitar cookies inseguras en producción.

## Estado

Este commit incorpora el stack privado reproducible y la especificación de integración. **No declara terminada la integración de interfaz, autenticación, proxy, sincronización con el generador ni despliegue en Render.** Esos pasos son necesarios antes de retirar el editor visual actual. No se debe desplegar esta pila sin configurar almacenamiento persistente, secretos, dominio y recursos adecuados.

## Licencia y atribución

Penpot se distribuye bajo Mozilla Public License 2.0 (MPL-2.0). Se conserva el aviso de licencia de upstream en `infra/penpot/LICENSE`. Cualquier incorporación o modificación de archivos fuente de Penpot debe conservar los avisos de copyright/licencia y cumplir las obligaciones de distribución de la MPL-2.0.
