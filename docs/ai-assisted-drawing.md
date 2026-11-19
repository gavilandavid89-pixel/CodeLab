# Flujo de dibujo asistido por IA

Este módulo implementa las ideas útiles del enfoque propuesto: **trazos estructurados, feedback visual, trabajo por etapas, capas editables y pausa/corrección/reanudación**.

## Etapas

1. sketch
2. lineart
3. flats
4. lighting-shadows
5. details
6. review

Cada acción real de dibujo sigue siendo una operación estructurada como `canvas.draw_stroke`, y el feedback visual se conserva como checkpoint mediante `DrawingWorkflow.attachVisualFeedback`.

La persistencia del documento/capas sigue siendo responsabilidad del proyecto PixelForge. Este workflow conserva el estado del proceso y su historial auditable.

## Principio

La IA no necesita mover un cursor para pintar cada píxel. Puede producir acciones estructuradas y consultar snapshots visuales para decidir la siguiente corrección. La interacción GUI queda reservada para cuando sea realmente necesario operar la interfaz real.
