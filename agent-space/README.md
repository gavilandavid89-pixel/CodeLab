# CodeLab Agent Space

Carpeta aislada para construir un puente de interacción con la interfaz real de CodeLab.

## Objetivo

Permitir que un navegador automatizado autorizado inspeccione el DOM visible y ejecute acciones de usuario sobre CodeLab sin mezclar la lógica de diagnóstico con el editor principal. La primera versión es un panel de navegador del mismo origen servido desde `public/agent-space/index.html`.

## Abrir

Después del despliegue: `/agent-space/index.html`.

## Qué puede hacer el panel

- Mostrar CodeLab real dentro de un iframe del mismo origen.
- Leer título, URL, controles visibles, campos y estados básicos.
- Pulsar un elemento por selector CSS.
- Leer texto/atributos, enfocar y rellenar campos, o seleccionar opciones.
- Recargar la página y listar controles para que una prueba de Playwright pueda localizar elementos.

## Límites intencionales

- No acepta ni ejecuta JavaScript arbitrario.
- No incluye endpoints de servidor para ejecutar comandos, acceder al sistema de archivos, ejecutar shell o saltarse la autenticación.
- Las acciones ocurren en la sesión de navegador que tiene abierta esta página; la página por sí sola no proporciona acceso remoto desde ChatGPT.
- Para una interacción desde un agente remoto, conectar un runner de Playwright controlado y autorizado que abra esta ruta, ejecute pasos explícitos y devuelva capturas, consola y resultados. Mantener ese runner separado del proceso web de producción.
- Antes de exponer capacidades de escritura a un agente remoto, añadir autenticación fuerte, autorización por sesión, límite de acciones, registro de auditoría y un entorno de prueba con proyectos desechables.

## Siguiente paso

Añadir un runner de Playwright separado (por ejemplo, dentro de `agent-space/runner/`) que use el navegador para realizar acciones reales, recoja screenshots/trazas y devuelva resultados estructurados. Mantener el runner fuera de las rutas públicas y sin capacidad de ejecutar comandos arbitrarios desde peticiones web.
