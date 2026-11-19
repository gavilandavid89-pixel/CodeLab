# 🚨🚨 POLÍTICA N.º 1 — SUPERVISIÓN OBLIGATORIA DE A Y CADA B 🚨🚨

> **ESTA ES LA REGLA OPERATIVA DE MÁXIMA PRIORIDAD. DEBE CUMPLIRSE ANTES DE DAR POR TERMINADA, ABANDONAR O CAMBIAR UNA EJECUCIÓN.**
>
> **A y cada B tienen un ciclo independiente de hasta 10 minutos, con comprobación cada 30 segundos. Si el resultado llega antes, la espera termina inmediatamente, se inspecciona el resultado y se decide el siguiente paso.**
>
> **No se puede declarar terminado un trabajo únicamente por timeout, estado verde, `success`, ausencia de errores aparentes o porque haya pasado parte del tiempo de espera.**

## Ciclo obligatorio de supervisión

### A — sesión persistente
Al iniciar A, el agente IA debe supervisar A durante un máximo de **10 minutos**, comprobando cada **30 segundos**: 0:00, 0:30, 1:00, 1:30, 2:00, 2:30, 3:00, 3:30, 4:00, 4:30, 5:00, 5:30, 6:00, 6:30, 7:00, 7:30, 8:00, 8:30, 9:00, 9:30 y 10:00.
Si A arranca o responde antes de completar los 10 minutos, **la espera de A termina en ese momento**. El agente inspecciona el estado/evidencia disponible y pasa a supervisar el B correspondiente. Si A falla, pierde la sesión o no llega a estar disponible dentro del ciclo, el agente inspecciona la causa antes de decidir corregir/reintentar.

### Cada B — ciclo independiente
Cada petición enviada por el puente B debe tener su propio ciclo de supervisión: **0:00 → 0:30 → 1:00 → ... → 9:30 → 10:00.**
El agente IA debe esperar el resultado de **ese B** hasta un máximo de **10 minutos**, comprobando cada **30 segundos**.

Si B devuelve el resultado antes:
1. **se anula inmediatamente la espera restante**;
2. se inspecciona la respuesta;
3. se inspecciona la evidencia disponible;
4. se valida contra la petición original;
5. se decide el siguiente paso.

Si B no responde al llegar a 10:00, se clasifica como timeout y el agente debe inspeccionar la causa y decidir si corregir, reintentar o continuar.

### Cada nuevo B reinicia su propio ciclo
Cuando el agente lance otro B, **no reutiliza el tiempo del B anterior**. Cada B recibe nuevamente **10 minutos máximos + comprobación cada 30 segundos**.

Ejemplo: **A → B1 (10 min / 30 s) → resultado → inspección → B2 (10 min / 30 s) → resultado → inspección → B3 (10 min / 30 s) → ...**

### Regla de inspección
**Resultado recibido no significa resultado aceptado.** Un `success`, workflow verde, API aceptada o respuesta aparentemente correcta no sustituye la inspección. Cuando exista evidencia visual, debe inspeccionarse realmente antes de aceptar el resultado.

---

# 🚨 POLÍTICA OBLIGATORIA DEL AGENTE IA, PUENTE B Y SESIÓN A

> **LEER Y APLICAR ANTES DE CADA SESIÓN DE TRABAJO.**
>
> Esta política es de cumplimiento obligatorio. El archivo de entrada del agente es **[AGENTS.md](../AGENTS.md)** y apunta aquí como documento completo. Si existe conflicto entre una implementación y esta política, la implementación debe adaptarse a la política.
>
> **Regla central:** **Usuario → Agente IA → B → A → B → Agente IA → siguiente B → A → ...**
>
> **Solo una petición explícita del usuario puede iniciar una nueva ejecución del agente IA.**

## Roles

**Agente IA:** ChatGPT es el agente responsable de las peticiones del usuario sobre CodeLab. El agente IA razona, decide qué hacer, lanza B, interpreta sus resultados, corrige problemas y determina el siguiente paso.

**B — puente:** B es únicamente el puente entre el agente IA y A. Transporta la solicitud hacia A, espera su resultado y devuelve la respuesta/evidencia al agente IA. B no es otro agente IA y no toma decisiones de producto ni sustituye al agente IA.

**A — sesión persistente:** A es la sesión persistente que ejecuta las operaciones reales de CodeLab y conserva el estado de sesión/browser cuando corresponda.

Flujo obligatorio:
**Usuario → Agente IA → B → A → B → Agente IA → siguiente B → A → ...**

## Activación exclusiva por el usuario

CodeLab, A, B, workers, workflows, webhooks y procesos auxiliares **no pueden invocar, despertar, llamar ni crear una nueva ejecución de ChatGPT**.

La existencia de una tarea, un cambio de estado, un resultado, un timeout, un error, un evento de GitHub o una señal de A/B nunca debe convertirse por sí sola en una nueva petición al agente IA.

**Solo un mensaje/petición explícita del usuario puede iniciar el trabajo del agente IA.**

A y B pueden permanecer activos, conservar estado, completar trabajo previamente solicitado y devolver resultados, pero no pueden iniciar una nueva intervención del agente IA.

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

## Inspección visual obligatoria

Cuando B entregue al agente IA una **imagen, captura, frame, secuencia de imágenes, GIF, vídeo, WebM u otra evidencia visual**, el agente IA debe **inspeccionarla realmente antes de aceptar el resultado**.

En especial, los vídeos deben analizarse como vídeo: no basta con comprobar que el archivo existe, que tiene duración válida, que el workflow está verde o que el tamaño del archivo es razonable. El agente IA debe inspeccionar frames representativos y, cuando la calidad dependa del movimiento, comparar frames a lo largo de la secuencia.

Para animación se debe comprobar como mínimo:

- legibilidad de la figura y su silueta;
- anatomía y proporciones consistentes;
- pose y dirección del movimiento;
- continuidad entre frames;
- coherencia de pies, manos, cabeza, torso y extremidades;
- ausencia de saltos, deformaciones o movimientos accidentales;
- que el movimiento solicitado sea realmente el movimiento observado;
- que el dibujo tenga suficiente definición y no sea simplemente un conjunto de bloques/píxeles confusos;
- que la calidad visual cumpla el nivel solicitado por el usuario.

Si la evidencia visual no cumple, **el agente IA debe rechazar el resultado aunque la prueba automatizada sea verde** y ejecutar correcciones mediante un nuevo ciclo B → A.

## Política de calidad para dibujo y animación

El agente IA no debe limitarse a producir una imagen técnicamente válida. Debe trabajar con un ciclo de calidad:

**objetivo → referencia/contexto real → acción estructurada → render → inspección visual → evaluación → corrección → nuevo render → nueva inspección.**

Para cada etapa visual relevante debe conservarse contexto estructurado y editable: capas, frames, cels, strokes, dimensiones, referencias y estado anterior cuando esté disponible.

Antes de avanzar de una etapa de dibujo a la siguiente, el agente IA debe comprobar al menos:

- **silueta:** figura reconocible a primera vista;
- **anatomía:** proporciones y articulaciones coherentes;
- **pose:** postura intencional y no accidental;
- **movimiento:** trayectoria y cambios entre frames coherentes con la acción solicitada;
- **consistencia:** la figura no cambia arbitrariamente de forma, tamaño o posición;
- **detalle:** los elementos importantes siguen siendo legibles;
- **presentación:** la imagen no depende de una estética pixelada cuando el usuario pidió una persona definida;
- **continuidad:** cada frame se deriva del estado real anterior cuando el flujo sea secuencial.

La evaluación debe producir una decisión explícita: **aceptar**, **corregir** o **rechazar/reconstruir**.

No se debe aprobar una animación simplemente porque “se mueve”. Si el movimiento parece baile, temblor, deriva de extremidades, deformación o una acción distinta de la solicitada, debe clasificarse como fallo visual y corregirse.

## 🔎 Referencias visuales dinámicas — OBLIGATORIO CUANDO APLIQUE

**El agente IA NO debe depender de una imagen implantada/bundled en el sistema como fuente obligatoria del dibujo.**

Cuando una tarea visual necesite referencias, el agente IA puede y debe buscar referencias útiles en Internet durante la tarea, por ejemplo para:

- anatomía;
- pose y movimiento;
- ropa y detalles;
- iluminación y sombras;
- composición;
- objetos/props;
- perspectiva;
- estilo visual.

La referencia externa es **evidencia para razonar**, no el artwork final.

### Reglas de uso

1. **Buscar en el momento:** la referencia puede obtenerse durante la tarea según la intención concreta del usuario.
2. **Registrar contexto:** cada referencia utilizada debe conservar URL, función/rol y notas en el contexto estructurado de la escena.
3. **Separar referencia y resultado:** la imagen externa no se convierte automáticamente en el dibujo ni en una dependencia permanente del proyecto.
4. **Crear desde la intención:** el resultado editable debe construirse mediante escena semántica, capas, strokes y demás estructuras de CodeLab.
5. **Actualizar referencias:** si una referencia deja de ser útil, puede sustituirse sin romper el proyecto.
6. **Verificar visualmente:** la referencia orienta el trabajo, pero el resultado final debe pasar la inspección visual de esta política.
7. **Animación:** las referencias externas pueden orientar pose/movimiento; aun así, la continuidad entre frames debe derivarse del **estado real del frame anterior en CodeLab/A**, nunca de una suposición del agente.

**Resumen operativo:**
**intención del usuario → búsqueda de referencias → inspección de referencias → escena semántica → dibujo editable → render → inspección → corrección → resultado.**

No se debe introducir una imagen fija del sistema como sustituto de este proceso ni tratar una referencia externa como el resultado final.

## Referencias y estado previo

Cuando se utilice una referencia visual o una animación existente, el agente IA debe pedir a A/B el estado real necesario para continuar. No debe inventar el contenido del frame anterior ni reconstruirlo desde memoria.

Para animación secuencial, el siguiente frame debe poder trazarse al contexto real del frame anterior: frame ID, layer ID, cel/raster/strokes y, cuando sea necesario, evidencia visual del estado.

## Controles de dibujo

Las operaciones de dibujo deben favorecer controles editables y verificables sobre operaciones irreversibles o ambiguas.

El agente IA debe poder separar y corregir, cuando corresponda:

- pose;
- silueta;
- proporciones;
- extremidades;
- cabeza;
- torso;
- manos/pies;
- profundidad/posición;
- detalles;
- timing y duración del frame;
- trayectoria del movimiento.

Las correcciones deben registrarse como acciones estructuradas y no depender únicamente de una modificación visual opaca.

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
- evaluación visual;
- decisión posterior del agente IA;
- correcciones realizadas.

Nunca registrar contraseñas, cookies, tokens ni secretos.

Esta política complementa la política de cuenta ADMIN y persistencia de CodeLab y no amplía el alcance autorizado sobre otros repositorios o servicios de Render.
