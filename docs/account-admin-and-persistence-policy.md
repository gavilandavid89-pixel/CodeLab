# Política obligatoria de cuenta y persistencia para pruebas

**Cuenta propietaria de trabajo y pruebas: `ADMIN`.**

Esta política aplica a operaciones que leen o modifican proyectos y datos reales del usuario. El contexto de cuenta/workspace debe obtenerse del mecanismo de identidad y autenticación ya configurado para CodeLab; no se debe inventar ni sustituir esa identidad. Los workflows auxiliares antiguos pueden tener contratos propios y no definen por sí solos el flujo operativo actual.

## Regla principal

Las operaciones sobre proyectos reales del usuario deben realizarse dentro de su cuenta/workspace autenticado (la cuenta propietaria identificada como **ADMIN** en el entorno configurado). No se debe reemplazar esa identidad por una cuenta demo ni por un usuario inventado.

El objetivo es que el usuario pueda entrar posteriormente en CodeLab con su cuenta ADMIN y encontrar los proyectos, diseños, capas, cambios y resultados de las pruebas.

## Requisitos antes de operar

1. Iniciar sesión en CodeLab como `ADMIN` mediante la autenticación real del servidor.
2. Confirmar que la respuesta de sesión identifica a `ADMIN` y que el workspace devuelto pertenece a esa cuenta.
3. Confirmar que las operaciones de proyecto usan ese workspace autenticado.
4. Si no se puede autenticar o verificar la identidad/workspace, detener cualquier operación que cree o modifique proyectos. No recurrir silenciosamente al modo demo ni a una sesión anónima.
5. Nunca solicitar, imprimir, registrar en comentarios, ni incluir en commits contraseñas, cookies, tokens o secretos de autenticación.

## Automatización, sesiones locales y pruebas

- El flujo vigente debe conservar la identidad y el workspace que el sistema obtiene de la configuración/autenticación del repositorio y del servidor.
- Las sesiones locales/headless son útiles para ejecutar pruebas y automatización en un entorno aislado. Se pueden usar con un directorio de datos temporal y fixtures propios; no deben eliminarse por el mero hecho de no ser la sesión de producción.
- Una sesión local aislada no puede utilizarse para afirmar que se leyó o modificó el workspace real de ADMIN. Para esa afirmación se requiere autenticación real y lectura de vuelta del servidor.
- El puente GitHub Actions heredado conserva su contrato específico: para sus comandos que operan sobre el workspace real, `use_admin_session: true` es obligatorio.
- Los secretos `CODELAB_ADMIN_USERNAME` y `CODELAB_ADMIN_PASSWORD` deben corresponder a las credenciales de la cuenta CodeLab **ADMIN**. El valor esperado de `CODELAB_ADMIN_USERNAME` es `ADMIN`.
- El puente exige que `CODELAB_ADMIN_USERNAME` sea exactamente `ADMIN`, comprueba que `/api/auth/login` devuelva el nombre exacto `ADMIN` con proveedor `local` e ID de usuario, y rechaza la ejecución si no coincide. No basta con que el login responda correctamente o que el rol sea administrador.
- Después de cargar la aplicación, comprobar `/api/auth/status` y verificar que la sesión activa sigue siendo `ADMIN`, con el mismo ID de usuario y el mismo `workspaceId` que devolvió el login. Si identidad o workspace no coinciden, la ejecución se detiene antes de operar.
- No usar el fallback demo para operar sobre proyectos reales del usuario. Los tests aislados pueden usar su propia sesión local/headless si no acceden a datos reales y si el resultado se etiqueta como prueba aislada.
- Las pruebas de lectura sin cambios también deben usar la cuenta ADMIN cuando inspeccionen proyectos privados del usuario.

## Guardado y verificación

Una operación no se considera terminada solo porque el navegador muestre el cambio o porque exista una copia en `localStorage`.

Para declarar guardado un proyecto o cambio:

1. Verificar que se está operando como ADMIN.
2. Confirmar el estado de sincronización con el servidor.
3. Volver a leer el proyecto/workspace desde el servidor.
4. Confirmar que el proyecto, sus elementos y los cambios esperados aparecen en esa lectura.
5. Cuando sea relevante, abrir una sesión nueva autenticada como ADMIN y comprobar que el contenido sigue disponible.

Los resultados exitosos del puente incluyen `diagnostics.account_context` con cuenta, proveedor, rol, workspace y confirmaciones de identidad/workspace; nunca incluyen contraseñas, cookies ni tokens. Los resultados deben distinguir claramente entre guardado local, sincronización confirmada y lectura de vuelta desde el servidor.

## Proyectos auxiliares de QA

- Los proyectos auxiliares que deban quedar disponibles para el usuario se crean dentro de su cuenta ADMIN. Los fixtures efímeros de CI/headless pueden permanecer en un directorio de datos aislado y no se presentan como proyectos persistidos de ADMIN.
- Usar nombres claramente identificables, por ejemplo `QA — ...`, y evitar sobrescribir proyectos reales del usuario.
- No borrar, archivar, renombrar ni modificar proyectos del usuario para limpiar pruebas sin autorización expresa.
- Informar al usuario del nombre y propósito de cada proyecto auxiliar creado para que pueda reconocerlo en su lista.

## Alcance y protección

Esta política no autoriza a modificar otros servicios de Render, otros repositorios, ramas ajenas ni proyectos fuera del alcance de la tarea. Se mantienen todas las restricciones específicas que haya indicado el usuario.

## Estado de cumplimiento

Una prueba solo puede marcarse como **verificada en la cuenta ADMIN** si conserva evidencia de la identidad autenticada y de la lectura de vuelta del servidor. Si alguna de esas comprobaciones falta, el resultado debe etiquetarse como no verificado, aunque el flujo visual parezca funcionar.
