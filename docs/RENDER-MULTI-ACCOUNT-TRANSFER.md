# Render y cuentas múltiples

## Estrategia de infraestructura

CodeLab puede desplegar servicios de Render en distintas cuentas. Esta estrategia se utiliza para disponer de mayor capacidad de transferencia de datos y distribuir la carga de infraestructura entre cuentas, cuando sea necesario.

Cada cuenta de Render mantiene sus propios servicios y, por tanto, una migración entre cuentas puede cambiar automáticamente la URL pública del servicio. La URL no debe considerarse un identificador permanente del proyecto.

## Migraciones de cuenta

Cuando CodeLab cambia de una cuenta de Render a otra:

1. Se despliega el servicio de CodeLab en la nueva cuenta.
2. Se verifica que el nuevo servicio esté activo.
3. Se obtiene la nueva URL pública.
4. Se actualizan los workflows de GitHub Actions y cualquier configuración que consuma el servicio.
5. Se ejecutan las pruebas contra la nueva URL.
6. La URL anterior se considera obsoleta salvo que el servicio antiguo siga siendo mantenido explícitamente.

### Migración actual documentada

La infraestructura anterior utilizaba:

- https://codelab-pbw9.onrender.com

Tras el cambio de cuenta, el servicio activo de CodeLab es:

- https://codelab-qedi.onrender.com

El workflow .github/workflows/inspect-black-video-force.yml fue actualizado para utilizar la URL actual.

## Regla para pruebas

Los workflows que necesiten un CodeLab remoto deben apuntar al servicio activo de la cuenta actualmente seleccionada. No se debe reutilizar una URL de una cuenta anterior simplemente porque siga presente en un workflow histórico.

Cuando una prueba E2E sea autocontenida y arranque su propio servidor local, debe preferir esa instancia local y no depender de Render.

## Transferencia y separación de cuentas

El uso de varias cuentas de Render es una decisión de infraestructura para ampliar la capacidad disponible de transferencia de datos. No implica que cada cuenta sea una aplicación independiente: todas pueden formar parte de la misma arquitectura CodeLab, siempre que los servicios y sus URLs estén correctamente identificados.

Por seguridad, las credenciales de administrador y demás secretos utilizados por GitHub Actions deben mantenerse en GitHub Secrets; esta documentación no contiene valores de secretos.
