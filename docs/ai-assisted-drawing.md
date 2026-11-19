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


## Dynamic visual references

The illustration workflow does **not** depend on a bundled reference image. A scene may contain external references selected at runtime.

- references[].url: source image/page URL.
- references[].role: anatomy, pose, clothing, lighting, composition, style, prop, or general.
- references[].notes: what the assistant is extracting from that reference.

The assistant can search the web while planning and revising the illustration, then attach only the relevant references to the current scene. References are evidence, not the artwork itself: the drawing remains an editable PixelForge project.

Workflow:

user intent -> web/reference search -> visual inspection -> semantic scene -> editable strokes/layers -> visual review -> correction -> final

For animation, references can be refreshed between frames when the requested subject changes, while the actual previous CodeLab frame remains the source of truth for continuity.

No fixed/bundled image is required.
