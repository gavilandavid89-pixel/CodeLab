# Forma de trabajo del agente

## Objetivo

Esta es la forma de trabajo obligatoria para las tareas de dibujo, pixel art, animación y edición dentro de CodeLab.

La regla central es:

**B → A → contexto → B → A → contexto → B → A...**

Nunca se debe saltar el ciclo para tomar decisiones basadas en suposiciones.

> **Protocolo de autonomía y comunicación:** para animación, también es obligatorio seguir [ANIMATION-AUTONOMOUS-WORKFLOW.md](ANIMATION-AUTONOMOUS-WORKFLOW.md). El agente debe conducir el ciclo completo durante la sesión activa (ordenar, esperar, verificar, inspeccionar, corregir y continuar), sin mantenerse activo 24/7 y sin enviar informes de progreso. El usuario recibe el informe final, salvo que exista un bloqueo real que requiera su intervención.

## Qué representa cada parte

- **B**: agente/cliente que razona sobre la tarea y decide cuál debe ser el siguiente paso.
- **A**: sesión persistente de CodeLab. Es la fuente de verdad y el ejecutor que mantiene la misma sesión de navegador/estado.
- **contexto**: estado real devuelto por A después de consultar CodeLab. Puede incluir datos estructurados del proyecto, frame, layer, cel/raster, selección, historial y evidencia visual cuando corresponda.

## Ciclo obligatorio

### 1. B solicita una operación a A

B no modifica ni inventa el estado de CodeLab. Envía una orden estructurada y concreta.

Ejemplos:

- crear un proyecto de dibujo;
- crear una capa;
- crear un frame;
- consultar el frame anterior;
- consultar una capa concreta;
- modificar un cel;
- capturar evidencia.

### 2. A ejecuta sobre el CodeLab persistente

A utiliza la sesión real de CodeLab y ejecuta la operación.

La sesión A debe conservar el mismo contexto de trabajo siempre que sea posible: proyecto, página, navegador, editor, frames y layers.

### 3. A devuelve contexto real

Después de cada operación relevante, B recibe el estado que realmente existe en CodeLab.

Para dibujo/animación, el contexto debe contener como mínimo los identificadores y datos necesarios para continuar de forma determinista. Cuando se necesite modificar una imagen existente, debe poder recuperarse el estado visual/raster real del origen.

**No se debe reconstruir el estado anterior por memoria.**

### 4. B analiza únicamente ese contexto

B decide el siguiente paso usando el contexto devuelto por A.

Si falta información necesaria, B debe pedirla a A antes de modificar nada.

### 5. B vuelve a enviar la siguiente operación a A

La nueva operación debe estar basada en el estado recién consultado.

Después vuelve a empezar el ciclo:

**B → A → contexto → B → A → contexto...**

## Regla crítica para dibujo y animación

Cuando se crea o modifica un frame, cel o layer que depende de otro:

1. B pide a A el frame/layer/cel de referencia real.
2. A consulta CodeLab.
3. A devuelve el contexto real, incluido el raster cuando sea necesario.
4. B calcula la transformación o el siguiente cambio.
5. B pide a A que aplique ese cambio.
6. A ejecuta y devuelve el nuevo contexto.
7. El siguiente paso utiliza ese nuevo contexto real.

Por ejemplo, para una animación:

**Frame 1 real → consultar Frame 1 → B calcula Frame 2 → A crea Frame 2 → consultar Frame 2 → B calcula Frame 3 → A crea Frame 3 → ...**

No se permite:

**Frame 1 → B recuerda/infiere Frame 1 → B genera Frame 2 → B supone cómo quedó Frame 2 → genera Frame 3.**

La segunda forma rompe la trazabilidad y puede producir frames incorrectos.

## A es la fuente de verdad

El estado de CodeLab tiene prioridad sobre cualquier estado supuesto por B.

Si B cree que una capa, frame, cel o selección tiene un determinado estado pero A devuelve otro, se utiliza el estado de A.

Esto evita:

- desincronización;
- modificaciones sobre frames equivocados;
- pérdida de capas;
- animaciones que dejan de ser progresivas;
- comandos aplicados sobre objetos inexistentes;
- decisiones basadas en información vieja.

## No encadenar comandos ciegamente

No se debe enviar una larga secuencia de modificaciones asumiendo que todas terminarán correctamente.

En operaciones sensibles, el patrón debe ser:

**acción → contexto → decisión → acción → contexto**

Se pueden agrupar operaciones únicamente cuando no dependan del resultado intermedio. Si una operación depende del estado producido por otra, debe existir una consulta de contexto entre ambas.

## Separación entre razonamiento y ejecución

B decide **qué** debe hacerse.

A decide/garantiza **qué existe realmente en CodeLab y qué se ejecutó**.

B no debe tratar una intención de cambio como si ya fuera un cambio confirmado.

Una operación se considera realizada únicamente cuando A la ejecuta correctamente y devuelve un resultado/contexto compatible.

## Evidencia visual

Cuando la calidad visual sea parte del objetivo, el contexto no debe limitarse a metadatos.

A debe poder devolver evidencia visual real de CodeLab cuando sea necesario para evaluar:

- composición;
- detalle;
- continuidad entre frames;
- posiciones;
- capas;
- resultado del render;
- interacción de la interfaz.

B debe analizar esa evidencia y, si el resultado no cumple el objetivo, iniciar otro ciclo **B → A → contexto** para corregirlo.

No basta con comprobar que los datos sean válidos: el resultado también debe ser visualmente correcto.

## Persistencia de la sesión A

La sesión A debe permanecer viva mientras B realiza la cadena de trabajo.

Esto permite que el ciclo conserve:

- el mismo proyecto;
- el mismo editor;
- el mismo navegador;
- el mismo estado de CodeLab;
- el contexto generado en pasos anteriores.

B puede terminar después de una petición, pero A conserva la sesión para la siguiente.

## Resultado esperado

El agente debe trabajar como un sistema de control con feedback:

**B decide → A ejecuta → A devuelve estado real → B analiza → B decide → A ejecuta → ...**

Para dibujo y animación, este ciclo es obligatorio.

**Nunca avanzar por suposición cuando CodeLab puede proporcionar el estado real.**
