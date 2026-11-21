# Protocolo de expiración de sesión del agente

## Objetivo

La expiración o desconexión de la sesión del agente IA **no debe perder ni duplicar el trabajo**. El estado persistente en Neon es la fuente de verdad para recuperar la ejecución.

## Qué debe ocurrir al expirar la sesión

1. **No crear una tarea nueva automáticamente.**
   - La sesión del agente puede haber terminado, pero el trabajo de CodeLab puede seguir en ejecución.
   - Primero se debe recuperar el estado persistido.

2. **Consultar el estado del bridge en Neon.**
   - Consultar `GET /api/agent/bridge/state`.
   - Revisar `state`, `wake_required`, `wake_reason`, `signal_version`, último comando, resultado, revisión y `evidenceEventId`.
   - Si `wake_required=true`, la siguiente orden debe incluir `wake:true` y el `signalVersion` observado.

3. **No asumir que el bridge sigue vivo.**
   - Si la señal indica `sleeping` + `wake_required=true`, usar la operación controlada de wake/ensure antes de enviar trabajo.
   - El bridge no se mantiene despierto mediante un temporizador o cron.

4. **Recuperar el proyecto desde Neon antes de continuar.**
   - Identificar el `project_id`.
   - Leer la última `server_revision`.
   - Recuperar el último estado del trabajo y sus resultados.
   - La evidencia visual sirve para auditoría/diagnóstico; **no sustituye al estado persistido del proyecto**.

5. **Comprobar si la orden anterior terminó.**
   - Estados esperados: `queued → dispatched → running → rendering → uploading → completed/failed`.
   - Si está `completed`, inspeccionar el resultado y, cuando corresponda, la evidencia visual antes de iniciar otra modificación.
   - Si está `failed`, recuperar el error y continuar desde la última revisión válida.
   - Si sigue activa, **no duplicar la orden**: esperar/consultar su estado hasta resolverla.

6. **Si había una propuesta pendiente.**
   - Comprobar que la propuesta siga vigente y que su token no haya expirado.
   - Si continúa vigente, completar la aprobación correspondiente.
   - Si expiró o quedó obsoleta, **no reutilizar el token**: crear una nueva propuesta contra la revisión persistida actual.

7. **Si había una captura de vídeo en curso.**
   - Comprobar el estado de la evidencia mediante su `evidenceEventId`.
   - Si el vídeo está completo, recuperarlo e inspeccionarlo realmente.
   - Si la captura quedó incompleta, no darla por válida; repetir la captura desde el estado persistido.

8. **Reanudar solo desde la última revisión válida.**
   - Toda nueva acción debe indicar `project_id` + `server_revision`.
   - No reconstruir el proyecto desde memoria, screenshots o vídeos.
   - No crear una copia paralela del proyecto solo porque la sesión expiró.

9. **Evitar duplicados y carreras.**
   - Antes de crear una orden de continuación, consultar las órdenes recientes del mismo trabajo/proyecto.
   - Si existe una orden equivalente en `queued`, `dispatched`, `running`, `rendering` o `uploading`, reutilizar su estado en lugar de crear otra.

10. **Después de recuperar la sesión.**
    - Verificar que el bridge esté disponible.
    - Continuar el ciclo normal:
      `Neon → CodeLab → resultado/evidencia → Neon → agente`.
    - En dibujo/animación: inspeccionar la evidencia visual antes de declarar terminado.
    - Registrar cualquier nueva revisión, resultado y evidencia con los mismos identificadores de trabajo/proyecto.

## Regla resumida

```text
Sesión expira
    ↓
Consultar Neon / bridge state
    ↓
¿wake_required?
    ├─ sí → wake:true + signalVersion
    └─ no → continuar
    ↓
Consultar job + project_id + server_revision
    ↓
¿job sigue activo?
    ├─ sí → NO duplicar; seguir consultando
    ├─ completed → inspeccionar resultado/evidencia
    └─ failed → recuperar error y corregir desde última revisión
    ↓
¿propuesta pendiente?
    ├─ vigente → aprobar
    └─ expirada/obsoleta → nueva propuesta
    ↓
Continuar siguiente ciclo
```

## Prohibiciones

- No matar un proceso solo porque la sesión del agente expiró.
- No duplicar trabajos por falta de conexión.
- No inventar el estado del proyecto.
- No usar el vídeo como fuente canónica del proyecto.
- No reutilizar tokens de propuesta expirados.
- No iniciar una nueva ejecución del agente de forma automática: **solo el usuario puede iniciar una nueva ejecución del agente IA**.
