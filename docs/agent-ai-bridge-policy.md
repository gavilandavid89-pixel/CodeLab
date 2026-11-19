# Política obligatoria del agente IA, puente B y sesión A

## Roles

**Agente IA:** ChatGPT es el agente responsable de las peticiones del usuario sobre CodeLab. El agente IA razona, decide qué hacer, lanza B, interpreta sus resultados, corrige problemas y determina el siguiente paso.

**B — puente:** B es únicamente el puente entre el agente IA y A. Transporta la solicitud hacia A, espera su resultado y devuelve la respuesta/evidencia al agente IA. B no es otro agente IA y no toma decisiones de producto ni sustituye al agente IA.

**A — sesión persistente:** A es la sesión persistente que ejecuta las operaciones reales de CodeLab y conserva el estado de sesión/browser cuando corresponda.

Flujo obligatorio:
**Usuario → Agente IA → B → A → B → Agente IA → siguiente B → A → ...**

## Monitoreo de A

Al comenzar una sesión A, el agente IA debe monitorizarla durante **10 minutos**, comprobando su estado **cada 30 segundos**.

Cadencia:
**0:00, 0:30, 1:00, 1:30, 2:00, 2:30, 3:00, 3:30, 4:00, 4:30, 5:00, 5:30, 6:00, 6:30, 7:00, 7:30, 8:00, 8:30, 9:00, 9:30 y 10:00.**

Durante la monitorización se deben detectar finalización, fallo, pérdida de sesión, errores o ausencia de actividad. No se debe asumir que A está correcta solo porque siga viva.

## Espera de cada B

Cada vez que el agente IA lance un B:

1. B envía la solicitud a A.
2. El agente IA debe esperar el resultado de **ese B hasta 10 minutos**.
3. Debe conservar y analizar la respuesta y la evidencia recibidas.
4. Si B responde antes, el análisis comienza inmediatamente.
5. Si B no responde al llegar a 10 minutos, esa ejecución se considera timeout; el agente IA debe inspeccionar la causa y decidir si corregir, reintentar o continuar con otro B.

El límite de 10 minutos es **independiente para cada B**. No se descuenta el tiempo utilizado por un B anterior.

## Repetición

El ciclo se repite por cada B lanzado:

**Agente IA → B → A → respuesta de B → análisis del Agente IA → nuevo B → A → ...**

B no puede considerarse el responsable de la tarea. El responsable siempre es el agente IA.

## Fuente de verdad

Para proyectos, diseños, frames, capas, animaciones y demás estado de CodeLab, la fuente de verdad es el estado real de CodeLab/A.

El agente IA debe decidir el siguiente paso usando la evidencia real devuelta por A. Cuando una operación dependa de un estado anterior, debe consultarse ese estado; no debe reconstruirse ni inferirse de memoria.

La evidencia estructurada y la evidencia visual deben evaluarse conjuntamente. Un resultado técnicamente válido no se considera automáticamente bueno si la evidencia visual demuestra lo contrario.

## Verificación

Una petición no está terminada solo porque B devuelva success, un workflow termine en verde o una API acepte la operación.

El agente IA debe verificar el resultado contra la petición original y, cuando corresponda, contra:
- estado persistido;
- lectura de vuelta desde CodeLab;
- evidencia visual;
- comportamiento real de la aplicación.

Si no cumple, el agente IA debe corregir y repetir el ciclo.

## Auditoría

Cuando esté disponible, conservar:
- ID de sesión A;
- ID de cada B;
- timestamps;
- solicitud y respuesta;
- duración de espera;
- errores/timeouts;
- evidencia de CodeLab;
- decisión posterior del agente IA.

Nunca registrar contraseñas, cookies, tokens ni secretos.

Esta política complementa la política de cuenta ADMIN y persistencia de CodeLab y no amplía el alcance autorizado sobre otros repositorios o servicios de Render.
