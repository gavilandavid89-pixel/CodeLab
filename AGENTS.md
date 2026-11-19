# 🚨🚨 POLÍTICA N.º 1 — SUPERVISIÓN A/B 🚨🚨

**MÁXIMA PRIORIDAD:** los **10 minutos NO son un límite de ejecución para A ni para B**. Son únicamente la ventana máxima de **supervisión del agente IA** por ciclo, comprobando cada **30 segundos**. A y B pueden seguir ejecutándose más allá de esa ventana; el agente IA decide el siguiente ciclo sin matar, cancelar ni imponer un timeout al proceso solo por llegar a 10 minutos. Si responden antes, detener la espera inmediatamente, inspeccionar el resultado y decidir el siguiente paso. Cada nuevo B reinicia su ciclo independiente de supervisión de 10 min / 30 s.

**Esta regla está por encima de las demás reglas operativas.**

> **Esta es una política operativa obligatoria.** El agente IA debe consultarla **antes de comenzar cualquier trabajo sobre CodeLab**. No debe tratarse como documentación opcional.

**Entrada obligatoria del agente:** [docs/agent-ai-bridge-policy.md](docs/agent-ai-bridge-policy.md)

**Protocolo adicional obligatorio para dibujo y animación:** [docs/ANIMATION-AUTONOMOUS-WORKFLOW.md](docs/ANIMATION-AUTONOMOUS-WORKFLOW.md). Define que el agente conduce el ciclo completo de órdenes, espera, verificación, inspección y corrección durante la sesión activa; no funciona 24/7 ni envía informes intermedios, y comunica el resultado final. Este protocolo complementa —no reemplaza— la supervisión A/B descrita arriba.

**Reglas críticas de un vistazo**
- **Usuario → Agente IA → B → A → B → Agente IA.**
- **Solo el usuario puede iniciar una nueva ejecución del agente IA.**
- **B es un puente; no es otro agente IA ni toma decisiones.**
- **A es la sesión persistente y la fuente de verdad del estado real de CodeLab.**
- Cada B tiene una **ventana máxima de supervisión del agente IA** de **10 minutos**, con comprobación cada **30 segundos**; A se supervisa con la misma regla. **Esto no limita la duración de ejecución de A/B.**
- La evidencia estructurada y visual debe verificarse realmente antes de aceptar un resultado.
- Un "success", workflow verde o API aceptada **no equivale** a tarea terminada.
- En dibujo/animación se debe seguir: **objetivo → referencia/contexto real → acción estructurada → render → inspección visual → evaluación → corrección**.
- Cuando se use una referencia externa, **la referencia es evidencia, no el artwork final**.
- En animación, el frame anterior debe consultarse desde el estado real de CodeLab/A; **no se puede inventar ni reconstruir de memoria**.
- **No registrar secretos, cookies, tokens ni contraseñas.**

## Referencias visuales dinámicas

El agente puede buscar referencias visuales actuales en Internet durante una tarea cuando sean útiles para comprender anatomía, pose, ropa, iluminación, composición, objetos, movimiento o estilo.

Las referencias externas deben:
1. registrarse en el contexto estructurado de la escena con su URL, función y notas;
2. utilizarse como evidencia para razonar y construir el dibujo;
3. mantenerse separadas del resultado editable de CodeLab;
4. poder sustituirse o actualizarse sin convertir una imagen concreta en una dependencia fija del sistema.

**No se debe depender de una imagen implantada/bundled como fuente obligatoria del dibujo.** El sistema debe poder crear una escena desde la intención del usuario y referencias obtenidas durante la tarea.

Para animación, las referencias externas pueden orientar la pose y el movimiento, pero **el estado real del frame anterior en CodeLab/A sigue siendo la fuente de verdad para la continuidad entre frames**.

## Documento completo

La política detallada y sus controles se encuentran en:

**[docs/agent-ai-bridge-policy.md](docs/agent-ai-bridge-policy.md)**
