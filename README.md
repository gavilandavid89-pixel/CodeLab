# CodeLab XD Studio Pro v2.0 - Render Deployment

Plataforma Web Multiproyecto con Autoguardado Persistente, Copiloto IA 10x y Conexión de Cuentas (Google / GitHub).

## Novedades v2.0:
- **Pantalla de Bienvenida (Dashboard)**: Galería visual de tus proyectos con buscador, opción de duplicar, renombrar y crear nuevos.
- **Persistencia en LocalStorage**: Tu trabajo nunca se borra al cerrar el navegador.
- **Conexión de Cuentas (Google / GitHub)**: Vincula tu perfil de desarrollador directamente en la interfaz.
- **Copiloto IA 10x**: Respuestas rápidas para Landing Pages, formularios validados, temas CSS y reparación de errores.
- **Servidor Express para Render**: Configuración de un solo clic para despliegue en Render.com.

## Instrucciones para desplegar en Render:
1. Extrae los archivos de `CodeLab_XD_Studio_Pro_v2.zip`.
2. Sube todo a un nuevo repositorio de GitHub.
3. En Render.com -> **New Web Service** -> Selecciona tu repositorio.
4. Comando de Build: `npm install`
5. Comando de Inicio: `node server.js`
