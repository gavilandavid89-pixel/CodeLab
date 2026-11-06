# Política obligatoria de cuenta y persistencia para pruebas

**Cuenta propietaria de trabajo y pruebas: `ADMIN`.**

Esta política aplica a cualquier agente, asistente, automatización, prueba manual o ejecución de navegador que trabaje sobre CodeLab.

## Regla principal

Todas las operaciones sobre proyectos deben realizarse dentro de la cuenta real de CodeLab del usuario, cuyo nombre de cuenta es **ADMIN**. No se debe usar una cuenta temporal, invitado, demo local, perfil inventado ni una sesión anónima para crear, editar, guardar, importar, duplicar o probar proyectos.

El objetivo es que el usuario pueda entrar posteriormente en CodeLab con su cuenta ADMIN y encontrar los proyectos, diseños, capas, cambios y resultados de las pruebas.

## Requisitos antes de operar

1. Iniciar sesión en CodeLab como `ADMIN` mediante la autenticación real del servidor.
2. Confirmar que la respuesta de sesión identifica a `ADMIN` y que el workspace devuelto pertenece a esa cuenta.
3. Confirmar que las operaciones de proyecto usan ese workspace autenticado.
4. Si no se puede autenticar o verificar la identidad/workspace, detener cualquier operación que cree o modifique proyectos. No recurrir silenciosamente al modo demo ni a una sesión anónima.
5. Nunca solicitar, imprimir, registrar en comentarios, ni incluir en commits contraseñas, cookies, tokens o secretos de autenticación.

## Automatización y pruebas con GitHub Actions

- Para las acciones de proyecto del puente de CodeLab, usar obligatoriamente `use_admin_session: true`.
- Los secretos `CODELAB_ADMIN_USERNAME` y `CODELAB_ADMIN_PASSWORD` deben corresponder a las credenciales de la cuenta CodeLab **ADMIN**. El valor esperado de `CODELAB_ADMIN_USERNAME` es `ADMIN`.
- El puente debe comprobar el usuario devuelto por `/api/auth/login` y rechazar la ejecución si no es exactamente `ADMIN`; no basta con que el login responda correctamente o que el rol sea administrador.
- Después de cargar la aplicación, comprobar `/api/auth/status` y verificar que la sesión activa sigue siendo `ADMIN` y que el workspace es el de esa cuenta.
- No usar el fallback demo de la interfaz para pruebas automatizadas.
- Las pruebas de lectura sin cambios también deben usar la cuenta ADMIN cuando inspeccionen proyectos privados del usuario.

## Guardado y verificación

Una operación no se considera terminada solo porque el navegador muestre el cambio o porque exista una copia en `localStorage`.

Para declarar guardado un proyecto o cambio:

1. Verificar que se está operando como ADMIN.
2. Confirmar el estado de sincronización con el servidor.
3. Volver a leer el proyecto/workspace desde el servidor.
4. Confirmar que el proyecto, sus elementos y los cambios esperados aparecen en esa lectura.
5. Cuando sea relevante, abrir una sesión nueva autenticada como ADMIN y comprobar que el contenido sigue disponible.

Los resultados deben distinguir claramente entre guardado local, sincronización confirmada y lectura de vuelta desde el servidor.

## Proyectos auxiliares de QA

- Los proyectos auxiliares y fixtures de pruebas también se crean dentro de la cuenta ADMIN.
- Usar nombres claramente identificables, por ejemplo `QA — ...`, y evitar sobrescribir proyectos reales del usuario.
- No borrar, archivar, renombrar ni modificar proyectos del usuario para limpiar pruebas sin autorización expresa.
- Informar al usuario del nombre y propósito de cada proyecto auxiliar creado para que pueda reconocerlo en su lista.

## Alcance y protección

Esta política no autoriza a modificar otros servicios de Render, otros repositorios, ramas ajenas ni proyectos fuera del alcance de la tarea. Se mantienen todas las restricciones específicas que haya indicado el usuario.

## Estado de cumplimiento

Una prueba solo puede marcarse como **verificada en la cuenta ADMIN** si conserva evidencia de la identidad autenticada y de la lectura de vuelta del servidor. Si alguna de esas comprobaciones falta, el resultado debe etiquetarse como no verificado, aunque el flujo visual parezca funcionar.
